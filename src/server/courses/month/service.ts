import { createHash, randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { AssistantModel } from "@/server/assistant/model";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { decrypt, encrypt } from "@/server/security/crypto";
import { integerSetting } from "@/server/settings";
import { estimateMinutes, norm, nextMonday } from "../engine";
import { courseError, loadSettings, requireAccess, translateCourseError, type SettingsView } from "../household/settings";
import { addDaysIso, checkWeek, mondayIso } from "../list/weeks";
import { loadEngineData, type EngineData } from "../menu/data";
import { MONTH_PREFIX } from "../menu-ia/cards";
import { DINNER_COUNT } from "../menu-ia/contract";
import { optionsForProposal, replaceInProposal, type ReplaceChoice, type ReplaceKind, type ReplaceOptions } from "../menu-ia/replace";
import { addableDishes } from "../menu-ia/cards";
import { saveValidatedMenu } from "../menu-ia/validate";
import { weekLabel } from "../menu/weeks";
import type { MenuProposal, ProposalContext, ProposalDish } from "../menu-ia/proposal";
import { findSeasonDishes, seenSeasonDishes, type SeasonCandidate } from "../season/base";
import { gatherSeasonDishes, monthStart, registerMenuRequest } from "../season";
import { buildPool, historyPool, productsOfEntries, poolForSolver, type PoolEntry } from "./pool";
import { loadBook, poolDishOf, type Book } from "./pricing";
import { costOf, mostExpensive, solve, type PoolDish, type Solution } from "./solver";
import { applyBundles, loadBundles, type WeekReuse } from "./reuse";
import { nameKey } from "../catalog/seed";
import { buildRefProducts } from "../engine";
import { draftSteps } from "../menu-ia/steps";
import { minutesFromSteps } from "../menu-ia/proposal";
import { loadReferences } from "../list/data";

/**
 * Menu du mois dans le budget (CR-59, CR-60, CR-62, CR-63, US-178) : MAAQ compose 4 semaines consécutives (7 dîners et 4 plats express) à partir de l'historique du foyer, des plats de saison et de ses prix, et
 * les compare au budget mensuel. Sans IA pour le calcul ; seule la recherche de plats de saison manquants fait appel à l'IA (comptée 1 dans la limite, interrupteur MENU_IA). La proposition est gardée côté
 * serveur, chiffrée, dans le fil du profil (4 jours) : « Valider les 4 menus » valide exactement ce qui est affiché.
 */

export const MIN_MENUS = 6;
export const WEEKS = 4;
const key = () => Buffer.from(env().ENCRYPTION_KEY, "base64");

export interface MonthWeek {
  week: string;
  weekLabel: string;
  proposal: MenuProposal;
  cost: number;
}

export interface MonthEnvelope {
  card: "month";
  id: string;
  startWeek: string;
  weeks: MonthWeek[];
  total: number;
  budget: number;
  /** Dépassement du budget (euros) ; vide quand le total tient dans le budget. */
  overBy: number | null;
  /** Les 3 plats qui coûtent le plus (hors budget). */
  expensive: { name: string; cost: number }[];
  /** Produits sans prix connu dans le chiffrage. */
  unpricedProducts: number;
  variant: number;
  /** Plats déjà proposés par les variantes précédentes (« Autre proposition »). */
  shown: string[];
  notes: {
    /** « 3 de vos plats n'ont jamais été dans un menu : ils ne sont pas proposés. » */
    unusedOwn: number;
    /** « Plats de saison indisponibles : menu calculé avec vos plats. » */
    seasonUnavailable: boolean;
    seasonAsked: boolean;
    /** « Pas assez de plats pour 4 semaines : 2 dîners restent à choisir. » */
    missingDinners: number;
    sharing: boolean;
  };
  status: "open" | "validated";
  validated: string[];
}

export interface MonthView extends Omit<MonthEnvelope, "shown"> {
  messageId: string;
  /** Semaines de la proposition qui ont déjà un menu validé : « Remplacer » ou « Garder le menu existant ». */
  existing: string[];
}

export interface MonthStatus {
  menus: number;
  tickets: number;
  budget: number | null;
  /** Au moins 6 menus validés (CR-63). */
  ready: boolean;
  card: MonthView | null;
  /** Les plats de saison peuvent être demandés à l'IA (MENU_IA ouvert). */
  seasonIa: boolean;
}

const asView = (messageId: string, e: MonthEnvelope, existing: string[]): MonthView => {
  const { shown: _shown, ...rest } = e;
  void _shown;
  return { ...rest, messageId, existing };
};

const seedOf = (text: string) => createHash("sha256").update(text).digest().readUInt32BE(0);

async function existingWeeks(db: Kysely<DB>, accountId: string, weeks: string[]): Promise<string[]> {
  const rows = await db.selectFrom("meal_menus").select("week_start").where("account_id", "=", accountId).where("week_start", "in", weeks as never[]).execute();
  return rows.map((r) => (typeof r.week_start === "string" ? (r.week_start as string).slice(0, 10) : `${(r.week_start as Date).getFullYear()}-${String((r.week_start as Date).getMonth() + 1).padStart(2, "0")}-${String((r.week_start as Date).getDate()).padStart(2, "0")}`));
}

export async function countMenusAndTickets(db: Kysely<DB>, accountId: string): Promise<{ menus: number; tickets: number }> {
  const [m, t] = await Promise.all([
    db.selectFrom("meal_menus").select((eb) => eb.fn.countAll<string>().as("n")).where("account_id", "=", accountId).executeTakeFirstOrThrow(),
    db.selectFrom("grocery_receipts").select((eb) => eb.fn.countAll<string>().as("n")).where("account_id", "=", accountId).executeTakeFirstOrThrow(),
  ]);
  return { menus: Number(m.n), tickets: Number(t.n) };
}

async function conversationId(db: Kysely<DB>, userId: string): Promise<string | null> {
  const { courseAgentId } = await import("../chat/service");
  const row = await db.selectFrom("agent_conversations").select("id").where("user_id", "=", userId).where("agent_id", "=", await courseAgentId(db)).executeTakeFirst();
  return row?.id ?? null;
}

function parseMonth(text: string): MonthEnvelope | null {
  if (!text.startsWith(MONTH_PREFIX)) return null;
  try {
    const parsed = JSON.parse(text) as MonthEnvelope;
    return parsed.card === "month" && parsed.id ? parsed : null;
  } catch {
    return null;
  }
}

async function loadMonth(db: Kysely<DB>, userId: string, messageId: string): Promise<{ id: string; envelope: MonthEnvelope } | null> {
  if (!/^\d{1,18}$/.test(messageId)) return null;
  const row = await db
    .selectFrom("agent_conversation_messages as m")
    .innerJoin("agent_conversations as c", "c.id", "m.conversation_id")
    .select(["m.id", "m.content"])
    .where("m.id", "=", messageId as never)
    .where("c.user_id", "=", userId)
    .where("m.content", "is not", null)
    .executeTakeFirst();
  const envelope = row?.content ? parseMonth(decrypt(row.content, key())) : null;
  return row && envelope ? { id: String(row.id), envelope } : null;
}

async function latestMonth(db: Kysely<DB>, userId: string, since: Date): Promise<{ id: string; envelope: MonthEnvelope } | null> {
  const conversation = await conversationId(db, userId);
  if (!conversation) return null;
  const rows = await db.selectFrom("agent_conversation_messages").select(["id", "content"]).where("conversation_id", "=", conversation).where("created_at", ">=", since).where("content", "is not", null).orderBy("created_at", "desc").orderBy("id", "desc").limit(40).execute();
  for (const r of rows) {
    const envelope = parseMonth(decrypt(r.content!, key()));
    if (envelope) return { id: String(r.id), envelope };
  }
  return null;
}

async function saveMonth(db: Kysely<DB>, messageId: string, envelope: MonthEnvelope): Promise<void> {
  await db.updateTable("agent_conversation_messages").set({ content: encrypt(JSON.stringify(envelope), key()) }).where("id", "=", messageId as never).execute();
}

/** Ce que l'accueil et la page du menu du mois savent : nombre de menus validés et de tickets (CR-63), budget, dernière proposition. */
export async function monthStatus(ctx: Ctx, session: SessionContext): Promise<MonthStatus> {
  const who = await requireAccess(ctx, session, "couple");
  const [counts, settings, last] = await Promise.all([countMenusAndTickets(ctx.db, who.accountId), loadSettings(ctx.db, who.accountId), latestMonth(ctx.db, who.userId, new Date(ctx.now.getTime() - 4 * 86_400_000))]);
  const card = last && last.envelope.status === "open" ? asView(last.id, last.envelope, await existingWeeks(ctx.db, who.accountId, last.envelope.weeks.map((w) => w.week))) : null;
  return { ...counts, budget: settings.monthlyBudget, ready: counts.menus >= MIN_MENUS, card, seasonIa: env().MENU_IA === "live" };
}

/** Proposition d'une semaine : 7 dîners et 4 plats express, durée de la séance estimée par la formule (sans déroulé : « Rédiger le déroulé » reste facultatif après la validation). */
function weekProposal(week: string, dinners: ProposalDish[], express: ProposalDish[], settings: SettingsView, data: EngineData, reuse: WeekReuse = null): MenuProposal {
  const first = dinners.slice(0, 5);
  const minutes = Math.round(estimateMinutes(first));
  const all = [...dinners, ...express];
  const base = weekBase(week, dinners, express, settings, data, all, minutes);
  if (!reuse || first.length < 5) return base;
  const cap = data.sessionCap;
  // US-178 RF9 : la séance correspond à une semaine type ou à une séance déjà faite : son déroulé et sa durée sont repris, sans IA
  if (reuse.kind === "plan") {
    return { ...base, planId: reuse.planId ?? null, planTheme: reuse.theme ?? null, planSteps: reuse.planSteps ?? [], steps: [], reused: "plan", session: { minutes: reuse.minutes, estimated: false, overCap: reuse.minutes > cap, cap, source: "plan" } };
  }
  const nameByKey = new Map(first.map((d) => [nameKey(d.name), d.name]));
  const steps = (reuse.steps ?? []).map((s) => ({ ...s, dish: s.dish ? (nameByKey.get(nameKey(s.dish)) ?? null) : null }));
  const worked = minutesFromSteps(steps, Math.max(0, ...first.map((d) => d.minutes))) ?? reuse.minutes;
  return { ...base, steps, reused: "session", session: { minutes: worked, estimated: true, overCap: worked > cap, cap, source: "steps" } };
}

function weekBase(week: string, dinners: ProposalDish[], express: ProposalDish[], settings: SettingsView, data: EngineData, all: ProposalDish[], minutes: number): MenuProposal {
  return {
    id: randomUUID(),
    week,
    weekLabel: weekLabel(week),
    dinners,
    express,
    complete: dinners.length === DINNER_COUNT,
    planId: null,
    planTheme: null,
    householdSize: settings.householdSize,
    steps: [],
    planSteps: [],
    session: { minutes, estimated: true, overCap: minutes > data.sessionCap, cap: data.sessionCap, source: "formula" },
    freeDishes: all.some((d) => d.origin === "ai"),
    blocked: all.some((d) => d.blockers.length > 0),
    stepsStale: false,
  };
}

export interface ComposeInput {
  /** Lundi de la première semaine ; par défaut la semaine prochaine. */
  startWeek?: string | null;
  /** 0 : première proposition ; « Autre proposition » : numéro suivant. */
  variant?: number;
  /** Carte précédente (« Autre proposition » évite ses plats). */
  previous?: string | null;
  /** « Nouveaux plats de saison » : d'autres plats de saison en plus de la sélection du mois. */
  more?: boolean;
}

export interface MonthDeps {
  model?: AssistantModel;
}

async function ctxOf(db: Kysely<DB>, accountId: string, settings: SettingsView, now: Date): Promise<{ data: EngineData; proposalCtx: ProposalContext }> {
  const [data, cuisines] = await Promise.all([loadEngineData(db, accountId, settings, { all: true }), db.selectFrom("meal_cuisines").select(["id", "name"]).execute()]);
  return { data, proposalCtx: { data, cuisines, householdSize: settings.householdSize, now, newId: randomUUID } };
}

/** Sélection de plats de saison du mois déjà gardée par le foyer (sans rien demander). */
async function selectionOf(ctx: Ctx, accountId: string, settings: SettingsView, data: EngineData): Promise<SeasonCandidate[]> {
  const seen = await seenSeasonDishes(ctx.db, accountId, monthStart(ctx.now));
  return seen.selection.length ? findSeasonDishes(ctx.db, settings, data.profile, monthStart(ctx.now), [], 300, seen.selection) : [];
}

/** Le menu du mois : plats utilisables, chiffrage, résolution, carte rangée dans le fil. */
export async function composeMonth(ctx: Ctx, session: SessionContext, input: ComposeInput = {}, deps: MonthDeps = {}): Promise<MonthView> {
  const who = await requireAccess(ctx, session, "couple");
  const settings = await loadSettings(ctx.db, who.accountId);
  if (settings.monthlyBudget === null) throw courseError("budget_missing", "Renseignez d'abord votre budget mensuel des repas (hors restaurant, boissons et réceptions).", 422);
  const counts = await countMenusAndTickets(ctx.db, who.accountId);
  if (counts.menus < MIN_MENUS) throw courseError("not_ready", `Il faut ${MIN_MENUS} menus validés (vous en avez ${counts.menus}).`, 409);
  const start = checkWeek(input.startWeek ?? addDaysIso(mondayIso(ctx.now), 7), ctx.now) as string;
  checkWeek(addDaysIso(start, 7 * (WEEKS - 1)), ctx.now);
  const variant = input.variant ?? 0;
  const { data, proposalCtx } = await ctxOf(ctx.db, who.accountId, settings, ctx.now);
  const count = await integerSetting(ctx.db, "meal_season_dishes_count", 10);
  const max = await integerSetting(ctx.db, "meal_season_dishes_max", 44);
  const previous = input.previous ? await loadMonth(ctx.db, who.userId, input.previous) : null;
  const avoid = new Set(previous ? previous.envelope.shown : []);

  // 1. plats de saison : sélection du mois (base commune d'abord, IA pour les manquants) ; « Nouveaux plats » en ajoute d'autres
  let seasonAsked = false;
  let seasonUnavailable = false;
  const first = await gatherSeasonDishes(ctx, { accountId: who.accountId, userId: who.userId, settings, profile: data.profile, want: count, more: !!input.more, model: deps.model });
  seasonAsked = first.asked;
  seasonUnavailable = first.unavailable;
  let season = input.more ? await selectionOf(ctx, who.accountId, settings, data) : first.dishes;

  const references = buildRefProducts((await loadReferences(ctx.db)).rows);
  const solveWith = async (candidates: SeasonCandidate[]) => {
    const pool = await buildPool(ctx.db, who.accountId, settings, data, proposalCtx, start, candidates);
    const book = await loadBook(ctx.db, who.accountId, who.userId, settings, productsOfEntries(pool.entries, references), ctx.now);
    const { pool: poolDishes, byKey } = poolForSolver(pool.entries, book);
    const sessionCap = settings.goals.time ? data.sessionCap : null;
    const solved = solve(poolDishes, book.price, {
      weeks: WEEKS,
      dinnersPerWeek: DINNER_COUNT,
      expressPerWeek: 4,
      sessionCap,
      budget: settings.monthlyBudget,
      seed: seedOf(`${who.accountId}|${start}|${variant}`),
      avoid,
      iterations: 25_000,
    });
    // US-178 RF9 : une séance qui correspond à une semaine type ou à une séance déjà faite reprend son déroulé (sans IA)
    const { solution, reuse } = applyBundles(solved, poolDishes, await loadBundles(ctx.db, who.accountId, data), book.price, { budget: settings.monthlyBudget, sessionCap });
    return { solution, byKey, book, unusedOwn: pool.unusedOwn, reuse };
  };
  let run = await solveWith(season);
  // 2. historique trop court : plus de plats de saison, jusqu'au plafond de la console (base commune puis une seule demande à l'IA, par lots)
  if (run.solution.missingDinners > 0 && max > season.length) {
    const more = await gatherSeasonDishes(ctx, { accountId: who.accountId, userId: who.userId, settings, profile: data.profile, want: max, model: deps.model });
    seasonAsked = seasonAsked || more.asked;
    seasonUnavailable = seasonUnavailable || more.unavailable;
    season = more.dishes;
    run = await solveWith(season);
  }
  const envelope = buildEnvelope(who.accountId, start, run.solution, run.byKey, run.book, settings, data, variant, avoid, { unusedOwn: run.unusedOwn, seasonAsked, seasonUnavailable }, run.reuse);
  const conversation = await (await import("../chat/service")).conversationOf(ctx.db, who.accountId, who.userId, ctx.now);
  const row = await ctx.db
    .insertInto("agent_conversation_messages")
    .values({ conversation_id: conversation.id, sender: "agent", kind: "text", content: encrypt(JSON.stringify(envelope), key()), created_at: ctx.now })
    .returning("id")
    .executeTakeFirstOrThrow();
  return asView(String(row.id), envelope, await existingWeeks(ctx.db, who.accountId, envelope.weeks.map((w) => w.week)));
}

function buildEnvelope(accountId: string, start: string, solution: Solution, byKey: Map<string, ProposalDish>, book: Book, settings: SettingsView, data: EngineData, variant: number, avoid: Set<string>, notes: { unusedOwn: number; seasonAsked: boolean; seasonUnavailable: boolean }, reuse: WeekReuse[] = []): MonthEnvelope {
  const budget = settings.monthlyBudget as number;
  const dishOf = (d: PoolDish | null): ProposalDish | null => (d ? (byKey.get(d.key) ?? null) : null);
  const weeks: MonthWeek[] = solution.weeks.map((w, i) => {
    const week = addDaysIso(start, 7 * i);
    return {
      week,
      weekLabel: weekLabel(week),
      proposal: weekProposal(week, w.dinners.map(dishOf).filter((d): d is ProposalDish => !!d), w.express.map(dishOf).filter((d): d is ProposalDish => !!d), settings, data, reuse[i] ?? null),
      cost: solution.weekCosts[i] ?? 0,
    };
  });
  const over = solution.total > budget ? Math.round((solution.total - budget) * 100) / 100 : null;
  const shown = [...avoid, ...solution.weeks.flatMap((w) => [...w.dinners, ...w.express]).filter((d): d is PoolDish => !!d).map((d) => d.key)];
  return {
    card: "month",
    id: randomUUID(),
    startWeek: start,
    weeks,
    total: solution.total,
    budget,
    overBy: over,
    expensive: over !== null ? mostExpensive(solution, book.price, 3).map((d) => ({ name: d.name, cost: d.cost })) : [],
    unpricedProducts: solution.unpricedProducts,
    variant,
    shown: [...new Set(shown)],
    notes: { ...notes, missingDinners: solution.missingDinners, sharing: settings.sharePrices },
    status: "open",
    validated: [],
  };
}

/** Coûts recalculés après un remplacement de plat : mêmes règles que la proposition. */
async function recost(ctx: Ctx, accountId: string, userId: string, settings: SettingsView, envelope: MonthEnvelope): Promise<MonthEnvelope> {
  const references = buildRefProducts((await loadReferences(ctx.db)).rows);
  const dishes = envelope.weeks.flatMap((w) => [...w.proposal.dinners, ...w.proposal.express]);
  const entries: PoolEntry[] = dishes.map((dish) => ({ dish, express: false, source: "history" as const }));
  const book = await loadBook(ctx.db, accountId, userId, settings, productsOfEntries(entries, references), ctx.now);
  const pooled = (list: ProposalDish[]) => list.map((d) => poolDishOf(d, book.prods, false));
  const all = pooled(dishes);
  const total = costOf(all, book.price);
  const alone = envelope.weeks.map((w) => costOf(pooled([...w.proposal.dinners, ...w.proposal.express]), book.price).total);
  const sumAlone = alone.reduce((s, x) => s + x, 0);
  const weeks = envelope.weeks.map((w, i) => ({ ...w, cost: sumAlone > 0 ? Math.round((alone[i] / sumAlone) * total.total * 100) / 100 : 0 }));
  const over = total.total > envelope.budget ? Math.round((total.total - envelope.budget) * 100) / 100 : null;
  const marginal = all.map((d) => ({ name: d.name, cost: Math.round((total.total - costOf(all.filter((x) => x !== d), book.price).total) * 100) / 100 })).sort((a, b) => b.cost - a.cost).slice(0, 3);
  return { ...envelope, weeks, total: total.total, overBy: over, expensive: over !== null ? marginal : [], unpricedProducts: total.unpricedProducts };
}

async function openMonth(ctx: Ctx, session: SessionContext, messageId: string) {
  const who = await requireAccess(ctx, session, "couple");
  const card = await loadMonth(ctx.db, who.userId, messageId);
  if (!card) throw courseError("card_not_found", "Cette proposition n'est plus disponible : composez un nouveau menu du mois.", 404);
  if (card.envelope.status !== "open") throw courseError("already_validated", "Ce menu du mois est déjà validé.", 409);
  return { who, card };
}

const weekOf = (e: MonthEnvelope, week: string) => {
  const w = e.weeks.find((x) => x.week === week);
  if (!w) throw courseError("invalid_week", "Cette semaine n'est pas dans la proposition.", 422);
  return w;
};

export async function monthReplaceOptions(ctx: Ctx, session: SessionContext, input: { messageId: string; week: string; kind: ReplaceKind; index: number }): Promise<ReplaceOptions> {
  const { who, card } = await openMonth(ctx, session, input.messageId);
  const w = weekOf(card.envelope, input.week);
  const others = new Set(card.envelope.weeks.filter((x) => x.week !== input.week).flatMap((x) => [...x.proposal.dinners, ...x.proposal.express].map((d) => norm(d.name))));
  const options = await optionsForProposal(ctx, who.accountId, w.proposal, input.kind, input.index);
  // un plat de Mes plats déjà proposé une autre semaine n'est pas proposé deux fois
  return { ...options, own: options.own.filter((o) => !others.has(norm(o.name))) };
}

/** Remplace un plat d'une semaine du menu du mois, sans IA, puis recalcule les coûts. */
export async function monthReplace(ctx: Ctx, session: SessionContext, input: { messageId: string; week: string; kind: ReplaceKind; index: number; choice: ReplaceChoice }): Promise<MonthView> {
  const { who, card } = await openMonth(ctx, session, input.messageId);
  const settings = await loadSettings(ctx.db, who.accountId);
  const w = weekOf(card.envelope, input.week);
  const replaced = await replaceInProposal(ctx, who.accountId, w.proposal, input.kind, input.index, input.choice);
  // un des cinq dîners de la séance a changé : le déroulé repris (ou rédigé) ne correspond plus, la durée est celle de la formule et « Rédiger le déroulé » redevient proposé
  const next: MenuProposal = replaced.stepsStale ? { ...replaced, steps: [], planSteps: [], stepsStale: false, reused: undefined } : replaced;
  const taken = card.envelope.weeks.filter((x) => x.week !== input.week).flatMap((x) => [...x.proposal.dinners, ...x.proposal.express].map((d) => norm(d.name)));
  if ([...next.dinners, ...next.express].some((d) => taken.includes(norm(d.name)))) throw courseError("duplicate_dish", "Ce plat est déjà dans une autre semaine du mois.", 422);
  const weeks = card.envelope.weeks.map((x) => (x.week === input.week ? { ...x, proposal: next } : x));
  const envelope = await recost(ctx, who.accountId, who.userId, settings, { ...card.envelope, weeks });
  await saveMonth(ctx.db, card.id, envelope);
  return asView(card.id, envelope, await existingWeeks(ctx.db, who.accountId, envelope.weeks.map((x) => x.week)));
}

export interface MonthValidated {
  validated: string[];
  /** Coût des semaines validées (le total est recalculé quand une semaine est gardée ou laissée de côté). */
  total: number;
  kept: string[];
  /** Plats à proposer pour « Ajouter ces plats à vos plats ? », par semaine. */
  addable: { week: string; slot: string; name: string }[];
  /** Semaines à regrouper en une liste du mois (« Regrouper en une liste du mois »). */
  groupWeeks: string[];
}

/** « Valider les 4 menus » : enregistre les menus et leurs listes ; une semaine qui a déjà un menu est remplacée, sauf si elle est gardée (elle sort de la proposition). */
export async function monthValidate(ctx: Ctx, session: SessionContext, input: { messageId: string; keep?: string[] }): Promise<MonthValidated> {
  const { who, card } = await openMonth(ctx, session, input.messageId);
  const e = card.envelope;
  const keep = new Set(input.keep ?? []);
  const settings = await loadSettings(ctx.db, who.accountId);
  const data = await loadEngineData(ctx.db, who.accountId, settings, { all: true });
  const todo = e.weeks.filter((w) => !keep.has(w.week));
  if (!todo.length) throw courseError("nothing_to_validate", "Aucune semaine à valider.", 422);
  for (const w of todo) {
    if (!w.proposal.complete) throw courseError("menu_incomplete", `La semaine du ${w.weekLabel} est incomplète : gardez-la ou complétez-la avant de valider.`, 422);
    if (w.proposal.blocked) throw courseError("allergy_conflict", `Conflit d'allergie ou de régime dans la semaine du ${w.weekLabel} : remplacez le plat avant de valider.`, 422);
  }
  const done: string[] = [];
  try {
    for (const w of todo) {
      await saveValidatedMenu(ctx, who.accountId, who.userId, w.proposal, data);
      done.push(w.week);
    }
  } catch (error) {
    throw translateCourseError(error);
  }
  const rest = await recost(ctx, who.accountId, who.userId, settings, { ...e, weeks: e.weeks.filter((w) => done.includes(w.week)) });
  await saveMonth(ctx.db, card.id, { ...e, status: "validated", validated: done });
  const addable: MonthValidated["addable"] = [];
  for (const week of done) for (const a of await addableDishes(ctx.db, who.accountId, week)) addable.push({ week, ...a });
  return { validated: done, total: rest.total, kept: [...keep], addable, groupWeeks: done.length >= 2 ? done : [] };
}

/**
 * « Rédiger le déroulé » d'une semaine du menu du mois (US-178 RF9) : facultatif, appel IA compté 1 dans la limite de menus, même interrupteur que le menu par l'IA. Si l'IA échoue, rien ne change.
 * Le déroulé et la durée recalculée sont gardés dans la proposition et enregistrés avec le menu à la validation.
 */
export async function monthWriteSteps(ctx: Ctx, session: SessionContext, input: { messageId: string; week: string }, deps: MonthDeps = {}): Promise<MonthView> {
  const { who, card } = await openMonth(ctx, session, input.messageId);
  const w = weekOf(card.envelope, input.week);
  if (w.proposal.dinners.length < 2) throw courseError("not_enough_dishes", "Il faut au moins deux dîners pour rédiger le déroulé.", 422);
  let model = deps.model;
  if (!model) {
    if (env().MENU_IA !== "live") throw courseError("assistant_unavailable", "La rédaction du déroulé n'est pas ouverte.", 409);
    model = (await import("../chat/service")).courseModel();
  }
  if (!(await registerMenuRequest(ctx, who.accountId, who.userId))) throw courseError("limit_reached", "Vous avez atteint la limite de menus pour aujourd'hui : vous pourrez reprendre demain.", 429);
  const first = w.proposal.dinners.slice(0, 5);
  const dishes = first.map((d) => ({ name: d.name, minutes: d.minutes, ingredients: d.ingredients.map((i) => i.label) }));
  const steps = await draftSteps(model, dishes);
  const minutes = steps ? minutesFromSteps(steps, Math.max(0, ...dishes.map((d) => d.minutes))) : null;
  if (!steps || minutes === null) throw courseError("steps_failed", "Je n'ai pas réussi à rédiger le déroulé pour le moment. Vous pouvez réessayer.", 502);
  const proposal: MenuProposal = { ...w.proposal, steps, planId: null, planTheme: null, planSteps: [], reused: undefined, stepsStale: false, session: { ...w.proposal.session, minutes, estimated: true, overCap: minutes > w.proposal.session.cap, source: "steps" } };
  const envelope: MonthEnvelope = { ...card.envelope, weeks: card.envelope.weeks.map((x) => (x.week === input.week ? { ...x, proposal } : x)) };
  await saveMonth(ctx.db, card.id, envelope);
  return asView(card.id, envelope, await existingWeeks(ctx.db, who.accountId, envelope.weeks.map((x) => x.week)));
}

export { checkWeek, nextMonday, historyPool };
