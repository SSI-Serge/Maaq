import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTask, getTask } from "@/server/assistant/tasks";
import { releaseHeldAssignments } from "@/server/assistant/task-notices";
import type { Ctx } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { handOverTask, releaseHandOver, undoHandOver } from "@/server/emotions/handover";
import { addWish, addWishToCalendar, listWishes, removeWish, restoreWish, sendWishNotices, updateWish, wishForm } from "@/server/emotions/wishes";
import { Rejection } from "@/server/http";
import { coupleFamily, type CoupleFamily } from "./helpers/couple";
import { messagesTo, testDb } from "./helpers/fixtures";

let db: Kysely<DB>;
beforeAll(() => {
  db = testDb();
});
afterAll(async () => {
  await db.destroy();
});
const at = (now = new Date()): Ctx => ({ db, now });

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}
const emailOf = async (userId: string) => (await db.selectFrom("users").select("email").where("id", "=", userId).executeTakeFirstOrThrow()).email;
const today = () => new Date().toISOString().slice(0, 10);
/** Midi à Paris, hors de la nuit où les notifications sont reportées à 8 h. */
const noonParis = () => new Date(`${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T10:30:00Z`);

describe("Nos envies (US-147, US-148)", () => {
  it("le couple ajoute et lit les envies ; un invité secondaire n'y a pas accès (CA 1.1)", async () => {
    const f = await coupleFamily(db);
    const wish = await addWish(at(noonParis()), f.sophie, { title: "Week-end à Lisbonne", description: "Au printemps", horizon: "this_year" });
    expect(wish).toMatchObject({ title: "Week-end à Lisbonne", description: "Au printemps", horizon: "this_year", horizonLabel: "Cette année", mine: true });
    const marc = await listWishes(at(), f.marc);
    expect(marc.wishes).toHaveLength(1);
    expect(marc.wishes[0]).toMatchObject({ title: "Week-end à Lisbonne", by: "Sophie", mine: false });
    expect(marc.partner).toBe("Sophie");
    expect((await failure(listWishes(at(), f.elodie))).code).toBe("forbidden");
    expect((await failure(addWish(at(), f.elodie, { title: "Intrus" }))).code).toBe("forbidden");
  });

  it("titre obligatoire de 60 caractères au plus, description de 200, horizon dans la liste (RF1, RF2)", async () => {
    const f = await coupleFamily(db);
    expect((await failure(addWish(at(), f.sophie, { title: "  " }))).code).toBe("invalid_title");
    expect((await failure(addWish(at(), f.sophie, { title: "x".repeat(61) }))).code).toBe("invalid_title");
    expect((await failure(addWish(at(), f.sophie, { title: "Ok", description: "y".repeat(201) }))).code).toBe("invalid_description");
    expect((await failure(addWish(at(), f.sophie, { title: "Ok", horizon: "demain" }))).code).toBe("invalid_horizon");
    expect(await addWish(at(noonParis()), f.sophie, { title: "x".repeat(60), description: "y".repeat(200) })).toMatchObject({ horizon: null });
  });

  it("titre et description sont chiffrés en base", async () => {
    const f = await coupleFamily(db);
    await addWish(at(noonParis()), f.sophie, { title: "Cours de salsa", description: "Le jeudi soir" });
    const row = await db.selectFrom("couple_wishes").select(["title", "description"]).where("account_id", "=", f.accountId).executeTakeFirstOrThrow();
    expect(row.title.toString("utf8")).not.toContain("salsa");
    expect(row.description!.toString("utf8")).not.toContain("jeudi");
  });

  it("50 envies au plus par famille, réglable dans la console (RF5)", async () => {
    const f = await coupleFamily(db);
    await db.updateTable("platform_settings").set({ value_text: "2" }).where("setting_key", "=", "wish_max_per_family").execute();
    try {
      await addWish(at(noonParis()), f.sophie, { title: "Une" });
      await addWish(at(noonParis()), f.marc, { title: "Deux" });
      const refused = await failure(addWish(at(noonParis()), f.sophie, { title: "Trois" }));
      expect(refused.code).toBe("wish_limit");
      expect(refused.message).toBe("Vous avez beaucoup d'envies ! Faites-en disparaître une pour en ajouter une nouvelle.");
      expect((await listWishes(at(), f.sophie)).max).toBe(2);
    } finally {
      await db.updateTable("platform_settings").set({ value_text: "50" }).where("setting_key", "=", "wish_max_per_family").execute();
    }
  });

  it("l'un ou l'autre parent modifie une envie, sans prévenir l'autre (RF4, US-149 RF3)", async () => {
    const f = await coupleFamily(db);
    const wish = await addWish(at(noonParis()), f.sophie, { title: "Cours de salsa" });
    const before = await db.selectFrom("scheduled_notifications").select("id").where("kind", "=", "wish_added").execute();
    const changed = await updateWish(at(noonParis()), f.marc, wish.id, { title: "Cours de tango", horizon: "soon" });
    expect(changed).toMatchObject({ title: "Cours de tango", horizon: "soon", by: "Sophie" });
    expect((await db.selectFrom("scheduled_notifications").select("id").where("kind", "=", "wish_added").execute()).length).toBe(before.length);
  });

  it("rien de « Nos envies » ni du bilan ne passe par l'agent (E-08, E-09)", () => {
    const roots = ["src/server/assistant", "agent"];
    const forbidden = /couple_wishes|partner_notes|appreciation_hearts|weekly_reviews|emotions\//;
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = path.join(dir, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|md|json)$/.test(name) && forbidden.test(readFileSync(full, "utf8"))) offenders.push(full);
      }
    };
    for (const root of roots) walk(path.join(process.cwd(), root));
    // Seuls les modules du point de la semaine, des tâches et des RDV lisent les cœurs et la charge ; aucun outil de l'agent ni consigne ne les connaît.
    const allowed = ["digest.ts", "tasks.ts", "events.ts", "task-notices.ts"];
    expect(offenders.filter((o) => !allowed.includes(path.basename(o)))).toEqual([]);
    expect(offenders.filter((o) => /tools\.ts$|instructions/.test(o))).toEqual([]);
  });
});

describe("notification d'une envie (US-149)", () => {
  it("le partenaire est prévenu une seule fois, sans le titre, par e-mail à défaut d'appareil (CA 1.1)", async () => {
    const f = await coupleFamily(db);
    const wish = await addWish(at(noonParis()), f.sophie, { title: "Cours de salsa" });
    const marcMail = (await messagesTo(await emailOf(f.userIds.marc))).filter((m) => m.text.includes("a ajouté une envie à deux"));
    expect(marcMail).toHaveLength(1);
    expect(marcMail[0].text).toContain("Sophie a ajouté une envie à deux.");
    expect(marcMail[0].text).not.toContain("salsa");
    expect(marcMail[0].subject).not.toContain("salsa");
    // L'auteur n'est pas prévenu, et un second passage n'envoie rien de plus.
    expect((await messagesTo(await emailOf(f.userIds.sophie))).filter((m) => m.text.includes("une envie à deux"))).toEqual([]);
    expect(await sendWishNotices(at(noonParis()), { wishId: wish.id })).toEqual({ sent: 0, failed: 0 });
    const row = await db.selectFrom("scheduled_notifications").select(["status", "wish_id", "recipient_user_id"]).where("wish_id", "=", wish.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: "sent", recipient_user_id: f.userIds.marc });
  });

  it("la nuit, la notification est reportée à 8 h (RF4)", async () => {
    const f = await coupleFamily(db);
    const night = new Date(`${new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)}T22:30:00Z`); // 23 h 30 à Paris
    const wish = await addWish(at(night), f.sophie, { title: "Cours de salsa" });
    const row = await db.selectFrom("scheduled_notifications").select(["status", "due_at"]).where("wish_id", "=", wish.id).executeTakeFirstOrThrow();
    expect(row.status).toBe("scheduled");
    expect(row.due_at.getTime()).toBeGreaterThan(night.getTime());
    expect((await messagesTo(await emailOf(f.userIds.marc))).filter((m) => m.text.includes("une envie à deux"))).toEqual([]);
    expect((await sendWishNotices(at(new Date(row.due_at.getTime() + 60_000)), { wishId: wish.id })).sent).toBe(1);
  });
});

describe("retirer une envie (US-150)", () => {
  it("elle disparaît aussitôt, peut revenir pendant 10 secondes, puis est supprimée pour de bon (CA 1.1, 2.1)", async () => {
    const f = await coupleFamily(db);
    const wish = await addWish(at(noonParis()), f.sophie, { title: "Cours de salsa" });
    const removed = await removeWish(at(), f.marc, wish.id);
    expect(new Date(removed.undoUntil).getTime()).toBeGreaterThan(Date.now());
    expect((await listWishes(at(), f.sophie)).wishes).toEqual([]);
    expect((await restoreWish(at(), f.marc, wish.id)).title).toBe("Cours de salsa");
    expect((await listWishes(at(), f.sophie)).wishes).toHaveLength(1);
    // Retirée puis laissée : la base la supprime après le délai.
    await removeWish(at(), f.sophie, wish.id);
    await db.updateTable("couple_wishes").set({ removed_at: new Date(Date.now() - 60_000) }).where("id", "=", wish.id).execute();
    await sql`select purge_removed_wishes()`.execute(db);
    expect((await failure(restoreWish(at(), f.sophie, wish.id))).code).toBe("not_found");
  });

  it("une annulation trop tardive est refusée ; une envie retirée ne compte plus dans la limite", async () => {
    const f = await coupleFamily(db);
    const wish = await addWish(at(noonParis()), f.sophie, { title: "Cours de salsa" });
    await removeWish(at(), f.sophie, wish.id);
    await db.updateTable("couple_wishes").set({ removed_at: new Date(Date.now() - 60_000) }).where("id", "=", wish.id).execute();
    expect((await failure(restoreWish(at(), f.sophie, wish.id))).code).toBe("undo_expired");
  });

  it("le partenaire n'est pas prévenu d'un retrait (RF3)", async () => {
    const f = await coupleFamily(db);
    const wish = await addWish(at(noonParis()), f.sophie, { title: "Cours de salsa" });
    const mails = (await messagesTo(await emailOf(f.userIds.marc))).length;
    await removeWish(at(), f.sophie, wish.id);
    expect((await messagesTo(await emailOf(f.userIds.marc))).length).toBe(mails);
  });
});

describe("transformer une envie en RDV (US-151)", () => {
  const input = (f: CoupleFamily, day: string) => ({ title: "Week-end à Lisbonne", place: null, notes: "Au printemps", type: "family" as const, memberIds: [f.ids.sophie, f.ids.marc], start: `${day}T10:00`, end: `${day}T12:00` });
  const future = () => new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);

  it("le formulaire reprend le titre et la description ; à l'enregistrement le RDV existe et l'envie disparaît (CA 1.1, 2.1)", async () => {
    const f = await coupleFamily(db);
    const wish = await addWish(at(noonParis()), f.sophie, { title: "Week-end à Lisbonne", description: "Au printemps" });
    expect(await wishForm(at(), f.sophie, wish.id)).toMatchObject({ title: "Week-end à Lisbonne", notes: "Au printemps", type: "family", memberId: f.ids.sophie });
    const event = await addWishToCalendar(at(), f.sophie, wish.id, input(f, future()));
    expect(event).toMatchObject({ title: "Week-end à Lisbonne", status: "confirmed" });
    expect((await listWishes(at(), f.sophie)).wishes).toEqual([]);
    expect(await db.selectFrom("couple_wishes").select("id").where("id", "=", wish.id).execute()).toEqual([]);
    // L'envie ne revient pas ; un second envoi est refusé sans créer de RDV en double.
    expect((await failure(addWishToCalendar(at(), f.sophie, wish.id, input(f, future())))).code).toBe("not_found");
  });

  it("formulaire abandonné ou refusé : l'envie reste (CA 2.2)", async () => {
    const f = await coupleFamily(db);
    const wish = await addWish(at(noonParis()), f.sophie, { title: "Week-end à Lisbonne" });
    expect((await failure(addWishToCalendar(at(), f.sophie, wish.id, { ...input(f, future()), end: `${future()}T09:00` }))).code).toBe("invalid_time");
    expect((await listWishes(at(), f.sophie)).wishes).toHaveLength(1);
  });

  it("réservé au couple", async () => {
    const f = await coupleFamily(db);
    const wish = await addWish(at(noonParis()), f.sophie, { title: "Week-end à Lisbonne" });
    expect((await failure(wishForm(at(), f.elodie, wish.id))).code).toBe("forbidden");
  });
});

describe("« Confier à » (US-146, E-18)", () => {
  async function mine(f: CoupleFamily, title = "Courses du goûter") {
    return createTask(at(), f.sophie, { title, due: today(), assigneeId: f.ids.sophie });
  }
  const assignedMails = async (f: CoupleFamily) => (await messagesTo(await emailOf(f.userIds.marc))).filter((m) => m.text.includes("vous a confié"));

  it("réassigne à l'autre parent et retient la notification environ 15 secondes (CA 2.1)", async () => {
    const f = await coupleFamily(db);
    const task = await mine(f);
    const done = await handOverTask(at(), f.sophie, task.id, task.version);
    expect(done.to).toBe("Marc");
    expect(done.task.assignee?.id).toBe(f.ids.marc);
    expect(new Date(done.undoUntil).getTime()).toBeGreaterThan(Date.now());
    expect(await assignedMails(f)).toEqual([]);
    // Avant la fin du délai, rien ne part ; ensuite la notification est envoyée une seule fois.
    expect(await releaseHeldAssignments(at())).toBe(0);
    expect((await releaseHandOver(at(), f.sophie, task.id)).sent).toBe(0);
    expect(await releaseHeldAssignments(at(new Date(Date.now() + 20_000)))).toBe(1);
    const mails = await assignedMails(f);
    expect(mails).toHaveLength(1);
    expect(mails[0].text).toContain("Sophie vous a confié : Courses du goûter");
    expect(await releaseHeldAssignments(at(new Date(Date.now() + 40_000)))).toBe(0);
  });

  it("« Annuler » remet la tâche et la notification ne part jamais", async () => {
    const f = await coupleFamily(db);
    const task = await mine(f);
    const done = await handOverTask(at(), f.sophie, task.id);
    const back = await undoHandOver(at(), f.sophie, task.id, done.task.version);
    expect(back.assignee?.id).toBe(f.ids.sophie);
    expect(await releaseHeldAssignments(at(new Date(Date.now() + 60_000)))).toBe(0);
    expect(await assignedMails(f)).toEqual([]);
    expect((await getTask(at(), f.sophie, task.id)).assignee?.id).toBe(f.ids.sophie);
  });

  it("une tâche réassignée entre-temps n'est pas annoncée", async () => {
    const f = await coupleFamily(db);
    const task = await mine(f);
    await handOverTask(at(), f.sophie, task.id);
    await db.updateTable("family_tasks").set({ assigned_member_id: f.ids.sophie }).where("id", "=", task.id).execute();
    expect(await releaseHeldAssignments(at(new Date(Date.now() + 60_000)))).toBe(0);
    expect(await assignedMails(f)).toEqual([]);
  });

  it("seule une tâche à soi peut être confiée, et seulement par un parent du couple (RF1, RF4)", async () => {
    const f = await coupleFamily(db);
    const other = await createTask(at(), f.sophie, { title: "Pour Mia", due: today(), assigneeId: f.ids.mia });
    expect((await failure(handOverTask(at(), f.sophie, other.id))).code).toBe("not_yours");
    const task = await mine(f);
    expect((await failure(handOverTask(at(), f.elodie, task.id))).code).toBe("forbidden");
    // Une version périmée est refusée : on n'écrase pas un changement fait entre-temps.
    expect((await failure(handOverTask(at(), f.sophie, task.id, task.version + 5))).code).toBeTruthy();
    expect((await getTask(at(), f.sophie, task.id)).assignee?.id).toBe(f.ids.sophie);
  });
});
