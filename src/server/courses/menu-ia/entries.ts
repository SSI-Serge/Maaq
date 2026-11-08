import type { Kysely } from "kysely";
import type { DB } from "@/server/db/schema.generated";
import { fmtMin, type Dish } from "../engine";
import type { LightVersion } from "../engine";

/**
 * Lignes d'un menu validé qui sont des plats libres (origine « ai ») : leurs ingrédients, leur version allégée proposée par l'IA et le déroulé de la séance rendus à la page Liste de
 * courses (US-157, CR-46, CR-47). Un plat libre a pour identifiant « AI:<ligne> » dans le moteur de liste.
 */

export const aiDishId = (entryId: string | number) => `AI:${entryId}`;

export interface MenuEntryRow {
  id: string;
  kind: "dinner" | "express" | "pleasure";
  slot: number;
  dish_name: string;
  dish_origin: "catalog" | "household" | "ai";
  cuisine_id: number | null;
  recipe: string | null;
  duration_minutes: number | null;
  light_by_ai: boolean;
  light_text: string | null;
  light_chosen: boolean;
}

export async function loadMenuEntries(db: Kysely<DB>, menuId: string): Promise<(MenuEntryRow & { dish_id: string | null; household_dish_id: string | null })[]> {
  const rows = await db
    .selectFrom("meal_menu_entries")
    .select(["id", "kind", "slot", "dish_name", "dish_origin", "dish_id", "household_dish_id", "cuisine_id", "recipe", "duration_minutes", "light_by_ai", "light_text", "light_chosen"])
    .where("menu_id", "=", menuId)
    .orderBy("kind")
    .orderBy("slot")
    .execute();
  return rows.map((r) => ({ ...r, id: String(r.id), dish_id: r.dish_id === null ? null : String(r.dish_id) }));
}

/** Plats libres du menu, au format du moteur, avec leur version allégée. */
export async function loadAiDishes(db: Kysely<DB>, entries: MenuEntryRow[]): Promise<{ dishes: Map<string, Dish>; light: Map<string, LightVersion>; chosenLight: Set<string> }> {
  const ai = entries.filter((e) => e.dish_origin === "ai");
  const dishes = new Map<string, Dish>();
  const light = new Map<string, LightVersion>();
  const chosenLight = new Set<string>();
  if (!ai.length) return { dishes, light, chosenLight };
  const ids = ai.map((e) => e.id);
  const [cuisines, ingredients, items] = await Promise.all([
    db.selectFrom("meal_cuisines").select(["id", "name"]).execute(),
    db.selectFrom("meal_menu_entry_ingredients").select(["entry_id", "label"]).where("entry_id", "in", ids as never[]).orderBy("entry_id").orderBy("position").execute(),
    db
      .selectFrom("meal_menu_entry_light_items as i")
      .leftJoin("grocery_products as p", "p.id", "i.product_id")
      .select(["i.entry_id", "i.kind", "i.label", "p.name as product"])
      .where("i.entry_id", "in", ids as never[])
      .orderBy("i.id")
      .execute(),
  ]);
  const cuisineName = new Map(cuisines.map((c) => [c.id, c.name]));
  for (const e of ai) {
    const id = aiDishId(e.id);
    const ing = ingredients.filter((i) => String(i.entry_id) === e.id).map((i) => i.label);
    const minutes = e.duration_minutes ?? 30;
    dishes.set(id, { id, cuisine: cuisineName.get(e.cuisine_id ?? 0) ?? "", name: e.dish_name, ing: ing.join(", "), recipe: e.recipe ?? "", health: "", batch: "", time: fmtMin(minutes), minutes, tags: new Set() });
    if (e.light_by_ai && e.light_text) {
      const mine = items.filter((i) => String(i.entry_id) === e.id);
      light.set(id, { dishId: id, text: e.light_text, remove: mine.filter((i) => i.kind === "remove").map((i) => i.product ?? i.label), add: mine.filter((i) => i.kind === "add").map((i) => i.product ?? i.label) });
      if (e.light_chosen) chosenLight.add(e.dish_name);
    }
  }
  return { dishes, light, chosenLight };
}

/** Recette en texte → étapes : une par ligne ou par « 1. », sans la numérotation. */
export function recipeSteps(recipe: string): string[] {
  return recipe
    .split(/\r?\n+|(?<=[.!?])\s+(?=\d+\s*[.)]\s)/)
    .map((s) => s.replace(/^\s*\d+\s*[.)]\s*/, "").trim())
    .filter(Boolean);
}

const WEEKDAYS = ["", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];

export interface SessionView {
  /** Étapes du déroulé dans l'ordre (sans les étapes de conservation) ; avec une semaine type, les lignes du planning. */
  steps: { position: number; text: string; dish: string | null; minutes: number | null; overlap: string | null }[];
  /** Conservation de chaque plat : réfrigérateur ou congélateur, et quand le sortir. */
  storage: { dish: string; how: string }[];
  /** Au moins deux étapes se font en même temps. */
  overlapping: boolean;
}

/** Déroulé de la séance de batch d'un menu validé (CR-47) : celui rédigé par l'IA, ou celui du planning pour une semaine type. */
export async function loadSession(db: Kysely<DB>, menu: { id: string; batch_week_id: string | number | null }, dishNames: Map<string, string>): Promise<SessionView> {
  if (menu.batch_week_id !== null) {
    const week = await db.selectFrom("meal_batch_weeks").select("session_text").where("id", "=", menu.batch_week_id as never).executeTakeFirst();
    const lines = (week?.session_text ?? "").split("\n").map((s) => s.trim()).filter(Boolean);
    return { steps: lines.map((text, i) => ({ position: i + 1, text, dish: null, minutes: null, overlap: null })), storage: [], overlapping: false };
  }
  const rows = await db.selectFrom("meal_menu_session_steps").selectAll().where("menu_id", "=", menu.id).orderBy("position").execute();
  const nameOf = (entryId: string | number | null) => (entryId === null ? null : (dishNames.get(String(entryId)) ?? null));
  const byPosition = new Map(rows.map((r) => [r.position, r]));
  const steps = rows
    .filter((r) => !r.storage_mode)
    .map((r) => {
      const target = r.overlaps_position ? byPosition.get(r.overlaps_position) : undefined;
      const overlap = target ? `En même temps que l'étape ${target.position}${nameOf(target.entry_id) ? ` (${nameOf(target.entry_id)})` : ""}` : null;
      return { position: r.position, text: r.body, dish: nameOf(r.entry_id), minutes: r.duration_minutes, overlap };
    });
  const storage = rows
    .filter((r) => r.storage_mode)
    .map((r) => ({ dish: nameOf(r.entry_id) ?? r.body, how: `${r.storage_mode === "freezer" ? "Congélateur" : "Réfrigérateur"}${r.take_out_day ? `, à sortir ${r.storage_mode === "freezer" ? "le" : "pour"} ${WEEKDAYS[r.take_out_day]}` : ""}` }));
  return { steps, storage, overlapping: rows.some((r) => r.overlaps_position !== null) };
}
