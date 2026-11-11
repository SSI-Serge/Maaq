import { sql, type Kysely } from "kysely";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";

/**
 * Le membre d'un profil (D73 S-38, S-39, S-46) : règle unique, la même que `family_member_of_profile` dans la base. Un profil d'invité secondaire relié à une fiche
 * enfant (`family_members.child_profile_user_id`) a pour membre cette fiche enfant : ses RDV et ses tâches sont ceux de l'enfant, et sa propre fiche « autre » est masquée.
 * Tout autre profil a pour membre la fiche créée avec lui.
 */
export interface ProfileMember {
  memberId: string | null;
  /** Profil d'un enfant : il ne voit pas les RDV de toute la famille, ne coche pas la tâche des devoirs et n'a pas le tchat de l'Assistant Famille (S-40, S-45, S-47). */
  child: boolean;
}

export async function profileMember(db: Kysely<DB>, accountId: string, userId: string): Promise<ProfileMember> {
  const rows = await db
    .selectFrom("family_members")
    .select(["id", "child_profile_user_id"])
    .where("account_id", "=", accountId)
    .where((eb) => eb.or([eb("user_id", "=", userId), eb("child_profile_user_id", "=", userId)]))
    .execute();
  const child = rows.find((r) => r.child_profile_user_id === userId);
  return { memberId: child?.id ?? rows[0]?.id ?? null, child: Boolean(child) };
}

/** Vrai si le profil est celui d'un enfant (relié à une fiche enfant). */
export async function isChildProfile(db: Kysely<DB>, userId: string): Promise<boolean> {
  return Boolean(await db.selectFrom("family_members").select("id").where("child_profile_user_id", "=", userId).executeTakeFirst());
}

/**
 * Les tchats des agents sont fermés au profil d'un enfant (D73 S-47, élargie par le PO le 11/11/2026) : l'Assistant Famille, Courses et repas et tous les autres agents.
 * Refus côté serveur, d'après `profile_is_child_linked()` de la base ; les écrans ne montrent aucune entrée vers un tchat.
 */
export async function refuseChildChat(db: Kysely<DB>, userId: string): Promise<void> {
  const { rows } = await sql<{ child: boolean }>`select profile_is_child_linked(${userId}::uuid) as child`.execute(db);
  if (rows[0]?.child) throw new Rejection("child_no_chat", "Le tchat des agents n'est pas ouvert à ce profil.", 403);
}
