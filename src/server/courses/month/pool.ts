import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { DB } from "@/server/db/schema.generated";
import { norm } from "../engine";
import type { SettingsView } from "../household/settings";
import { INPUT_OF_UNIT, resolveDish, type ProposalContext, type ProposalDish } from "../menu-ia/proposal";
import type { EngineData } from "../menu/data";
import type { SeasonCandidate } from "../season/base";
import { seasonToProposalDish } from "../season/base";
import { productOf, poolDishOf, type Book } from "./pricing";
import type { PoolDish } from "./solver";

/**
 * Plats utilisables pour le menu du mois (CR-59, US-178 RF3) : les plats des menus validés du foyer (avec leur recette et leurs quantités enregistrées, ramenées au nombre de personnes actuel), les plats de
 * saison de sa sélection du mois (base commune) ; un plat de « Mes plats » jamais servi n'est pas utilisé (pas de quantités). Régimes et allergies, répétition : un plat servi dans les semaines de répétition
 * autour de la première semaine n'est pas proposé.
 */

export interface PoolEntry {
  dish: ProposalDish;
  express: boolean;
  source: "history" | "season";
}

export interface PoolResult {
  entries: PoolEntry[];
  /** Plats de « Mes plats » jamais servis dans un menu : non proposés. */
  unusedOwn: number;
}

export const EXPRESS_MINUTES = 20;

export async function historyPool(db: Kysely<DB>, accountId: string, settings: SettingsView, data: EngineData, ctx: ProposalContext, startWeek: string): Promise<{ entries: PoolEntry[]; servedNames: Set<string> }> {
  const rows = await db
    .selectFrom("meal_menu_entries as e")
    .innerJoin("meal_menus as m", "m.id", "e.menu_id")
    .select(["e.id", "e.kind", "e.dish_name", "e.dish_origin", "e.dish_id", "e.household_dish_id", "e.cuisine_id", "e.recipe", "e.duration_minutes", "m.servings", "m.week_start"])
    .where("e.account_id", "=", accountId)
    .where("e.kind", "in", ["dinner", "express"])
    .orderBy("m.week_start", "desc")
    .execute();
  const ingredients = rows.length ? await db.selectFrom("meal_menu_entry_ingredients").select(["entry_id", "label", "quantity", "unit"]).where("entry_id", "in", rows.map((r) => r.id) as never[]).orderBy("position").execute() : [];
  const byEntry = new Map<string, typeof ingredients>();
  for (const i of ingredients) byEntry.set(String(i.entry_id), [...(byEntry.get(String(i.entry_id)) ?? []), i]);
  const cuisineName = new Map(ctx.cuisines.map((c) => [c.id, c.name]));
  const entries: PoolEntry[] = [];
  const served = new Set<string>();
  const seen = new Set<string>();
  const size = settings.householdSize;
  for (const r of rows) {
    const key = norm(r.dish_name);
    served.add(key);
    if (seen.has(key)) continue;
    seen.add(key);
    const lines = byEntry.get(String(r.id)) ?? [];
    const factor = size && r.servings ? size / r.servings : 1;
    const known = r.household_dish_id ? `H:${r.household_dish_id}` : r.dish_id ? ([...data.refs].find(([, ref]) => ref.kind === "catalog" && ref.dishId === String(r.dish_id))?.[0] ?? null) : null;
    const input = {
      ...(known ? { plat_id: known } : {}),
      nom: r.dish_name,
      cuisine: cuisineName.get(r.cuisine_id ?? 0) ?? undefined,
      duree_minutes: r.duration_minutes ?? undefined,
      recette: r.recipe ?? undefined,
      ingredients: lines.map((l) => {
        if (l.quantity === null || !l.unit || !(l.unit in INPUT_OF_UNIT)) return { nom: l.label };
        const scaled = Number(l.quantity) * factor;
        const amount = l.unit === "piece" ? Math.max(0.5, Math.round(scaled * 2) / 2) : l.unit === "spoon" || l.unit === "pinch" ? Math.max(1, Math.round(scaled)) : scaled >= 100 ? Math.round(scaled / 10) * 10 : Math.round(scaled * 10) / 10;
        return { nom: l.label, quantite: amount, unite: INPUT_OF_UNIT[l.unit] as never };
      }),
    };
    const errors: string[] = [];
    const dish = resolveDish(input as never, ctx, startWeek, errors, "Plat");
    if (!dish || dish.blockers.length) continue;
    // un plat libre avec une allergie soupçonnée n'est pas proposé ; un plat servi dans les semaines de répétition non plus
    if (dish.origin === "ai" && dish.warnings.length) continue;
    if (dish.servedOn) continue;
    entries.push({ dish, express: r.kind === "express" || dish.minutes <= EXPRESS_MINUTES, source: "history" });
  }
  return { entries, servedNames: served };
}

export async function buildPool(db: Kysely<DB>, accountId: string, settings: SettingsView, data: EngineData, ctx: ProposalContext, startWeek: string, season: SeasonCandidate[]): Promise<PoolResult> {
  const { entries, servedNames } = await historyPool(db, accountId, settings, data, ctx, startWeek);
  const names = new Set(entries.map((e) => norm(e.dish.name)));
  const out = [...entries];
  for (const c of season) {
    const dish = seasonToProposalDish(c, ctx, startWeek);
    if (!dish || dish.blockers.length || dish.warnings.length || names.has(norm(dish.name)) || servedNames.has(norm(dish.name))) continue;
    names.add(norm(dish.name));
    out.push({ dish, express: dish.minutes <= EXPRESS_MINUTES, source: "season" });
  }
  const unusedOwn = data.dishes.filter((d) => d.mine && !servedNames.has(norm(d.name))).length;
  return { entries: out, unusedOwn };
}

/** Les plats du réservoir vus par le solveur, avec le plat affichable de chacun. */
export function poolForSolver(entries: PoolEntry[], book: Book): { pool: PoolDish[]; byKey: Map<string, ProposalDish> } {
  const byKey = new Map<string, ProposalDish>();
  const pool = entries.map((e) => {
    const p = poolDishOf(e.dish, book.prods, e.express);
    byKey.set(p.key, e.dish);
    return p;
  });
  return { pool, byKey };
}

/** Noms de tous les produits du catalogue que les plats utilisent (pour charger les tarifs une seule fois). */
export function productsOfEntries(entries: PoolEntry[], prods: Book["prods"]): string[] {
  return [...new Set(entries.flatMap((e) => e.dish.ingredients.map((i) => productOf(prods, i.label)).filter((p): p is string => !!p)))];
}

export const newId = randomUUID;
