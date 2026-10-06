import type { Kysely, Transaction } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";

/** Politique de confidentialité et conditions d'utilisation (US-54). */

type Db = Kysely<DB> | Transaction<DB>;

export type LegalType = "privacy_policy" | "terms_of_use";
const TYPES: LegalType[] = ["privacy_policy", "terms_of_use"];

export interface LegalDocument {
  id: string;
  type: LegalType;
  label: string;
  content: string;
  publishedAt: string;
}

/** Version en vigueur de chaque document : la plus récente déjà publiée. Les versions antérieures sont conservées (RT2). */
export async function currentDocuments(db: Db, now: Date): Promise<LegalDocument[]> {
  const documents: LegalDocument[] = [];
  for (const type of TYPES) {
    const row = await db
      .selectFrom("legal_document_versions")
      .select(["id", "version_label", "content", "published_at"])
      .where("document_type", "=", type)
      .where("published_at", "<=", now)
      .orderBy("published_at", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
    if (row) documents.push({ id: row.id, type, label: row.version_label, content: row.content, publishedAt: new Date(row.published_at).toISOString() });
  }
  return documents;
}

/** Documents en vigueur que ce profil n'a pas encore acceptés (US-54 RF4). L'administrateur n'a rien à accepter. */
export async function pendingAcceptance(db: Db, userId: string, role: "primary_user" | "guest" | "admin", now: Date): Promise<LegalDocument[]> {
  if (role === "admin") return [];
  const current = await currentDocuments(db, now);
  if (current.length === 0) return [];
  const accepted = await db
    .selectFrom("legal_acceptances")
    .select("version_id")
    .where("user_id", "=", userId)
    .where("version_id", "in", current.map((d) => d.id))
    .execute();
  const done = new Set(accepted.map((a) => a.version_id));
  return current.filter((d) => !done.has(d.id));
}

/** Enregistre l'acceptation des versions en vigueur, avec le profil, la date et l'heure (RT1). */
export async function acceptCurrent(ctx: Ctx, session: SessionContext): Promise<void> {
  const pending = await pendingAcceptance(ctx.db, session.user.id, session.user.role, ctx.now);
  if (pending.length === 0) return;
  await ctx.db
    .insertInto("legal_acceptances")
    .values(pending.map((d) => ({ user_id: session.user.id, version_id: d.id, accepted_at: ctx.now })))
    .onConflict((oc) => oc.columns(["user_id", "version_id"]).doNothing())
    .execute();
}

/** Publie une nouvelle version d'un document : son acceptation sera redemandée à la connexion suivante (US-54 RF4). */
export async function publishVersion(db: Db, input: { type: LegalType; label: string; content: string; publishedAt: Date }): Promise<void> {
  await db
    .insertInto("legal_document_versions")
    .values({ document_type: input.type, version_label: input.label, content: input.content, published_at: input.publishedAt })
    .execute();
}
