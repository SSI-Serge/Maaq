import type { Kysely } from "kysely";
import type { DB } from "@/server/db/schema.generated";
import { MEMBER_COLORS } from "./family";

export interface MemberChip {
  id: string;
  firstName: string;
  /** « autre » : un invité secondaire, que l'assistant ne connaît pas encore. */
  role: "parent" | "child" | "other";
  color: string;
  /** Membre retiré (US-93) : ses rendez-vous gardent son prénom, mais il n'est plus proposé. */
  removed?: boolean;
}

export const FALLBACK_COLOR = "#6b7280";
/** Prénom affiché d'un membre effacé définitivement : ses rendez-vous partagés le gardent sous ce nom (D34). */
export const FORMER_MEMBER = "Ancien membre";

/** Les membres du foyer tels que les écrans les montrent (couleur comprise), par identifiant. */
export async function loadMembers(db: Kysely<DB>, accountId: string): Promise<Map<string, MemberChip>> {
  const rows = await db.selectFrom("family_members").select(["id", "first_name", "role", "color_index", "alias_number", "archived_at", "user_id", "child_profile_user_id"]).where("account_id", "=", accountId).orderBy("role").orderBy("alias_number").execute();
  // La fiche « autre » du profil d'un enfant est masquée (D73 S-39) : elle n'est plus proposée, comme un membre retiré ; seule sa fiche enfant apparaît.
  const childProfiles = new Set(rows.map((r) => r.child_profile_user_id).filter((x): x is string => x !== null));
  return new Map(
    rows.map((r) => [
      r.id,
      { id: r.id, firstName: r.first_name ?? FORMER_MEMBER, role: r.role, color: MEMBER_COLORS[r.color_index % MEMBER_COLORS.length] ?? FALLBACK_COLOR, ...(r.archived_at || (r.user_id && childProfiles.has(r.user_id)) ? { removed: true } : {}) },
    ]),
  );
}
