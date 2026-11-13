import { sql, type Kysely } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { requireFamilyProfile } from "./family";
import { loadMembers, type MemberChip } from "./member-chips";
import { addDays } from "./series";
import { loadTaskSeries, materializeOwnSeries, taskHorizon } from "./task-series";
import { localDay } from "./local-time";
import { familyTimeZone } from "./reminders";

/**
 * Tâches ménagères guidées (US-181, US-182 ; lot 15, D75). Un catalogue commun (tâches, gestes, contenus), lu seulement ici ; un réglage du foyer que les deux parents écrivent et
 * que les autres profils lisent ; et, pour chaque tâche activée, une série hebdomadaire de l'écran Tâches (source `household_chore`). « Sorties de poubelles » a une série par
 * bac collecté, la veille de la collecte, à l'heure choisie par le foyer (la même pour tous les bacs).
 * La base impose les jours, la personne et l'heure des séries d'après le réglage, pose et retire leur lien, arrête la série quand la tâche est désactivée et reprend les
 * occurrences à venir quand le réglage change ; ce module crée les séries qui manquent et en crée les occurrences, dès le lendemain (RF6). Aucun appel à l'IA.
 */

type Db = Kysely<DB>;

const fail = (code: string, message: string, status = 422) => new Rejection(code, message, status);

/** Heure par défaut de la tâche de la veille d'une collecte (TM-10). */
export const DEFAULT_BIN_TIME = "19:00";

export interface ChoreBinSetting {
  binId: number;
  name: string;
  /** Jour de collecte (1 = lundi … 7 = dimanche), ou `null` : « Pas de collecte » ou pas encore choisi. */
  collectionDay: number | null;
  /** Titre de la tâche du foyer pour ce bac (« Sortir le bac jaune »). */
  taskTitle: string;
}

export interface ChoreTaskSetting {
  taskId: number;
  name: string;
  /** Temps de réalisation proposé, en minutes. */
  minutes: number;
  /** `weekdays` : les jours choisis ; `day_before_collection` : la veille de la collecte de chaque bac (Sorties de poubelles). */
  mode: "weekdays" | "day_before_collection";
  enabled: boolean;
  /** Jours du foyer, ou les jours par défaut du catalogue tant que la tâche n'a jamais été réglée. Vide pour une tâche à collecte. */
  days: number[];
  memberId: string | null;
  /** Bacs (Sorties de poubelles) et leur jour de collecte. */
  bins: ChoreBinSetting[];
  /** Heure de sortie des bacs, la même pour tous (« 19:00 »). */
  binTime: string | null;
  /** La tâche n'est plus proposée par MAAQ (masquée dans la console) : elle reste listée tant que le foyer l'a activée, et ne peut plus qu'être désactivée (US-183 RF4). */
  withdrawn: boolean;
}

export interface ChoresSetting {
  /** Les deux parents modifient ; les autres profils lisent (BA-1). */
  canEdit: boolean;
  tasks: ChoreTaskSetting[];
  /** Membres à qui confier une tâche : tous les membres actifs, enfants compris (TM-04). */
  members: MemberChip[];
}

const time5 = (value: string | null | undefined) => (value ? value.slice(0, 5) : null);

/** Réglage « Tâches ménagères guidées » du foyer : les tâches actives du catalogue, plus celles que le foyer a activées et qui ont été masquées depuis. */
export async function getChoresSetting(ctx: Ctx, session: SessionContext): Promise<ChoresSetting> {
  const { accountId, parent } = requireFamilyProfile(session);
  const catalog = await ctx.db.selectFrom("chore_tasks").select(["id", "name", "position", "schedule_mode", "default_days", "suggested_minutes", "is_active"]).orderBy("position").orderBy("id").execute();
  const mine = await ctx.db.selectFrom("chore_household_tasks").select(["task_id", "is_enabled", "weekdays", "member_id"]).where("account_id", "=", accountId).execute();
  const bins = await ctx.db.selectFrom("chore_bins").select(["id", "task_id", "name", "task_title"]).orderBy("position").orderBy("id").execute();
  const myBins = await ctx.db.selectFrom("chore_household_bins").select(["bin_id", "collection_day", sql<string>`due_time::text`.as("due_time")]).where("account_id", "=", accountId).execute();
  const members = [...(await loadMembers(ctx.db, accountId)).values()].filter((m) => !m.removed);
  const tasks: ChoreTaskSetting[] = [];
  for (const t of catalog) {
    const h = mine.find((m) => m.task_id === t.id);
    if (!t.is_active && !h?.is_enabled) continue;
    const ownBins = bins.filter((b) => b.task_id === t.id);
    const binRows = ownBins.map((b) => myBins.find((x) => x.bin_id === b.id));
    tasks.push({
      taskId: t.id,
      name: t.name,
      minutes: t.suggested_minutes,
      mode: t.schedule_mode,
      enabled: Boolean(h?.is_enabled),
      days: t.schedule_mode === "weekdays" ? [...(h?.weekdays ?? t.default_days ?? [])] : [],
      memberId: h?.member_id ?? null,
      bins: ownBins.map((b, i) => ({ binId: b.id, name: b.name, taskTitle: b.task_title, collectionDay: binRows[i]?.collection_day ?? null })),
      binTime: t.schedule_mode === "day_before_collection" ? (time5(binRows.find(Boolean)?.due_time) ?? DEFAULT_BIN_TIME) : null,
      withdrawn: !t.is_active,
    });
  }
  return { canEdit: parent, tasks, members };
}

export interface ChoreTaskInput {
  enabled: boolean;
  /** Jours (1 = lundi … 7 = dimanche), au moins un : tâche à jours seulement. */
  days?: number[];
  memberId?: string | null;
  /** Jour de collecte de chaque bac, ou `null` (« Pas de collecte ») : Sorties de poubelles seulement. */
  bins?: { binId: number; collectionDay: number | null }[];
  /** Heure de sortie des bacs, « HH:MM ». */
  binTime?: string | null;
}

const isTime = (value: unknown): value is string => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const validDays = (days: unknown): days is number[] => Array.isArray(days) && days.length > 0 && days.every((d) => Number.isInteger(d) && d >= 1 && d <= 7) && new Set(days).size === days.length;

/** Messages des gardes de la base traduits pour l'écran ; le reste remonte tel quel. */
function translate(error: unknown): unknown {
  const message = (error as { message?: string }).message ?? "";
  for (const known of ["Choisissez au moins un jour.", "Choisissez au moins un jour de collecte.", "Cette tâche n'est plus proposée."]) {
    if (message.includes(known)) return fail(known === "Cette tâche n'est plus proposée." ? "chore_withdrawn" : "chore_days", known);
  }
  if (message.includes("membre actif") || message.includes("masqué")) return fail("invalid_member", "Choisissez un membre du foyer.");
  return error;
}

/**
 * Enregistre le réglage d'une tâche du foyer (US-181 RF1 à RF6) et met ses séries d'accord, dans une seule transaction : activer crée la série (une par bac collecté pour
 * les poubelles) à partir du lendemain ; changer les jours, la personne ou l'heure reprend les occurrences à venir non cochées ; désactiver arrête la série, les occurrences
 * passées restent. Une tâche masquée dans la console ne peut plus qu'être désactivée.
 */
export async function saveChoreTask(ctx: Ctx, session: SessionContext, taskId: number, input: ChoreTaskInput): Promise<ChoresSetting> {
  const { accountId, parent } = requireFamilyProfile(session);
  if (!parent) throw fail("forbidden", "Seuls les parents du foyer modifient les tâches ménagères.", 403);
  const task = await ctx.db.selectFrom("chore_tasks").select(["id", "schedule_mode", "default_days", "is_active"]).where("id", "=", taskId).executeTakeFirst();
  if (!task) throw fail("not_found", "Cette tâche n'existe pas.", 404);
  const current = await ctx.db.selectFrom("chore_household_tasks").select(["is_enabled", "weekdays", "member_id"]).where("account_id", "=", accountId).where("task_id", "=", taskId).executeTakeFirst();
  if (!task.is_active && (input.enabled ? true : false)) {
    // Tâche masquée : seule la désactivation est acceptée (décision du PO, point f).
    const unchanged = current?.is_enabled && input.days === undefined && input.memberId === undefined && input.bins === undefined && input.binTime === undefined;
    if (!current?.is_enabled || !unchanged) throw fail("chore_withdrawn", "Cette tâche n'est plus proposée.", 409);
  }
  const weekdays = task.schedule_mode === "weekdays";
  const days = weekdays ? (input.days ?? current?.weekdays ?? task.default_days ?? []) : null;
  if (weekdays && !validDays(days)) throw fail("chore_days", "Choisissez au moins un jour.");
  const memberId = input.memberId === undefined ? (current?.member_id ?? null) : input.memberId;
  if (memberId !== null) {
    const ok = await ctx.db.selectFrom("family_members").select("id").where("account_id", "=", accountId).where("id", "=", memberId).where("archived_at", "is", null).executeTakeFirst();
    if (!ok) throw fail("invalid_member", "Choisissez un membre du foyer.");
  }
  if (input.binTime !== undefined && input.binTime !== null && !isTime(input.binTime)) throw fail("invalid_time", "Choisissez une heure.");
  const catalogBins = weekdays ? [] : await ctx.db.selectFrom("chore_bins").select(["id"]).where("task_id", "=", taskId).execute();
  for (const b of input.bins ?? []) {
    if (!catalogBins.some((c) => c.id === b.binId)) throw fail("invalid_bin", "Ce bac n'existe pas.");
    if (b.collectionDay !== null && !(Number.isInteger(b.collectionDay) && b.collectionDay >= 1 && b.collectionDay <= 7)) throw fail("invalid_day", "Choisissez un jour de collecte.");
  }
  const timeZone = await familyTimeZone(ctx.db, accountId);
  const today = localDay(ctx.now, timeZone);

  try {
    await ctx.db.transaction().execute(async (trx) => {
      await trx
        .insertInto("chore_household_tasks")
        .values({ account_id: accountId, task_id: taskId, is_enabled: input.enabled, weekdays: days, member_id: memberId })
        .onConflict((oc) => oc.columns(["account_id", "task_id"]).doUpdateSet({ is_enabled: input.enabled, weekdays: days, member_id: memberId }))
        .execute();
      if (!weekdays) {
        const existing = await trx.selectFrom("chore_household_bins").select(["bin_id", "collection_day", sql<string>`due_time::text`.as("due_time")]).where("account_id", "=", accountId).where("task_id", "=", taskId).execute();
        const time = input.binTime ?? time5(existing[0]?.due_time) ?? DEFAULT_BIN_TIME;
        for (const c of catalogBins) {
          const asked = input.bins?.find((b) => b.binId === c.id);
          const had = existing.find((e) => e.bin_id === c.id);
          const day = asked ? asked.collectionDay : (had?.collection_day ?? null);
          await trx
            .insertInto("chore_household_bins")
            .values({ account_id: accountId, bin_id: c.id, task_id: taskId, collection_day: day, due_time: time })
            .onConflict((oc) => oc.columns(["account_id", "bin_id"]).doUpdateSet({ collection_day: day, due_time: time }))
            .execute();
        }
      }
      if (!input.enabled) return;
      await ensureSeries(trx, accountId, session.user.id, taskId, weekdays, today);
    });
  } catch (error) {
    throw translate(error);
  }
  return getChoresSetting(ctx, session);
}

/** Crée les séries qui manquent (la tâche, ou un bac collecté) et leurs occurrences jusqu'à l'horizon ; les séries existantes, déjà remises d'accord par la base, sont complétées. */
async function ensureSeries(trx: Db, accountId: string, userId: string, taskId: number, weekdays: boolean, today: string): Promise<void> {
  const tomorrow = addDays(today, 1);
  const wanted: (number | null)[] = weekdays
    ? [null]
    : (await trx.selectFrom("chore_household_bins").select("bin_id").where("account_id", "=", accountId).where("task_id", "=", taskId).where("collection_day", "is not", null).execute()).map((b) => b.bin_id);
  const active = await trx.selectFrom("family_task_series").select(["id", "chore_bin_id"]).where("account_id", "=", accountId).where("chore_task_id", "=", taskId).where("ended_at", "is", null).execute();
  for (const binId of wanted) {
    if (active.some((s) => s.chore_bin_id === binId)) continue;
    // Jours, personne et heure : posés par la base d'après le réglage. Le titre est vide : il est lu dans le catalogue.
    await trx
      .insertInto("family_task_series")
      .values({
        account_id: accountId, title: Buffer.alloc(0), first_date: tomorrow, repeat_unit: "week", repeat_interval: 1, weekdays: [1], end_kind: "never",
        created_by_user_id: userId, source: "household_chore", chore_task_id: taskId, chore_bin_id: binId,
      })
      .execute();
  }
  const horizon = await taskHorizon(trx, today);
  const all = await trx.selectFrom("family_task_series").select("id").where("account_id", "=", accountId).where("chore_task_id", "=", taskId).where("ended_at", "is", null).execute();
  for (const { id } of all) {
    const series = await loadTaskSeries(trx, accountId, id);
    // Dès le lendemain (RF6) : jamais d'occurrence aujourd'hui.
    if (series) await materializeOwnSeries(trx, series, tomorrow, horizon);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Pas à pas d'une tâche (US-182)
// ---------------------------------------------------------------------------------------------------------------------------

export interface ChoreDetail {
  taskId: number;
  name: string;
  minutes: number;
  mode: "weekdays" | "day_before_collection";
  /** Réglage du foyer : jours, personne, bacs et heure. */
  days: number[];
  person: string | null;
  bins: { binId: number; name: string; contents: string; hint: string | null; taskTitle: string; collectionDay: number | null }[];
  binTime: string | null;
  /** « À ne jamais faire » de la tâche : toujours visibles, en haut (RF4). */
  neverDo: string[];
  intro: string[];
  gestures: { name: string; product: string | null; minutes: number | null; steps: string[] }[];
  /** Notes qui suivent les gestes (ordre de la séance, tri, autres déchets). */
  notes: { title: string | null; body: string }[];
  /** « Si ça ne se passe pas bien » : vide pour une tâche sans dépannage ; sinon terminé par la ligne fixe (RF5). */
  troubleshooting: { problem: string; solution: string }[];
  /** « Avant de commencer » : `null` pour Sorties de poubelles (TM-07). */
  before: null | {
    rules: { title: string; body: string }[];
    materials: { name: string; detail: string | null }[];
    products: { name: string; usedFor: string; avoidOn: string | null; optional: boolean }[];
    recipes: { name: string; dosage: string; usedFor: string }[];
    steps: string[];
    fabrics: { fabric: string; points: number; temperature: number; advice: string }[];
  };
}

/** Le pas à pas d'une tâche du catalogue, pour tout profil du foyer (le contenu est commun ; le réglage du foyer, lisible par tous ses membres). */
export async function choreDetail(ctx: Ctx, session: SessionContext, taskId: number): Promise<ChoreDetail> {
  const { accountId } = requireFamilyProfile(session);
  const t = await ctx.db.selectFrom("chore_tasks").select(["id", "name", "schedule_mode", "suggested_minutes", "is_active"]).where("id", "=", taskId).executeTakeFirst();
  if (!t) throw fail("not_found", "Cette tâche n'existe pas.", 404);
  const h = await ctx.db.selectFrom("chore_household_tasks").select(["is_enabled", "weekdays", "member_id"]).where("account_id", "=", accountId).where("task_id", "=", taskId).executeTakeFirst();
  if (!t.is_active && !h?.is_enabled) throw fail("not_found", "Cette tâche n'est plus proposée.", 404);
  const db = ctx.db;
  const [gestures, never, notes, trouble, closing, rules, materials, products, recipes, fabrics, bins, myBins] = await Promise.all([
    db.selectFrom("chore_gestures").select(["name", "product", "minutes", "steps"]).where("task_id", "=", taskId).orderBy("position").orderBy("id").execute(),
    db.selectFrom("chore_never_do as n").innerJoin("chore_never_do_tasks as l", "l.never_do_id", "n.id").select("n.body").where("l.task_id", "=", taskId).orderBy("n.position").orderBy("n.id").execute(),
    db.selectFrom("chore_task_notes").select(["kind", "title", "body"]).where("task_id", "=", taskId).orderBy("kind").orderBy("position").orderBy("id").execute(),
    db.selectFrom("chore_troubleshooting as x").innerJoin("chore_troubleshooting_tasks as l", "l.troubleshooting_id", "x.id").select(["x.problem", "x.solution"]).where("l.task_id", "=", taskId).orderBy("x.position").orderBy("x.id").execute(),
    db.selectFrom("chore_troubleshooting").select(["problem", "solution"]).where("is_closing", "=", true).executeTakeFirst(),
    db.selectFrom("chore_golden_rules").select(["title", "body"]).orderBy("position").orderBy("id").execute(),
    db.selectFrom("chore_materials as m").innerJoin("chore_task_materials as l", "l.material_id", "m.id").select(["m.name", "m.detail"]).where("l.task_id", "=", taskId).orderBy("m.position").orderBy("m.id").execute(),
    db.selectFrom("chore_products as p").innerJoin("chore_task_products as l", "l.product_id", "p.id").select(["p.name", "p.used_for", "p.avoid_on", "p.is_optional"]).where("l.task_id", "=", taskId).orderBy("p.position").orderBy("p.id").execute(),
    db.selectFrom("chore_recipes as r").innerJoin("chore_task_recipes as l", "l.recipe_id", "r.id").select(["r.name", "r.dosage", "r.used_for"]).where("l.task_id", "=", taskId).orderBy("r.position").orderBy("r.id").execute(),
    db.selectFrom("chore_fabric_settings").select(["fabric", "iron_points", "max_temperature_c", "advice"]).where("task_id", "=", taskId).orderBy("position").orderBy("id").execute(),
    db.selectFrom("chore_bins").select(["id", "name", "contents", "collection_hint", "task_title"]).where("task_id", "=", taskId).orderBy("position").orderBy("id").execute(),
    db.selectFrom("chore_household_bins").select(["bin_id", "collection_day", sql<string>`due_time::text`.as("due_time")]).where("account_id", "=", accountId).where("task_id", "=", taskId).execute(),
  ]);
  const members = await loadMembers(ctx.db, accountId);
  const collection = t.schedule_mode === "day_before_collection";
  return {
    taskId: t.id,
    name: t.name,
    minutes: t.suggested_minutes,
    mode: t.schedule_mode,
    days: [...(h?.weekdays ?? [])],
    person: h?.member_id ? (members.get(h.member_id)?.firstName ?? null) : null,
    bins: bins.map((b) => ({ binId: b.id, name: b.name, contents: b.contents, hint: b.collection_hint, taskTitle: b.task_title, collectionDay: myBins.find((x) => x.bin_id === b.id)?.collection_day ?? null })),
    binTime: collection ? (time5(myBins[0]?.due_time) ?? DEFAULT_BIN_TIME) : null,
    neverDo: never.map((n) => n.body),
    intro: notes.filter((n) => n.kind === "intro").map((n) => n.body),
    gestures: gestures.map((g) => ({ name: g.name, product: g.product, minutes: g.minutes, steps: [...g.steps] })),
    notes: notes.filter((n) => n.kind === "other").map((n) => ({ title: n.title, body: n.body })),
    troubleshooting: trouble.length ? [...trouble.map((x) => ({ problem: x.problem, solution: x.solution })), ...(closing ? [closing] : [])] : [],
    before: collection
      ? null
      : {
          rules: rules.map((r) => ({ title: r.title, body: r.body })),
          materials: materials.map((m) => ({ name: m.name, detail: m.detail })),
          products: products.map((p) => ({ name: p.name, usedFor: p.used_for, avoidOn: p.avoid_on, optional: p.is_optional })),
          recipes: recipes.map((r) => ({ name: r.name, dosage: r.dosage, usedFor: r.used_for })),
          steps: notes.filter((n) => n.kind === "before_start").map((n) => n.body),
          fabrics: fabrics.map((f) => ({ fabric: f.fabric, points: f.iron_points, temperature: f.max_temperature_c, advice: f.advice })),
        },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Titre et lien des tâches ménagères dans l'écran Tâches
// ---------------------------------------------------------------------------------------------------------------------------

export interface ChoreRef {
  taskId: number;
  binId: number | null;
  title: string;
}

/** Titre de chaque série ménagère, lu dans le catalogue : le nom de la tâche, ou le titre du bac (« Sortir le bac jaune »). */
export async function choreRefsOfSeries(db: Db, seriesIds: string[]): Promise<Map<string, ChoreRef>> {
  const out = new Map<string, ChoreRef>();
  if (!seriesIds.length) return out;
  const rows = await db
    .selectFrom("family_task_series as s")
    .innerJoin("chore_tasks as t", "t.id", "s.chore_task_id")
    .leftJoin("chore_bins as b", "b.id", "s.chore_bin_id")
    .select(["s.id", "s.chore_task_id", "s.chore_bin_id", "t.name", "b.task_title"])
    .where("s.id", "in", seriesIds)
    .execute();
  for (const r of rows) out.set(r.id, { taskId: r.chore_task_id!, binId: r.chore_bin_id, title: r.task_title ?? r.name });
  return out;
}
