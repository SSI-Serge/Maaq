import { randomBytes } from "node:crypto";
import type { Kysely } from "kysely";
import { STATUS_CODE, TYPE_CODE, type EventStatus, type EventType } from "@/server/assistant/calendar";
import { addChild, listFamilyMembers } from "@/server/assistant/family";
import { seal } from "@/server/assistant/fields";
import type { Ctx } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { createGuest, createProfile, sessionFor } from "./fixtures";

/**
 * Foyer des essais « Émotions » : Sophie (utilisateur principal), Marc (invité 1, avec Sophie le couple), Élodie (invitée secondaire), Léo et Mia (enfants).
 * Les dates vont avec l'horloge réelle : la base juge « passé » avec son propre `now()`.
 */
export async function coupleFamily(db: Kysely<DB>) {
  const at = (now = new Date()): Ctx => ({ db, now });
  const primary = await createProfile(db);
  await db.updateTable("users").set({ first_name: "Sophie" }).where("id", "=", primary.id).execute();
  const marc = await createGuest(db, primary.accountId!, "Marc", "core");
  const elodie = await createGuest(db, primary.accountId!, "Élodie");
  const sophie = await sessionFor(db, primary.id);
  const leo = await addChild(at(), sophie, { firstName: "Léo", birth: "2016-06" });
  const mia = await addChild(at(), sophie, { firstName: "Mia", birth: "2019-02" });
  const members = await listFamilyMembers(at(), sophie);
  const memberOf = async (userId: string) => (await db.selectFrom("family_members").select("id").where("user_id", "=", userId).executeTakeFirstOrThrow()).id;
  return {
    accountId: primary.accountId!,
    sophie,
    marc: await sessionFor(db, marc.id),
    elodie: await sessionFor(db, elodie.id),
    userIds: { sophie: primary.id, marc: marc.id, elodie: elodie.id },
    ids: { sophie: members.find((m) => m.firstName === "Sophie")!.id, marc: await memberOf(marc.id), elodie: await memberOf(elodie.id), leo: leo.id, mia: mia.id },
  };
}
export type CoupleFamily = Awaited<ReturnType<typeof coupleFamily>>;

/** Un RDV inséré directement : `by` est le profil qui l'a demandé, `endsInHours` négatif pour un RDV déjà terminé. */
export async function seedEvent(
  db: Kysely<DB>,
  f: CoupleFamily,
  s: { by?: string | null; status?: EventStatus; type?: EventType; members?: string[]; startsInHours?: number; endsInHours?: number; allFamily?: boolean; title?: string; start?: Date; end?: Date } = {},
): Promise<string> {
  const status = STATUS_CODE[s.status ?? "confirmed"];
  const type = await db.selectFrom("event_types").select("id").where("code", "=", TYPE_CODE[s.type ?? "family"]).executeTakeFirstOrThrow();
  const start = s.start ?? new Date(Date.now() + (s.startsInHours ?? -3) * 3_600_000);
  const end = s.end ?? new Date(Date.now() + (s.endsInHours ?? -2) * 3_600_000);
  const by = s.by === undefined ? f.userIds.sophie : s.by;
  const row = await db
    .insertInto("family_events")
    .values({
      account_id: f.accountId, event_type_id: type.id, title: seal(s.title ?? "Dentiste de Léo"), starts_at: start, ends_at: end, status, source: "chat_text", whole_family: s.allFamily ?? false,
      requested_by_user_id: by, fingerprint: randomBytes(16), ...(status === "confirmed" || status === "cancelled" ? { confirmed_at: start, confirmed_by_user_id: by } : {}),
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (!s.allFamily) await db.insertInto("family_event_members").values((s.members ?? [f.ids.leo]).map((m) => ({ event_id: row.id, member_id: m, account_id: f.accountId }))).execute();
  return row.id;
}
