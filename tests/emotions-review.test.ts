import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTask, setTaskDone } from "@/server/assistant/tasks";
import type { Ctx } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { prepareExport, readExport, requestExport } from "@/server/compliance/exports";
import { readZip } from "@/server/compliance/zip";
import { setHeart } from "@/server/emotions/hearts";
import { removeGuest } from "@/server/guests/service";
import { addWish } from "@/server/emotions/wishes";
import { addNote, listMyNotes, removeNote, updateNote } from "@/server/emotions/notes";
import { currentReview, ensureReview, openReview, REVIEW_MAX_ITEMS, reviewWeekOf } from "@/server/emotions/reviews";
import { Rejection } from "@/server/http";
import { coupleFamily, seedEvent, type CoupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";

let db: Kysely<DB>;
beforeAll(() => {
  db = testDb();
});
afterAll(async () => {
  await db.destroy();
});
const at = (): Ctx => ({ db, now: new Date() });

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

/** Jour civil à Paris (la semaine du bilan se compte à l'heure de Paris, pas en UTC : juste après minuit le lundi, les deux jours ne sont pas les mêmes). */
const parisDay = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

/** Lundi de la semaine en cours, à l'heure de Paris. */
function thisMonday(): string {
  const day = parisDay(new Date());
  const d = new Date(`${day}T12:00:00Z`);
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
}
const today = () => parisDay(new Date());

async function reviews(f: CoupleFamily) {
  const week = thisMonday();
  await ensureReview(db, f.accountId, f.userIds.sophie, week, new Date());
  await ensureReview(db, f.accountId, f.userIds.marc, week, new Date());
  return week;
}

describe("création du bilan (US-142, E-17)", () => {
  it("la semaine du bilan précède d'une semaine celle du point", () => {
    expect(reviewWeekOf("2054-11-09")).toBe("2054-11-02");
  });

  it("seuls les deux parents du couple ont un bilan ; une seule fois par semaine", async () => {
    const f = await coupleFamily(db);
    const week = thisMonday();
    expect(await ensureReview(db, f.accountId, f.userIds.sophie, week, new Date())).toBe(true);
    expect(await ensureReview(db, f.accountId, f.userIds.sophie, week, new Date())).toBe(false);
    expect(await ensureReview(db, f.accountId, f.userIds.elodie, week, new Date())).toBe(false);
    expect(await currentReview(at(), f.elodie)).toBeNull();
    expect(await currentReview(at(), f.sophie)).toMatchObject({ weekStart: week, opened: false });
  });
});

describe("mot libre (US-143)", () => {
  it("un mot s'écrit à l'autre parent, jusqu'à 500 caractères ; l'auteur seul le relit (CA 1.1, RF1)", async () => {
    const f = await coupleFamily(db);
    const note = await addNote(at(), f.sophie, "  Merci d'avoir géré la réunion de jeudi  ");
    expect(note).toMatchObject({ text: "Merci d'avoir géré la réunion de jeudi", frozen: false });
    expect((await listMyNotes(at(), f.sophie)).notes.map((n) => n.text)).toEqual(["Merci d'avoir géré la réunion de jeudi"]);
    // Marc ne voit rien, ni mot ni indication qu'il en manque (CA 3.1).
    expect((await listMyNotes(at(), f.marc)).notes).toEqual([]);
    expect((await failure(addNote(at(), f.sophie, "x".repeat(501)))).code).toBe("invalid_note");
    expect((await failure(addNote(at(), f.sophie, "   "))).code).toBe("invalid_note");
    await addNote(at(), f.sophie, "é".repeat(500));
  });

  it("le texte est chiffré en base", async () => {
    const f = await coupleFamily(db);
    await addNote(at(), f.sophie, "Un mot très privé");
    const row = await db.selectFrom("partner_notes").select("body").where("author_user_id", "=", f.userIds.sophie).executeTakeFirstOrThrow();
    expect(row.body.toString("utf8")).not.toContain("privé");
  });

  it("réservé au couple : un invité secondaire ne peut pas écrire (RF7)", async () => {
    const f = await coupleFamily(db);
    expect((await failure(addNote(at(), f.elodie, "Bonjour"))).code).toBe("forbidden");
    expect((await failure(listMyNotes(at(), f.elodie))).code).toBe("forbidden");
  });

  it("modifiable et retirable jusqu'à l'ouverture du bilan, figé ensuite (CA 4.1, 4.2)", async () => {
    const f = await coupleFamily(db);
    await reviews(f);
    const first = await addNote(at(), f.sophie, "Premier mot");
    const second = await addNote(at(), f.sophie, "Second mot");
    expect((await updateNote(at(), f.sophie, first.id, "Premier mot corrigé")).text).toBe("Premier mot corrigé");
    await removeNote(at(), f.sophie, second.id);
    expect((await listMyNotes(at(), f.sophie)).notes.map((n) => n.text)).toEqual(["Premier mot corrigé"]);
    await openReview(at(), f.marc);
    expect((await listMyNotes(at(), f.sophie)).notes[0].frozen).toBe(true);
    expect((await failure(updateNote(at(), f.sophie, first.id, "Trop tard"))).code).toBe("note_frozen");
    expect((await failure(removeNote(at(), f.sophie, first.id))).code).toBe("note_frozen");
  });
});

describe("bilan de la semaine (US-144)", () => {
  it("le mot du partenaire n'apparaît qu'à l'ouverture, une seule fois rattaché, y compris s'il a été écrit après l'envoi (CA 1.1, RF8)", async () => {
    const f = await coupleFamily(db);
    await addNote(at(), f.sophie, "Avant l'envoi");
    await reviews(f);
    await addNote(at(), f.sophie, "Après l'envoi mais avant l'ouverture");
    const before = await currentReview(at(), f.marc);
    expect(before?.opened).toBe(false);
    const opened = await openReview(at(), f.marc);
    expect(opened.opened).toBe(true);
    expect(opened.notes.map((n) => n.text)).toEqual(["Avant l'envoi", "Après l'envoi mais avant l'ouverture"]);
    // Un mot écrit après l'ouverture attend le bilan suivant.
    await addNote(at(), f.sophie, "Pour la semaine suivante");
    const again = await openReview(at(), f.marc);
    expect(again.notes.map((n) => n.text)).toEqual(["Avant l'envoi", "Après l'envoi mais avant l'ouverture"]);
    // Sophie n'est pas concernée par ses propres mots.
    expect((await openReview(at(), f.sophie)).notes).toEqual([]);
  });

  it("cœurs reçus et ce que la famille a fait, sans nom ni chiffre (CA 1.1, 2.1)", async () => {
    const f = await coupleFamily(db);
    await reviews(f);
    const done = await createTask(at(), f.sophie, { title: "Courses du goûter", due: today() });
    await setTaskDone(at(), f.marc, done.id, true);
    const own = await createTask(at(), f.sophie, { title: "Inscription cantine", due: today() });
    await setTaskDone(at(), f.sophie, own.id, true);
    // le RDV vient de se terminer : par défaut il date de deux heures, donc de la semaine précédente pendant les deux premières heures du lundi
    const event = await seedEvent(db, f, { by: f.userIds.marc, title: "Dentiste de Léo", startsInHours: -0.002, endsInHours: -0.001 });
    await setHeart(at(), f.sophie, { kind: "task", id: done.id }, true);
    await setHeart(at(), f.sophie, { kind: "event", id: event }, true);

    // Marc a fait la tâche et créé le RDV : il est remercié pour les deux.
    const marc = await openReview(at(), f.marc);
    expect(marc.partner).toBe("Sophie");
    expect(marc.thanks.map((t) => t.title).sort()).toEqual(["Courses du goûter", "Dentiste de Léo"]);
    expect(marc.together.map((t) => t.title).sort()).toEqual(["Courses du goûter", "Dentiste de Léo", "Inscription cantine"]);
    expect(marc.quiet).toBe(false);
    // Aucun nombre, aucun nom de celui qui a fait : la vue ne porte que des titres (RF2).
    expect(Object.keys(marc).sort()).toEqual(["id", "notes", "opened", "partner", "quiet", "thanks", "together", "togetherMore", "weekEnd", "weekStart"]);
    for (const item of [...marc.thanks, ...marc.together]) expect(Object.keys(item).sort()).toEqual(["id", "kind", "title"]);
    // Sophie n'a reçu aucun cœur.
    expect((await openReview(at(), f.sophie)).thanks).toEqual([]);
  });

  it("une semaine sans rien est une semaine tranquille (RF3)", async () => {
    const f = await coupleFamily(db);
    await reviews(f);
    const view = await openReview(at(), f.sophie);
    expect(view).toMatchObject({ quiet: true, thanks: [], together: [], notes: [], togetherMore: false });
  });

  it("au-delà de 10 éléments, la liste s'arrête (« … et tout le reste », RF2)", async () => {
    const f = await coupleFamily(db);
    await reviews(f);
    for (let i = 0; i < REVIEW_MAX_ITEMS + 2; i++) {
      const t = await createTask(at(), f.sophie, { title: `Tâche ${i}`, due: today() });
      await setTaskDone(at(), f.marc, t.id, true);
    }
    const view = await openReview(at(), f.sophie);
    expect(view.together).toHaveLength(REVIEW_MAX_ITEMS);
    expect(view.togetherMore).toBe(true);
  });

  it("pas de bilan avant le premier envoi, ni pour un invité secondaire", async () => {
    const f = await coupleFamily(db);
    expect((await failure(openReview(at(), f.sophie))).code).toBe("no_review");
    expect((await failure(openReview(at(), f.elodie))).code).toBe("forbidden");
  });

  it("aucun historique : chaque bilan, ouvert ou non, est supprimé 4 semaines après sa préparation, avec ses mots ; un mot jamais lu 4 semaines après son écriture (E-22)", async () => {
    const f = await coupleFamily(db);
    const old = "2020-01-06";
    await ensureReview(db, f.accountId, f.userIds.marc, old, new Date(Date.now() - 40 * 86_400_000));
    const attached = await addNote(at(), f.sophie, "Lu autrefois");
    await openReview(at(), f.marc, (await db.selectFrom("weekly_reviews").select("id").where("user_id", "=", f.userIds.marc).executeTakeFirstOrThrow()).id);
    const lonely = await addNote(at(), f.sophie, "Jamais lu");
    await db.updateTable("partner_notes").set({ created_at: new Date(Date.now() - 40 * 86_400_000) }).where("id", "=", lonely.id).execute();
    await sql`select purge_expired_emotion_data()`.execute(db);
    const left = await db.selectFrom("partner_notes").select("id").where("account_id", "=", f.accountId).execute();
    expect(left).toEqual([]);
    expect(await db.selectFrom("weekly_reviews").select("id").where("account_id", "=", f.accountId).execute()).toEqual([]);
    void attached;
  });

  it("un bilan jamais ouvert est supprimé lui aussi, un bilan récent reste (E-22)", async () => {
    const f = await coupleFamily(db);
    const week = thisMonday();
    // Préparé il y a 29 jours, jamais ouvert : supprimé ; préparé il y a 27 jours : conservé, même si sa semaine de départ est plus ancienne.
    await ensureReview(db, f.accountId, f.userIds.sophie, "2020-01-06", new Date(Date.now() - 29 * 86_400_000));
    await ensureReview(db, f.accountId, f.userIds.sophie, "2020-01-13", new Date(Date.now() - 27 * 86_400_000));
    await ensureReview(db, f.accountId, f.userIds.marc, week, new Date());
    await sql`select purge_expired_emotion_data()`.execute(db);
    const left = await db.selectFrom("weekly_reviews").select([sql<string>`week_start::text`.as("week")]).where("account_id", "=", f.accountId).orderBy("week_start").execute();
    expect(left.map((r) => r.week)).toEqual(["2020-01-13", week]);
  });
});

describe("le couple se défait (E-20, E-21)", () => {
  it("le retrait de l'invité 1 supprime cœurs, bilans, mots et envies de la famille", async () => {
    const f = await coupleFamily(db);
    await reviews(f);
    await addNote(at(), f.sophie, "Un mot");
    const t = await createTask(at(), f.sophie, { title: "Courses", due: today() });
    await setTaskDone(at(), f.marc, t.id, true);
    await setHeart(at(), f.sophie, { kind: "task", id: t.id }, true);
    await db.insertInto("couple_wishes").values({ account_id: f.accountId, title: Buffer.from("x"), created_by_user_id: f.userIds.sophie }).execute();
    await db.updateTable("users").set({ status: "removed", removed_at: new Date(), purge_scheduled_at: new Date(Date.now() + 30 * 86_400_000) }).where("id", "=", f.userIds.marc).execute();
    for (const table of ["appreciation_hearts", "weekly_reviews", "partner_notes", "couple_wishes"] as const) {
      expect(await db.selectFrom(table).select("account_id").where("account_id", "=", f.accountId).execute(), table).toEqual([]);
    }
    // Sans invité 1 actif : plus de bilan, plus de mot.
    expect((await failure(addNote(at(), f.sophie, "Seul"))).code).toBe("forbidden");
  });
});

describe("retrait de l'invité 1 par l'utilisateur principal (E-20)", () => {
  it("supprime tout ce que le couple partageait, et un nouvel invité 1 repart d'une carte vide", async () => {
    const f = await coupleFamily(db);
    await reviews(f);
    await addNote(at(), f.sophie, "Un mot");
    await addWish({ db, now: new Date(`${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T10:30:00Z`) }, f.sophie, { title: "Cours de salsa" });
    await removeGuest(at(), f.sophie, f.userIds.marc);
    for (const table of ["appreciation_hearts", "weekly_reviews", "partner_notes", "couple_wishes"] as const) {
      expect(await db.selectFrom(table).select("account_id").where("account_id", "=", f.accountId).execute(), table).toEqual([]);
    }
  });
});

describe("export des données (E-23, US-143 RT3)", () => {
  it("l'auteur exporte les mots qu'il a écrits, le destinataire ceux qu'il a reçus et ouverts, les deux les envies et leurs cœurs", async () => {
    const f = await coupleFamily(db);
    await reviews(f);
    await addNote(at(), f.sophie, "Merci pour la semaine");
    await addNote(at(), f.sophie, "Un second mot, pas encore lu");
    const task = await createTask(at(), f.sophie, { title: "Courses", due: today() });
    await setTaskDone(at(), f.marc, task.id, true);
    await setHeart(at(), f.sophie, { kind: "task", id: task.id }, true);
    await addWish({ db, now: new Date(`${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T10:30:00Z`) }, f.marc, { title: "Cours de salsa" });

    const exported = async (session: CoupleFamily["sophie"]) => {
      const { id } = await requestExport(at(), session);
      expect(await prepareExport(at(), id)).toBe("ready");
      return JSON.parse(readZip(await readExport(at(), session, id)).find((file) => file.name === "mes-donnees.json")!.data.toString());
    };
    // Marc n'a pas encore ouvert son bilan : il ne reçoit rien dans son export (il ne sait même pas qu'un mot l'attend).
    let marc = await exported(f.marc);
    expect(marc.emotionNotesReceived).toEqual([]);
    await openReview(at(), f.marc);
    marc = await exported(f.marc);
    expect(marc.emotionNotesReceived.map((n: { mot: string }) => n.mot)).toEqual(["Merci pour la semaine", "Un second mot, pas encore lu"]);
    expect(marc.emotionNotesWritten).toEqual([]);
    expect(marc.emotionWishes.map((w: { envie: string }) => w.envie)).toEqual(["Cours de salsa"]);
    const sophie = await exported(f.sophie);
    expect(sophie.emotionNotesWritten.map((n: { mot: string }) => n.mot)).toEqual(["Merci pour la semaine", "Un second mot, pas encore lu"]);
    expect(sophie.emotionNotesWritten.every((n: { lu: boolean }) => n.lu)).toBe(true);
    expect(sophie.emotionHearts).toEqual([expect.objectContaining({ sur: "une tâche" })]);
    expect(marc.emotionHearts).toEqual([]);
    // Un invité secondaire n'a rien de tout cela.
    const elodie = await exported(f.elodie);
    expect([elodie.emotionNotesWritten, elodie.emotionNotesReceived, elodie.emotionHearts, elodie.emotionWishes]).toEqual([[], [], [], []]);
  });
});
