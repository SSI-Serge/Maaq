// Données de démonstration de l'Assistant Famille sur la base de développement : le foyer de Camille (Léo, Mia) et un calendrier autour
// d'aujourd'hui, avec un conflit, un rendez-vous écarté, un « toute la famille » et une journée chargée. À lancer une fois la base démarrée
// (`npm run dev`), après `npm run db:seed` : `npx tsx scripts/assistant-demo.ts`. Sans effet si le foyer a déjà des rendez-vous.
import { Pool } from "pg";
import { Kysely, PostgresDialect } from "kysely";
import { ensureParentMembers, MEMBER_COLORS } from "../src/server/assistant/family";
import { seal, sealOptional } from "../src/server/assistant/fields";
import { localToUtc } from "../src/server/assistant/local-time";
import type { DB } from "../src/server/db/schema.generated";
import { poolOptions } from "../src/server/db/pool-options";
import { loadEnv } from "./lib/load-env";

loadEnv();
const pool = new Pool(poolOptions());
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
const TZ = "Europe/Paris";

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const at = (offset: number, time: string) => `${day(offset)}T${time}`;

try {
  const camille = await db.selectFrom("users").select(["id", "account_id"]).where("email", "=", "camille@maaq.test").executeTakeFirstOrThrow();
  const accountId = camille.account_id!;
  if ((await db.selectFrom("family_events").select("id").where("account_id", "=", accountId).limit(1).execute()).length) {
    console.log("Le foyer de Camille a déjà des rendez-vous : rien à faire.");
  } else {
    await ensureParentMembers(db, accountId);
    const children: Record<string, string> = {};
    for (const [i, [name, birth]] of ([["Léo", "2018-06-20"], ["Mia", "2021-02-01"]] as const).entries()) {
      const row = await db
        .insertInto("family_members")
        .values({ account_id: accountId, first_name: name, role: "child", birth_date: birth, alias_index: i + 1, color: MEMBER_COLORS[2 + i] })
        .returning("id")
        .executeTakeFirstOrThrow();
      children[name] = row.id;
    }
    const parents = Object.fromEntries((await db.selectFrom("family_members").select(["id", "first_name"]).where("account_id", "=", accountId).where("role", "=", "parent").execute()).map((m) => [m.first_name, m.id]));
    const dominique = await db.selectFrom("users").select("id").where("email", "=", "dominique@maaq.test").executeTakeFirstOrThrow();

    type Seed = { title: string; type: string; start: string; end: string; status: string; members: string[]; allFamily?: boolean; place?: string; notes?: string; by?: string };
    const events: Seed[] = [
      { title: "RDV médical — Léo", type: "medical", start: at(1, "17:00"), end: at(1, "17:30"), status: "confirmed", members: [children["Léo"], parents["Camille"]] },
      { title: "Piano", type: "personal", start: at(1, "17:00"), end: at(1, "18:00"), status: "confirmed", members: [children["Mia"], parents["Dominique"]], place: "Conservatoire" },
      { title: "Judo", type: "personal", start: at(2, "15:00"), end: at(2, "16:30"), status: "confirmed", members: [children["Léo"]], place: "Gymnase Jean Moulin" },
      { title: "Spectacle de l'école", type: "school", start: at(2, "15:30"), end: at(2, "17:00"), status: "provisional", members: [children["Léo"]], place: "École Jules Ferry", notes: "Prévoir un goûter", by: camille.id },
      { title: "Réunion parents CE2", type: "school", start: at(3, "18:00"), end: at(3, "19:30"), status: "confirmed", members: [parents["Camille"], parents["Dominique"]], place: "École Jules Ferry" },
      { title: "RDV médical — Mia", type: "medical", start: at(4, "16:30"), end: at(4, "17:00"), status: "provisional", members: [children["Mia"]], by: dominique.id },
      { title: "Brocante du quartier", type: "family", start: at(5, "10:00"), end: at(5, "12:00"), status: "set_aside", members: [], allFamily: true },
      { title: "Repas chez Mamie", type: "family", start: at(6, "12:00"), end: at(6, "14:00"), status: "confirmed", members: [], allFamily: true, place: "Chez Mamie" },
      ...["08:30", "10:00", "12:15", "15:00", "18:30"].map((t, i): Seed => ({ title: `Journée chargée ${i + 1}`, type: "work", start: at(8, t), end: at(8, `${String(Number(t.slice(0, 2)) + 1).padStart(2, "0")}${t.slice(2)}`), status: "confirmed", members: [parents["Camille"]] })),
    ];
    for (const e of events) {
      const row = await db
        .insertInto("family_events")
        .values({
          account_id: accountId, title_encrypted: seal(e.title), event_type: e.type as never, starts_at: localToUtc(e.start, TZ), ends_at: localToUtc(e.end, TZ), all_day: false,
          place_encrypted: sealOptional(e.place), notes_encrypted: sealOptional(e.notes), status: e.status as never, source: "typed", all_family: Boolean(e.allFamily),
          created_by_user_id: e.by ?? camille.id, status_changed_at: new Date(), status_changed_by_user_id: e.status === "confirmed" ? dominique.id : e.status === "set_aside" ? camille.id : null,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      if (e.members.length) await db.insertInto("family_event_members").values(e.members.map((m) => ({ event_id: row.id, member_id: m }))).execute();
    }
    console.log(`Assistant Famille : ${events.length} rendez-vous de démonstration créés pour le foyer de Camille (Léo, Mia).`);
  }
} finally {
  await db.destroy();
}
