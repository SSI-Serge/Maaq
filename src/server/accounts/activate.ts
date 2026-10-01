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
  | { kind: "used"; linkKind: ActivationKindName; host: string | null }
  | { kind: "expired"; linkKind: ActivationKindName; host: string | null }
  | { kind: "invalid" };

type ActivationKindName = "account_activation" | "guest_invitation";

async function readLink(db: Db, token: string, now: Date, lock: boolean): Promise<LinkState> {
  let query = db
    .selectFrom("activation_links as l")
    .innerJoin("users as u", "u.id", "l.user_id")
    .leftJoin("users as h", (join) => join.onRef("h.account_id", "=", "u.account_id").on("h.role", "=", "primary_user"))
    .select([
      "l.id",
      "l.kind",
      "l.expires_at",
      "l.used_at",
      "l.revoked_at",
      "u.id as user_id",
      "u.first_name",
      "u.role",
      "u.account_id",
      "u.status",
      "h.first_name as host_first_name",
    ])
    .where("l.token_hash", "=", sha256(token));
  if (lock) query = query.forUpdate("l");
  const row = await query.executeTakeFirst();
  if (!row) return { kind: "invalid" };
  const host = row.kind === "guest_invitation" ? row.host_first_name : null;
  // Lien déjà utilisé : « Votre accès est déjà activé » (US-4 RF7).
  if (row.used_at) return { kind: "used", linkKind: row.kind, host };
  // Lien remplacé par un renvoi, invité supprimé ou délai dépassé : même message qu'un lien expiré (US-4 RF6, RF8).
  if (row.revoked_at || row.status !== "pending_activation" || new Date(row.expires_at) <= now) {
    return { kind: "expired", linkKind: row.kind, host };
  }
  return { kind: "valid", linkId: row.id, userId: row.user_id, firstName: row.first_name, role: row.role, accountId: row.account_id };
}

export type ActivationInfo =
  | {
      kind: "valid";
      role: "primary_user" | "guest";
      firstName: string;
      profile: { firstName: string; lastName: string; email: string; phone: string | null };
      host: { firstName: string; lastName: string } | null;
      legal: LegalVersion[];
    }
  | { kind: "used" | "expired"; linkKind: ActivationKindName; host: string | null }
  | { kind: "invalid" };

export async function inspectActivation(ctx: Ctx, token: string): Promise<ActivationInfo> {
  const link = await readLink(ctx.db, token, ctx.now, false);
  if (link.kind !== "valid") return link;
  const profile = await ctx.db
    .selectFrom("users")
    .select(["first_name", "last_name", "email", "phone"])
    .where("id", "=", link.userId)
    .executeTakeFirstOrThrow();
  const host =
    link.role === "guest" && link.accountId
      ? await ctx.db
          .selectFrom("users")
          .select(["first_name", "last_name"])
          .where("account_id", "=", link.accountId)
          .where("role", "=", "primary_user")
          .executeTakeFirst()
      : undefined;
  return {
    kind: "valid",
    role: link.role === "guest" ? "guest" : "primary_user",
    firstName: link.firstName,
    profile: { firstName: profile.first_name, lastName: profile.last_name, email: profile.email, phone: profile.phone },
    host: host ? { firstName: host.first_name, lastName: host.last_name } : null,
    legal: await currentLegalVersions(ctx.db, ctx.now),
  };
}

export type ActivationResult =
  | { kind: "invalid" | "weak" | "mismatch" | "not_accepted" }
  | { kind: "used" | "expired"; linkKind: ActivationKindName; host: string | null }
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
    if (link.kind === "invalid") return { kind: "invalid" };
    if (link.kind !== "valid") return { kind: link.kind, linkKind: link.linkKind, host: link.host };

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
