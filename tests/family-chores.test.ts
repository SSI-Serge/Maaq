import type { Kysely } from "kysely";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ChoreDetailView } from "@/components/family/ChoreScreen";
import { aboutMinutes, ChoreRow } from "@/components/family/ChoresSettings";
import { prepareExport, readExport, requestExport } from "@/server/compliance/exports";
import { readZip } from "@/server/compliance/zip";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { choreDetail, getChoresSetting, saveChoreTask } from "@/server/assistant/chores";
import { addChild } from "@/server/assistant/family";
import { localDay } from "@/server/assistant/local-time";
import { addDays } from "@/server/assistant/series";
import { assignTask, cancelTask, listTasksBetween, setTaskDone, updateTask, type TaskView } from "@/server/assistant/tasks";
import type { Ctx } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { createGuest, createProfile, sessionFor, testDb } from "./helpers/fixtures";

/** Tâches ménagères guidées, lot 1 (US-181, US-182) : réglage du foyer, séries de l'écran Tâches, pas à pas. Le catalogue vient du premier chargement du lot 15. */

let db: Kysely<DB>;
beforeAll(() => {
  db = testDb();
});
afterAll(async () => {
  await db.destroy();
});

// Les gardes de la base datent avec l'horloge réelle : les essais aussi.
const ctx = (): Ctx => ({ get db() { return db; }, now: new Date() }) as Ctx;
const TODAY = localDay(new Date(), "Europe/Paris");
const isoDow = (day: string) => ((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

/** Camille et Julien (parents), Élodie (invitée secondaire), Léo (enfant sans profil). */
async function family() {
  const camille = await createProfile(db);
  await db.updateTable("accounts").set({ family_timezone: "Europe/Paris" }).where("id", "=", camille.accountId!).execute();
  const julien = await createGuest(db, camille.accountId!, "Julien", "core");
  const elodie = await createGuest(db, camille.accountId!, "Élodie");
  const camilleSession = await sessionFor(db, camille.id);
  const leo = await addChild(ctx(), camilleSession, { firstName: "Léo" });
  const elodieMember = (await db.selectFrom("family_members").select("id").where("user_id", "=", elodie.id).executeTakeFirstOrThrow()).id;
  return { accountId: camille.accountId!, camilleSession, julienSession: await sessionFor(db, julien.id), elodieSession: await sessionFor(db, elodie.id), leo: leo.id, elodieMember };
}
type Family = Awaited<ReturnType<typeof family>>;

const idOf = async (name: string) => (await db.selectFrom("chore_tasks").select("id").where("name", "=", name).executeTakeFirstOrThrow()).id;
const binOf = async (name: string) => (await db.selectFrom("chore_bins").select("id").where("name", "like", `${name}%`).executeTakeFirstOrThrow()).id;
const tasksOf = async (f: Family, session = f.camilleSession): Promise<TaskView[]> => listTasksBetween(ctx(), session, { from: TODAY, to: addDays(TODAY, 30) });
const choreTasks = async (f: Family, title: string, session = f.camilleSession) => (await tasksOf(f, session)).filter((t) => t.title === title && t.status === "todo");

describe("réglage « Tâches ménagères guidées » du foyer (US-181)", () => {
  it("au départ : les 8 tâches du guide, toutes désactivées, avec le temps proposé et les jours par défaut ; les 4 bacs à 19 h ; lecture seule pour l'invitée secondaire", async () => {
    const f = await family();
    const setting = await getChoresSetting(ctx(), f.camilleSession);
    expect(setting.canEdit).toBe(true);
    expect(setting.tasks.map((t) => [t.name, t.minutes, t.enabled, t.days])).toEqual([
      ["Cuisine", 35, false, [1]],
      ["Salle de bains", 30, false, [2]],
      ["Toilettes", 10, false, [2]],
      ["Sols", 45, false, [4]],
      ["Chambres et pièces de vie", 35, false, [3]],
      ["Linge", 60, false, [5]],
      ["Repassage", 30, false, [5]],
      ["Sorties de poubelles", 10, false, []],
    ]);
    const bins = setting.tasks.find((t) => t.mode === "day_before_collection")!;
    expect(bins.bins.map((b) => [b.taskTitle, b.collectionDay])).toEqual([["Sortir le bac des ordures ménagères", null], ["Sortir le bac jaune", null], ["Sortir le verre", null], ["Sortir les biodéchets", null]]);
    expect(bins.binTime).toBe("19:00");
    // Tout membre actif peut recevoir une tâche, enfants compris (TM-04)
    expect(setting.members.map((m) => m.firstName)).toEqual(expect.arrayContaining(["Julien", "Élodie", "Léo"]));
    const guest = await getChoresSetting(ctx(), f.elodieSession);
    expect(guest.canEdit).toBe(false);
    expect((await failure(saveChoreTask(ctx(), f.elodieSession, await idOf("Cuisine"), { enabled: true }))).status).toBe(403);
  });

  it("activer une tâche crée sa série dès le lendemain, les jours choisis, avec la personne ; elle se coche dans la liste, mais ne se modifie que dans les réglages", async () => {
    const f = await family();
    const cuisine = await idOf("Cuisine");
    await saveChoreTask(ctx(), f.julienSession, cuisine, { enabled: true, days: [1, 4], memberId: f.leo });
    const tasks = await choreTasks(f, "Cuisine");
    expect(tasks.length).toBeGreaterThanOrEqual(8);
    expect(new Set(tasks.map((t) => isoDow(t.due)))).toEqual(new Set([1, 4]));
    expect(tasks.every((t) => t.due > TODAY)).toBe(true);
    expect(tasks[0]).toMatchObject({ chore: { taskId: cuisine, binId: null }, assignee: { firstName: "Léo" }, recurring: true, can: { check: true, manage: false } });
    // Ni modifiée, ni réassignée, ni annulée depuis l'écran Tâches
    expect((await failure(updateTask(ctx(), f.camilleSession, tasks[0].id, { title: "Autre", due: tasks[0].due }, { expectedVersion: tasks[0].version }))).code).toBe("chore_in_settings");
    expect((await failure(assignTask(ctx(), f.camilleSession, tasks[0].id, null))).code).toBe("chore_in_settings");
    expect((await failure(cancelTask(ctx(), f.camilleSession, tasks[0].id))).code).toBe("chore_in_settings");
    // Elle se coche
    expect((await setTaskDone(ctx(), f.camilleSession, tasks[0].id, true)).status).toBe("done");
    // Une seule série active pour la tâche, et le lien est posé par la base
    const linked = await db.selectFrom("chore_household_tasks").select("chore_series_id").where("account_id", "=", f.accountId).where("task_id", "=", cuisine).executeTakeFirstOrThrow();
    expect(linked.chore_series_id).not.toBeNull();
    await saveChoreTask(ctx(), f.camilleSession, cuisine, { enabled: true, days: [1, 4], memberId: f.leo });
    expect(await db.selectFrom("family_task_series").select("id").where("account_id", "=", f.accountId).where("chore_task_id", "=", cuisine).where("ended_at", "is", null).execute()).toHaveLength(1);
  });

  it("au moins un jour ; changer les jours et la personne vaut pour les occurrences à venir non cochées ; désactiver arrête la série, une occurrence cochée reste", async () => {
    const f = await family();
    const sols = await idOf("Sols");
    expect((await failure(saveChoreTask(ctx(), f.camilleSession, sols, { enabled: true, days: [] }))).message).toBe("Choisissez au moins un jour.");
    await saveChoreTask(ctx(), f.camilleSession, sols, { enabled: true, days: [4] });
    const first = (await choreTasks(f, "Sols"))[0];
    await setTaskDone(ctx(), f.camilleSession, first.id, true);
    await saveChoreTask(ctx(), f.camilleSession, sols, { enabled: true, days: [2, 6], memberId: f.elodieMember });
    const after = await choreTasks(f, "Sols");
    expect(new Set(after.map((t) => isoDow(t.due)))).toEqual(new Set([2, 6]));
    expect(after.every((t) => t.assignee?.firstName === "Élodie")).toBe(true);
    const done = await db.selectFrom("family_tasks").select(["status", "assigned_member_id"]).where("id", "=", first.id).executeTakeFirstOrThrow();
    expect(done).toEqual({ status: "done", assigned_member_id: null });
    // Confiée à Élodie : l'invitée secondaire la voit, avec son pas à pas
    expect((await choreTasks(f, "Sols", f.elodieSession)).length).toBe(after.length);
    await saveChoreTask(ctx(), f.camilleSession, sols, { enabled: false });
    expect(await choreTasks(f, "Sols")).toEqual([]);
    expect((await db.selectFrom("family_tasks").select("status").where("id", "=", first.id).executeTakeFirstOrThrow()).status).toBe("done");
    expect((await getChoresSetting(ctx(), f.camilleSession)).tasks.find((t) => t.taskId === sols)).toMatchObject({ enabled: false, days: [2, 6] });
  });

  it("une tâche sans personne n'est vue que par les deux parents", async () => {
    const f = await family();
    await saveChoreTask(ctx(), f.camilleSession, await idOf("Toilettes"), { enabled: true, days: [2] });
    expect((await choreTasks(f, "Toilettes", f.julienSession)).length).toBeGreaterThan(0);
    expect(await choreTasks(f, "Toilettes", f.elodieSession)).toEqual([]);
  });

  it("Sorties de poubelles : au moins un bac collecté ; « Sortir le bac jaune » la veille de la collecte, à l'heure choisie ; « Pas de collecte » ne crée rien", async () => {
    const f = await family();
    const poubelles = await idOf("Sorties de poubelles");
    const jaune = await binOf("Emballages");
    const verre = await binOf("Verre");
    expect((await failure(saveChoreTask(ctx(), f.camilleSession, poubelles, { enabled: true, bins: [{ binId: verre, collectionDay: null }] }))).message).toBe("Choisissez au moins un jour de collecte.");
    // Collecte du bac jaune le mardi : la tâche tombe le lundi, à 19 h
    await saveChoreTask(ctx(), f.camilleSession, poubelles, { enabled: true, bins: [{ binId: jaune, collectionDay: 2 }, { binId: verre, collectionDay: null }], memberId: f.leo });
    const yellow = await choreTasks(f, "Sortir le bac jaune");
    expect(yellow.length).toBeGreaterThan(0);
    expect(new Set(yellow.map((t) => isoDow(t.due)))).toEqual(new Set([1]));
    expect(yellow[0]).toMatchObject({ dueTime: "19:00", chore: { taskId: poubelles, binId: jaune }, assignee: { firstName: "Léo" } });
    expect(await choreTasks(f, "Sortir le verre")).toEqual([]);
    // Collecte le lundi : la tâche tombe le dimanche ; l'heure change pour tous les bacs
    const ordures = await binOf("Ordures");
    await saveChoreTask(ctx(), f.camilleSession, poubelles, { enabled: true, bins: [{ binId: ordures, collectionDay: 1 }], binTime: "20:30" });
    expect(new Set((await choreTasks(f, "Sortir le bac des ordures ménagères")).map((t) => isoDow(t.due)))).toEqual(new Set([7]));
    expect((await choreTasks(f, "Sortir le bac jaune")).every((t) => t.dueTime === "20:30")).toBe(true);
    expect((await getChoresSetting(ctx(), f.camilleSession)).tasks.find((t) => t.taskId === poubelles)).toMatchObject({ binTime: "20:30" });
    // Le bac jaune passe en « Pas de collecte » : sa série s'arrête
    await saveChoreTask(ctx(), f.camilleSession, poubelles, { enabled: true, bins: [{ binId: jaune, collectionDay: null }] });
    expect(await choreTasks(f, "Sortir le bac jaune")).toEqual([]);
    expect((await choreTasks(f, "Sortir le bac des ordures ménagères")).length).toBeGreaterThan(0);
  });

  it("une tâche masquée dans la console reste chez le foyer qui l'a activée, mais ne peut plus qu'être désactivée ; un autre foyer ne la voit plus", async () => {
    const f = await family();
    const repassage = await idOf("Repassage");
    await saveChoreTask(ctx(), f.camilleSession, repassage, { enabled: true, days: [5] });
    await db.updateTable("chore_tasks").set({ is_active: false }).where("id", "=", repassage).execute();
    try {
      expect((await getChoresSetting(ctx(), f.camilleSession)).tasks.find((t) => t.taskId === repassage)).toMatchObject({ enabled: true, withdrawn: true });
      expect((await failure(saveChoreTask(ctx(), f.camilleSession, repassage, { enabled: true, days: [3] }))).code).toBe("chore_withdrawn");
      await saveChoreTask(ctx(), f.camilleSession, repassage, { enabled: false });
      expect((await getChoresSetting(ctx(), f.camilleSession)).tasks.some((t) => t.taskId === repassage)).toBe(false);
      expect((await failure(saveChoreTask(ctx(), f.camilleSession, repassage, { enabled: true, days: [5] }))).code).toBe("chore_withdrawn");
      const other = await family();
      expect((await getChoresSetting(ctx(), other.camilleSession)).tasks.some((t) => t.taskId === repassage)).toBe(false);
    } finally {
      await db.updateTable("chore_tasks").set({ is_active: true }).where("id", "=", repassage).execute();
    }
  });
});

describe("pas à pas d'une tâche ménagère (US-182)", () => {
  it("Cuisine : 6 gestes dans l'ordre, « À ne jamais faire » de la tâche, dépannage terminé par la ligne fixe, « Avant de commencer » avec le chiffon bleu", async () => {
    const f = await family();
    const d = await choreDetail(ctx(), f.elodieSession, await idOf("Cuisine"));
    expect(d.gestures.map((g) => g.name)).toEqual(["Plan de travail, table", "Évier, robinet", "Plaques de cuisson", "Micro-ondes", "Réfrigérateur", "Poubelle"]);
    expect(d.gestures[0]).toEqual({ name: "Plan de travail, table", product: "Spray savon noir", minutes: 5, steps: ["Tout débarrasser", "Pulvériser", "Attendre 2 min", "Essuyer et sécher"] });
    expect(d.neverDo[0]).toMatch(/^Ne jamais mélanger de la javel/);
    expect(d.troubleshooting.at(-1)).toEqual({ problem: "Problème que ce guide ne couvre pas", solution: "Arrêter, ne rien mélanger, et prévenir la personne qui s'en occupe habituellement" });
    expect(d.before!.rules).toHaveLength(5);
    expect(d.before!.materials.map((m) => m.name)).toContain("Chiffon bleu");
    expect(d.before!.materials.map((m) => m.name)).not.toContain("Chiffon rouge");
  });

  it("Linge sans geste « Repassage » ni encadré rouge ; Repassage avec sa préparation et ses tissus ; Poubelles sans « Avant de commencer », avec ses bacs", async () => {
    const f = await family();
    const linge = await choreDetail(ctx(), f.camilleSession, await idOf("Linge"));
    expect(linge.gestures.map((g) => g.name)).not.toContain("Repassage");
    expect(linge.neverDo).toEqual([]);
    const repassage = await choreDetail(ctx(), f.camilleSession, await idOf("Repassage"));
    expect(repassage.before!.steps).toHaveLength(4);
    expect(repassage.before!.fabrics.map((x) => x.fabric)).toEqual(["Soie, synthétique, viscose", "Laine, mélange polyester", "Coton", "Lin"]);
    expect(repassage.intro[0]).toMatch(/^On ne repasse que ce qui en a besoin/);
    const poubelles = await choreDetail(ctx(), f.camilleSession, await idOf("Sorties de poubelles"));
    expect(poubelles.before).toBeNull();
    expect(poubelles.bins).toHaveLength(4);
    expect(poubelles.binTime).toBe("19:00");
    expect(poubelles.notes.some((n) => n.title === "Autres déchets")).toBe(true);
    // Toilettes n'a pas de dépannage rattaché : la section garde la ligne fixe (décision du PO)
    expect((await choreDetail(ctx(), f.camilleSession, await idOf("Toilettes"))).troubleshooting.map((x) => x.problem)).toEqual(["Problème que ce guide ne couvre pas"]);
  });
});

describe("écrans et export des tâches ménagères", () => {
  it("rendu de la carte des réglages : temps proposé, jours, bacs avec « Sortir le bac jaune » la veille, heure, personne ; « Cette tâche n'est plus proposée »", async () => {
    const f = await family();
    const poubelles = await idOf("Sorties de poubelles");
    const jaune = await binOf("Emballages");
    await saveChoreTask(ctx(), f.camilleSession, await idOf("Linge"), { enabled: true, days: [5] });
    await saveChoreTask(ctx(), f.camilleSession, poubelles, { enabled: true, bins: [{ binId: jaune, collectionDay: 2 }] });
    const setting = await getChoresSetting(ctx(), f.camilleSession);
    const row = (name: string) => renderToStaticMarkup(createElement(ChoreRow, { task: setting.tasks.find((t) => t.name === name)!, members: setting.members, canEdit: true, busy: false, error: null, onSave: () => undefined }));
    const linge = row("Linge");
    expect(linge).toContain("environ 1 h");
    expect(linge).toMatch(/aria-pressed="true" aria-label="vendredi"/);
    expect(linge).toContain("/assistant/taches/menage/");
    const bins = row("Sorties de poubelles");
    expect(bins).toContain("« Sortir le bac jaune », le lundi à 19 h");
    expect(bins).toContain("La même pour tous les bacs");
    expect(bins.match(/<option value="(1[7-9]|2[0-2]):00"/g)).toHaveLength(6);
    expect(bins).toContain("Pas de collecte");
    expect(row("Cuisine")).toContain("environ 35 min");
    expect(row("Cuisine")).not.toContain("Jours");
    const withdrawn = renderToStaticMarkup(createElement(ChoreRow, { task: { ...setting.tasks[0], withdrawn: true }, members: [], canEdit: true, busy: false, error: null, onSave: () => undefined }));
    expect(withdrawn).toContain("Cette tâche n&#x27;est plus proposée.");
    expect(aboutMinutes(90)).toBe("environ 1 h 30");
  });

  it("rendu du pas à pas : « À ne jamais faire » en haut, gestes numérotés, « Avant de commencer » replié ; Poubelles : bacs, jours de collecte, pas de « Première fois »", async () => {
    const f = await family();
    const toilettes = renderToStaticMarkup(createElement(ChoreDetailView, { d: await choreDetail(ctx(), f.camilleSession, await idOf("Toilettes")), binId: null }));
    expect(toilettes.indexOf("À ne jamais faire")).toBeLessThan(toilettes.indexOf("1. Cuvette"));
    expect(toilettes).toContain("Ne jamais mélanger de la javel");
    expect(toilettes).toContain("Première fois ?");
    expect(toilettes).toContain("0 sur 3 gestes");
    expect(toilettes).toContain('aria-expanded="false"');
    expect(toilettes).toContain("Si ça ne se passe pas bien");
    expect(toilettes).toContain("Problème que ce guide ne couvre pas");
    expect(toilettes).not.toContain("Les 5 règles d&#x27;or");
    const poubelles = await idOf("Sorties de poubelles");
    const jaune = await binOf("Emballages");
    await saveChoreTask(ctx(), f.camilleSession, poubelles, { enabled: true, bins: [{ binId: jaune, collectionDay: 2 }], binTime: "20:30" });
    const bins = renderToStaticMarkup(createElement(ChoreDetailView, { d: await choreDetail(ctx(), f.camilleSession, poubelles), binId: jaune }));
    expect(bins).toContain("Collecte le mardi · à sortir le lundi à 20 h 30");
    expect(bins).toContain("Pas de collecte (colonne à verre ou bac)");
    expect(bins).toContain("Le soir de collecte");
    expect(bins).not.toContain("Première fois ?");
    expect(bins).not.toContain("Avant de commencer");
  });

  it("export d'un parent : le réglage du foyer ; rien pour une invitée secondaire", async () => {
    const f = await family();
    await saveChoreTask(ctx(), f.camilleSession, await idOf("Cuisine"), { enabled: true, days: [1], memberId: f.leo });
    const exported = async (session: Family["camilleSession"]) => {
      const now: Ctx = { db, now: new Date() } as Ctx;
      const { id } = await requestExport(now, session);
      expect(await prepareExport(now, id)).toBe("ready");
      const files = readZip(await readExport(now, session, id));
      return JSON.parse(files.find((x) => x.name === "mes-donnees.json")!.data.toString());
    };
    expect((await exported(f.julienSession)).householdChores).toEqual([{ tache: "Cuisine", activee: true, jours: ["lundi"], personne: "Léo", bacs: [] }]);
    expect((await exported(f.elodieSession)).householdChores).toEqual([]);
  });
});
