import { randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import { describeDevice } from "@/server/auth/format";
import { createSession, type Ctx } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { sha256 } from "@/server/security/crypto";
import { hashSecret, isStrongPassword } from "@/server/security/password";

type Db = Kysely<DB> | Transaction<DB>;

/**
 * Activation d'un compte depuis le lien reçu par email (US-64 RF5) : acceptation de la politique
 * de confidentialité et des conditions d'utilisation (US-54), puis choix du mot de passe.
 */

export interface LegalVersion {
  id: string;
  type: "privacy_policy" | "terms_of_use";
  label: string;
  content: string;
}

/** Version en vigueur de chaque texte : la plus récente déjà publiée. */
export async function currentLegalVersions(db: Db, now: Date): Promise<LegalVersion[]> {
  const versions: LegalVersion[] = [];
  for (const type of ["privacy_policy", "terms_of_use"] as const) {
    const row = await db
      .selectFrom("legal_document_versions")
      .select(["id", "version_label", "content"])
      .where("document_type", "=", type)
      .where("published_at", "<=", now)
      .orderBy("published_at", "desc")
      .executeTakeFirst();
    if (row) versions.push({ id: row.id, type, label: row.version_label, content: row.content });
  }
  return versions;
}

type LinkState =
  | { kind: "valid"; linkId: string; userId: string; firstName: string; role: "primary_user" | "guest" | "admin"; accountId: string | null }
  | { kind: "expired" }
  | { kind: "invalid" };

async function readLink(db: Db, token: string, now: Date, lock: boolean): Promise<LinkState> {
  let query = db
    .selectFrom("activation_links as l")
    .innerJoin("users as u", "u.id", "l.user_id")
    .select(["l.id", "l.expires_at", "l.used_at", "l.revoked_at", "u.id as user_id", "u.first_name", "u.role", "u.account_id", "u.status"])
    .where("l.token_hash", "=", sha256(token));
  if (lock) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (!row || row.used_at || row.status !== "pending_activation") return { kind: "invalid" };
  // Un lien remplacé par un renvoi est traité comme expiré : le message invite à en demander un nouveau.
  if (row.revoked_at || new Date(row.expires_at) <= now) return { kind: "expired" };
  return { kind: "valid", linkId: row.id, userId: row.user_id, firstName: row.first_name, role: row.role, accountId: row.account_id };
}

export type ActivationInfo =
  | { kind: "valid"; firstName: string; legal: LegalVersion[] }
  | { kind: "expired" }
  | { kind: "invalid" };

export async function inspectActivation(ctx: Ctx, token: string): Promise<ActivationInfo> {
  const link = await readLink(ctx.db, token, ctx.now, false);
  if (link.kind !== "valid") return link;
  return { kind: "valid", firstName: link.firstName, legal: await currentLegalVersions(ctx.db, ctx.now) };
}

export type ActivationResult =
  | { kind: "expired" | "invalid" | "weak" | "mismatch" | "not_accepted" }
  | { kind: "session"; token: string; sessionId: string; expiresAt: Date; deviceId: string };

/**
 * Active le profil : mot de passe, acceptations juridiques, appareil reconnu et session ouverte.
 * Le lien reçu par email prouve l'identité : aucun code n'est redemandé sur cet appareil.
 */
export async function activate(
  ctx: Ctx,
  input: { token: string; accepted: boolean; password: string; confirmation: string; timezone: string; userAgent: string | null },
): Promise<ActivationResult> {
  if (!input.accepted) return { kind: "not_accepted" };
  if (!isStrongPassword(input.password)) return { kind: "weak" };
  if (input.password !== input.confirmation) return { kind: "mismatch" };
  const passwordHash = await hashSecret(input.password);
  const { type, browser } = describeDevice(input.userAgent);

  return ctx.db.transaction().execute(async (trx) => {
    const link = await readLink(trx, input.token, ctx.now, true);
    if (link.kind !== "valid") return { kind: link.kind };

    await trx.updateTable("activation_links").set({ used_at: ctx.now }).where("id", "=", link.linkId).execute();
    await trx
      .updateTable("users")
      .set({ password_hash: passwordHash, status: "active", activated_at: ctx.now, updated_at: ctx.now })
      .where("id", "=", link.userId)
      .execute();
    if (link.role === "primary_user" && link.accountId) {
      await trx.updateTable("accounts").set({ status: "active", updated_at: ctx.now }).where("id", "=", link.accountId).execute();
    }

    const legal = await currentLegalVersions(trx, ctx.now);
    if (legal.length) {
      await trx
        .insertInto("legal_acceptances")
        .values(legal.map((v) => ({ user_id: link.userId, version_id: v.id, accepted_at: ctx.now })))
        .onConflict((oc) => oc.columns(["user_id", "version_id"]).doNothing())
        .execute();
    }

    const deviceId = randomUUID();
    await trx
      .insertInto("devices")
      .values({ id: deviceId, user_id: link.userId, device_type: type, browser, timezone: input.timezone, first_connected_at: ctx.now, last_activity_at: ctx.now })
      .execute();
    await trx
      .insertInto("security_events")
      .values({ user_id: link.userId, device_id: deviceId, event_type: "device_verified", occurred_at: ctx.now, details: JSON.stringify({ via: "activation_link" }) })
      .execute();

    const session = await createSession(trx, link.userId, deviceId, ctx.now);
    return { kind: "session", ...session, deviceId };
  });
}
