import { allowed, deriveDishTags, estimateMinutes, has, norm, type Dish, type Profile } from "../engine";
import type { EngineData } from "../menu/data";
import { resolveWeek, weekLabel } from "../menu/service";
import { DINNER_COUNT, type DishInput, type MenuInput } from "./contract";

/**
 * Du menu rendu par l'IA au menu que MAAQ montre et enregistre (US-156 RF3 à RF8) : chaque plat est rapproché de « Mes plats » et du catalogue (étiquettes, allergènes), sinon il est
 * libre ; MAAQ contrôle les répétitions, les allergies, la cohérence du déroulé et calcule lui-même la durée de la séance (CR-47). Les erreurs sont écrites pour le modèle, qui corrige.
 */

export type DishOrigin = "catalog" | "household" | "ai";

export interface ProposalDish {
  name: string;
  origin: DishOrigin;
  /** Identifiant du moteur : code du catalogue ou « H:<uuid> » ; vide pour un plat libre. */
  engineId: string | null;
  cuisine: string;
  cuisineId: number | null;
  minutes: number;
  recipe: string;
  ingredients: string[];
  /** Version allégée proposée par l'IA (un plat du catalogue garde la sienne). */
  light: { text: string; remove: string[]; add: string[] } | null;
  /** « Contient peut-être … » : avertissement par mots-clés sur un plat libre, sans blocage (CR-44). */
  warnings: string[];
  /** Conflit d'allergie ou de régime sur un plat connu : bloque la validation. */
  blockers: string[];
  /** « 14/10 » : jour où ce plat a déjà été servi dans les semaines récentes ; on peut le garder. */
  servedOn: string | null;
}

export interface ProposalStep {
  position: number;
  text: string;
  dish: string | null;
  minutes: number | null;
  overlaps: number | null;
  storage: "fridge" | "freezer" | null;
  takeOutDay: number | null;
}

export interface ProposalSession {
  minutes: number;
  /** Faux seulement avec une semaine type : la durée est alors celle du planning. */
  estimated: boolean;
  overCap: boolean;
  cap: number;
  source: "plan" | "steps" | "formula";
}

export interface MenuProposal {
  id: string;
  week: string;
  weekLabel: string;
  dinners: ProposalDish[];
  express: ProposalDish[];
  /** Sept dîners : sans cela, pas de bouton « Valider le menu ». */
  complete: boolean;
  /** Code de la semaine type reprise, ou vide. */
  planId: string | null;
  /** Déroulé de la séance rédigé par l'IA (sans semaine type) ; avec une semaine type, celui du planning. */
  steps: ProposalStep[];
  planSteps: string[];
  session: ProposalSession;
  /** Au moins un plat libre : rappel « Vérifiez les allergies » (CR-44). */
  freeDishes: boolean;
  /** Au moins un conflit d'allergie : validation impossible. */
  blocked: boolean;
}

export interface ProposalContext {
  data: EngineData;
  cuisines: { id: number; name: string }[];
  now: Date;
  newId: () => string;
}

const dayText = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const ingredientList = (text: string): string[] => text.split(",").map((s) => s.trim()).filter(Boolean);

/** Allergies du foyer retrouvées par mots dans le nom et les ingrédients : pour un avertissement, jamais une certitude. */
export function suspectedAllergies(dish: Pick<Dish, "name" | "ing" | "tags">, profile: Pick<Profile, "allergies" | "regimes">): string[] {
  const t = norm(`${dish.name} ${dish.ing}`);
  const found = profile.allergies.map((a) => a.trim()).filter((a) => a && has(norm(a), t));
  const regimes = norm(profile.regimes.join(","));
  if (regimes.includes("vegetarien") && !dish.tags.has("vegetarien")) found.push("viande ou poisson");
  if (regimes.includes("gluten") && !dish.tags.has("sans gluten")) found.push("gluten");
  return found;
}

function matchKnown(input: DishInput, data: EngineData): Dish | null {
  if (input.plat_id) {
    const byId = data.dishes.find((d) => d.id === input.plat_id);
    if (byId) return byId;
  }
  const key = norm(input.nom);
  const same = data.dishes.filter((d) => norm(d.name) === key);
  return same.find((d) => d.mine) ?? same[0] ?? null;
}

function resolveDish(input: DishInput, ctx: ProposalContext, week: string, errors: string[], where: string): ProposalDish | null {
  const { data } = ctx;
  const known = matchKnown(input, data);
  if (known) {
    const refs = data.refs.get(known.id);
    const conflicts = data.allergenBlocked.has(known.id) || !allowed(known, data.profile);
    const suspects = suspectedAllergies(known, data.profile);
    return {
      name: known.name,
      origin: refs?.kind === "household" ? "household" : "catalog",
      engineId: known.id,
      cuisine: known.cuisine,
      cuisineId: data.cuisineOf.get(known.id) ?? null,
      minutes: known.minutes,
      recipe: known.recipe,
      ingredients: ingredientList(known.ing),
      light: null,
      warnings: [],
      blockers: conflicts ? [`Conflit d'allergie ou de régime${suspects.length ? ` (${suspects.join(", ")})` : ""} : ${known.name}`] : [],
      servedOn: servedOn(known.name, week, data),
    };
  }
  // plat libre : tout doit être rendu par le modèle
  const cuisine = ctx.cuisines.find((c) => norm(c.name) === norm(input.cuisine ?? ""));
  const missing: string[] = [];
  if (!cuisine) missing.push(`« cuisine » (une de : ${ctx.cuisines.map((c) => c.name).join(", ")})`);
  if (!input.duree_minutes) missing.push("« duree_minutes »");
  if (!input.recette) missing.push("« recette »");
  if (!input.ingredients?.length) missing.push("« ingredients »");
  if (missing.length) {
    errors.push(`${where} « ${input.nom} » : plat libre incomplet, il manque ${missing.join(", ")}.`);
    return null;
  }
  const ingredients = [...new Map(input.ingredients!.map((i) => [norm(i), i.trim()])).values()];
  const asDish: Dish = { id: "", cuisine: cuisine!.name, name: input.nom, ing: ingredients.join(", "), recipe: input.recette!, health: "", batch: "", time: "", minutes: input.duree_minutes!, tags: deriveDishTags(input.nom, ingredients.join(", ")) };
  const suspects = suspectedAllergies(asDish, data.profile);
  return {
    name: input.nom.trim(),
    origin: "ai",
    engineId: null,
    cuisine: cuisine!.name,
    cuisineId: cuisine!.id,
    minutes: input.duree_minutes!,
    recipe: input.recette!,
    ingredients,
    light: input.version_allegee ? { text: input.version_allegee.texte, remove: input.version_allegee.retirer, add: input.version_allegee.ajouter } : null,
    warnings: suspects.length ? [`Contient peut-être ${suspects.join(", ")}`] : [],
    blockers: [],
    servedOn: servedOn(input.nom, week, data),
  };
}

/** Jour (« 14/10 ») où un plat a déjà été servi dans les semaines de répétition qui précèdent la semaine du menu ; on peut le garder. */
function servedOn(name: string, week: string, data: EngineData): string | null {
  const from = addDays(week, -7 * Math.max(1, data.profile.repetitionWeeks));
  const key = norm(name);
  let latest: string | null = null;
  for (const h of data.history) {
    if (h.week >= week || h.week < from || norm(h.dishName) !== key) continue;
    const day = addDays(h.week, h.slot - 1);
    if (!latest || day > latest) latest = day;
  }
  return latest ? dayText(latest) : null;
}

function resolveSteps(input: MenuInput, dishNames: string[], errors: string[]): ProposalStep[] {
  const steps: ProposalStep[] = [];
  const stored = new Set<string>();
  input.etapes.forEach((s, i) => {
    const position = i + 1;
    const where = `Étape ${position}`;
    let dish: string | null = null;
    if (s.plat) {
      dish = dishNames.find((n) => norm(n) === norm(s.plat!)) ?? null;
      // une étape générale (« préparation ») n'est liée à aucun plat : seul le plat d'une étape de conservation doit exister
      if (!dish && s.conservation) errors.push(`${where} : le plat « ${s.plat} » n'est pas dans le menu.`);
    }
    if (s.en_meme_temps_que !== undefined && s.en_meme_temps_que >= position) errors.push(`${where} : « en_meme_temps_que » doit viser une étape précédente (rang inférieur à ${position}).`);
    if (s.jour_sortie !== undefined && !s.conservation) errors.push(`${where} : « jour_sortie » demande « conservation ».`);
    if (s.conservation) {
      if (!dish) errors.push(`${where} : une étape de conservation désigne un plat du menu (« plat »).`);
      else if (stored.has(norm(dish))) errors.push(`${where} : une seule étape de conservation par plat (« ${dish} »).`);
      else stored.add(norm(dish));
    }
    steps.push({ position, text: s.texte, dish, minutes: s.duree_minutes ?? null, overlaps: s.en_meme_temps_que ?? null, storage: s.conservation === "frigo" ? "fridge" : s.conservation === "congelateur" ? "freezer" : null, takeOutDay: s.jour_sortie ?? null });
  });
  return steps;
}

/** Durée de la séance recalculée par MAAQ à partir des étapes : une étape faite pendant une autre n'allonge pas la séance (CR-47) ; ou null si le déroulé manque ou est incohérent. */
export function minutesFromSteps(steps: ProposalStep[], longestDish: number): number | null {
  const timed = steps.filter((s) => s.minutes !== null);
  if (steps.length < 2 || !timed.length) return null;
  if (steps.some((s) => s.overlaps !== null && s.overlaps >= s.position)) return null;
  const total = steps.filter((s) => s.overlaps === null).reduce((sum, s) => sum + (s.minutes ?? 0), 0);
  // une séance ne peut pas être plus courte que son plat le plus long
  return total >= longestDish ? total : null;
}

export type BuildResult = { ok: true; proposal: MenuProposal } | { ok: false; errors: string[] };

export function buildProposal(input: MenuInput, ctx: ProposalContext): BuildResult {
  const errors: string[] = [];
  let week: string;
  try {
    week = resolveWeek(input.semaine, ctx.now);
  } catch (error) {
    return { ok: false, errors: [(error as Error).message] };
  }
  if (new Date(`${week}T12:00:00Z`).getUTCDay() !== 1) return { ok: false, errors: ["« semaine » doit être un lundi."] };
  const resolve = (items: DishInput[], label: string) => items.map((d, i) => resolveDish(d, ctx, week, errors, `${label} ${i + 1}`));
  const dinners = resolve(input.diners, "Dîner");
  const express = resolve(input.express, "Plat express");
  const all = [...dinners, ...express].filter((d): d is ProposalDish => !!d);
  const names = all.map((d) => norm(d.name));
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) errors.push(`Un plat est proposé deux fois : « ${all.find((d) => norm(d.name) === dup)!.name} ». Chaque plat du menu doit être différent.`);
  const steps = resolveSteps(input, all.map((d) => d.name), errors);
  if (errors.length) return { ok: false, errors };

  const days = dinners as ProposalDish[];
  const sessionDishes = days.slice(0, 5);
  const plan = input.semaine_type ? ctx.data.plans.find((p) => p.id === input.semaine_type) : undefined;
  const planMatches = !!plan && sessionDishes.length === 5 && sessionDishes.every((d, i) => (plan.ids[i] && d.engineId === plan.ids[i]) || norm(d.name) === norm(plan.days[i]));
  const cap = ctx.data.sessionCap;
  let session: ProposalSession;
  if (plan && planMatches) session = { minutes: plan.total, estimated: false, overCap: plan.total > cap, cap, source: "plan" };
  else {
    const fromSteps = minutesFromSteps(steps, Math.max(0, ...sessionDishes.map((d) => d.minutes)));
    const minutes = fromSteps ?? Math.round(estimateMinutes(sessionDishes));
    session = { minutes, estimated: true, overCap: minutes > cap, cap, source: fromSteps !== null ? "steps" : "formula" };
  }

  const proposal: MenuProposal = {
    id: ctx.newId(),
    week,
    weekLabel: weekLabel(week),
    dinners: days,
    express: express as ProposalDish[],
    complete: days.length === DINNER_COUNT,
    planId: plan && planMatches ? plan.id : null,
    steps: plan && planMatches ? [] : steps,
    planSteps: plan && planMatches ? plan.steps : [],
    session,
    freeDishes: all.some((d) => d.origin === "ai"),
    blocked: all.some((d) => d.blockers.length > 0),
  };
  return { ok: true, proposal };
}

