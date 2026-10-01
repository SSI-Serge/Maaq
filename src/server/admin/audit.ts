import type { Kysely, Transaction } from "kysely";
import type { AuditAction, DB } from "@/server/db/schema.generated";

type Db = Kysely<DB> | Transaction<DB>;

/** Journal d'administration : qui a fait quoi, sur quoi, quand (US-45 RT1, 46 RT2, 47 RT1, 48 RT1, 64 RT1, 69 RF4). */
export async function logAdminAction(
  db: Db,
  entry: {
    adminId: string;
    action: AuditAction;
    entityType: "agent" | "account" | "contract" | "contract_field";
    entityId: string;
    details?: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  await db
    .insertInto("admin_audit_log")
    .values({
      admin_user_id: entry.adminId,
      action_type: entry.action,
      entity_type: entry.entityType,
      entity_id: entry.entityId,
      details: entry.details ? JSON.stringify(entry.details) : null,
      occurred_at: entry.now,
    })
    .execute();
}

/** Prénom et nom d'un administrateur, pour l'affichage des historiques. */
export function adminName(first: string | null, last: string | null): string {
  return [first, last].filter(Boolean).join(" ") || "Administrateur supprimé";
}
