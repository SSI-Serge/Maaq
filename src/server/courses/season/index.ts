import { sql } from "kysely";
import { z } from "zod";
import type { AssistantModel } from "@/server/assistant/model";
import { asProfile } from "@/server/assistant/outings/profile";
import { loadPseudoMembers } from "@/server/assistant/family";
import { Pseudonymizer } from "@/server/assistant/pseudonymize";
import { familyTimeZone } from "@/server/assistant/reminders";
import type { Ctx } from "@/server/auth/service";
import { localDay } from "@/server/chat/service";
import { env } from "@/server/env";
import { integerSetting } from "@/server/settings";
import { norm, plausible, type Profile, type QuantityUnit } from "../engine";
import type { SettingsView } from "../household/settings";
import { INGREDIENT_UNITS } from "../menu-ia/contract";
import { findSeasonDishes, seenSeasonDishes, shareSeasonDishes, type SeasonCandidate, type SeasonDishInput } from "./base";

/**
 * Plats de saison d'un foyer pour son menu du mois (CR-60, CR-61, CR-62, US-178 RF2, RF2bis, RF3) : la sélection du mois est gardée pour le foyer jusqu'à la fin du mois ; MAAQ cherche d'abord dans la base
 * commune, ne demande à l'IA que les plats manquants (par lots de 10 à 12 appelés en parallèle, une seule demande comptée 1 dans la limite de menus) et range ce que l'IA rend dans la base commune.
 * L'IA ne reçoit ni prix, ni enseigne, ni prénom.
 */

const UNIT_OF_INPUT: Record<string, QuantityUnit> = { g: "g", kg: "kg", ml: "ml", cl: "cl", l: "l", piece: "piece", cuillere: "spoon", pincee: "pinch" };
export const LOT_SIZE = 12;

const seasonInput = z.strictObject({
  plats: z
    .array(
      z.strictObject({
        nom: z.string().trim().min(1).max(120),
        cuisine: z.string().trim().min(1).max(60),
        /** Mois de saison du plat (1 = janvier … 12 = décembre). */
        mois: z.array(z.number().int().min(1).max(12)).min(1).max(12),
        /** Étiquettes de régime, prises dans la liste donnée. */
        etiquettes: z.array(z.string().trim().max(80)).max(10).default([]),
        duree_minutes: z.number().int().min(1).max(600),
        recette: z.string().trim().min(1).max(4000),
        ingredients: z.array(z.strictObject({ nom: z.string().trim().min(1).max(120), quantite: z.number().positive().max(100_000).optional(), unite: z.enum(INGREDIENT_UNITS).optional() })).min(1).max(40),
      }),
    )
    .min(1)
    .max(LOT_SIZE),
});

const SEASON_TOOL = {
  name: "proposer_plats_de_saison",
  description: "Rend des plats de saison et bon marché pour le foyer : cuisine, mois de saison, étiquettes de régime, ingrédients avec leurs quantités pour le nombre de personnes du foyer, recette et durée.",
  input_schema: (() => {
    const schema = z.toJSONSchema(seasonInput, { io: "input" }) as Record<string, unknown>;
    delete schema.$schema;
    return schema;
  })(),
} as const;

const SYSTEM = [
  "Tu proposes des plats de saison et bon marché pour un foyer, en appelant l'outil `proposer_plats_de_saison`.",
  "Chaque plat : `nom`, `cuisine` (une de la liste donnée), `mois` de saison (1 à 12), `etiquettes` de régime (seulement parmi celles données, vide si aucune ne s'applique), `duree_minutes`, `recette` et `ingredients` ({ nom, quantite, unite }) avec les quantités pour le NOMBRE DE PERSONNES du foyer.",
  "Écris les ingrédients avec les noms des produits du catalogue quand c'est possible. Respecte les régimes et les allergies du foyer, sans ingrédient caché (sauces, bouillons, panures). Ne répète aucun plat déjà donné.",
  "N'écris ni prix, ni magasin. Réponds uniquement par l'appel de l'outil.",
].join("\n");

export const monthStart = (now: Date) => `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;

/** Une demande comptée dans la limite de menus du jour ; faux si le plafond est atteint. */
export async function registerMenuRequest(ctx: Ctx, accountId: string, userId: string): Promise<boolean> {
  const day = localDay(ctx.now, await familyTimeZone(ctx.db, accountId));
  const row = await asProfile(ctx.db, userId, async (trx) => (await sql<{ ok: boolean }>`select register_meal_menu(${accountId}::uuid, ${day}::date, null) as ok`.execute(trx)).rows[0]);
  return row?.ok === true;
}

export interface SeasonAsk {
  accountId: string;
  settings: SettingsView;
  profile: Pick<Profile, "allergies" | "regimes">;
  month: string;
  /** Plats demandés au total. */
  count: number;
  /** Noms déjà trouvés (pour éviter les doublons). */
  known: string[];
  model: AssistantModel;
}

/** Les plats de saison demandés à l'IA, en lots de 10 à 12 appelés en parallèle ; ce qui est valable est rangé dans la base commune. Un lot en échec n'empêche pas les autres. */
export async function askSeasonDishes(ctx: Ctx, a: SeasonAsk): Promise<{ ids: string[]; lotsFailed: number }> {
  const { db } = ctx;
  const [cuisines, tags, products, members] = await Promise.all([
    db.selectFrom("meal_cuisines").select(["id", "name"]).orderBy("id").execute(),
    db.selectFrom("meal_dish_tags").select(["id", "kind", "name"]).where("kind", "<>", "allergen").where("is_hidden", "=", false).orderBy("name").execute(),
    db.selectFrom("grocery_products").select("name").orderBy("name").execute(),
    loadPseudoMembers(db, a.accountId),
  ]);
  const pseudo = new Pseudonymizer(members);
  const safe = (t: string) => pseudo.toModel(t);
  const preferred = cuisines.filter((c) => a.settings.cuisineIds.includes(c.id));
  const cuisineList = preferred.length ? preferred : cuisines;
  const month = Number(a.month.slice(5, 7));
  const lots: number[] = [];
  for (let left = a.count; left > 0; left -= LOT_SIZE) lots.push(Math.min(LOT_SIZE, left));
  const size = a.settings.householdSize ?? 4;
  const tagByName = new Map(tags.map((t) => [norm(t.name), t.id]));

  const one = async (n: number, avoid: string[]): Promise<string[]> => {
    const content = [
      `<foyer>\nMois : ${month}\nNombre de personnes : ${size}\nCuisines (une de) : ${cuisineList.map((c) => c.name).join(", ")}\nRégimes : ${a.settings.diets.join(", ") || "aucun"}\nAllergies : ${[...a.settings.allergens, ...a.settings.allergyText.split(/[,;\n]/).map((s) => safe(s.trim())).filter(Boolean)].join(", ") || "aucune"}\nÉtiquettes de régime disponibles : ${tags.map((t) => t.name).join(", ")}\nProduits du catalogue : ${products.map((p) => p.name).join(" ; ")}\n</foyer>`,
      `Plats déjà donnés (ne les répète pas) : ${avoid.join(" ; ") || "aucun"}`,
      `Propose ${n} plats de saison et bon marché pour le mois ${month}.`,
    ].join("\n\n");
    const response = await a.model.send({ kind: "menu_mois", system: SYSTEM, tools: [SEASON_TOOL], messages: [{ role: "user", content }] });
    const use = response.content.find((b) => b.type === "tool_use" && b.name === SEASON_TOOL.name);
    const parsed = use && use.type === "tool_use" ? seasonInput.safeParse(use.input) : null;
    if (!parsed?.success) throw new Error("réponse invalide");
    const dishes: SeasonDishInput[] = [];
    for (const p of parsed.data.plats) {
      const cuisine = cuisines.find((c) => norm(c.name) === norm(p.cuisine));
      if (!cuisine) continue;
      const ingredients = p.ingredients.map((i) => {
        const unit = i.unite ? UNIT_OF_INPUT[i.unite] : null;
        const ok = i.quantite !== undefined && unit !== null && plausible(i.quantite, unit, size);
        return { label: i.nom, quantity: ok ? i.quantite! : null, unit: ok ? unit : null };
      });
      dishes.push({ name: p.nom, cuisineId: cuisine.id, servings: size, recipe: p.recette, minutes: p.duree_minutes, months: [...new Set(p.mois)], tagIds: [...new Set(p.etiquettes.map((e) => tagByName.get(norm(e))).filter((x): x is number => x !== undefined))], ingredients });
    }
    return shareSeasonDishes(db, dishes);
  };

  const results = await Promise.allSettled(lots.map((n) => one(n, a.known)));
  const ids: string[] = [];
  let lotsFailed = 0;
  for (const r of results) {
    if (r.status === "fulfilled") ids.push(...r.value);
    else {
      lotsFailed += 1;
      console.error(`[courses] lot de plats de saison en échec : ${r.reason instanceof Error ? r.reason.message : "erreur"}`);
    }
  }
  return { ids: [...new Set(ids)], lotsFailed };
}

export interface SeasonResult {
  /** Plats de saison du foyer pour le mois, dans l'ordre : sélection gardée, puis plats trouvés dans la base, puis plats demandés à l'IA. */
  dishes: SeasonCandidate[];
  /** L'IA a été appelée (une demande comptée). */
  asked: boolean;
  /** L'IA n'a pas pu répondre (limite atteinte, fermée ou en échec) : « Plats de saison indisponibles : menu calculé avec vos plats. » */
  unavailable: boolean;
  /** Nombre de plats manquants après tout (réservoir insuffisant). */
  missing: number;
}

export interface GatherOptions {
  accountId: string;
  userId: string;
  settings: SettingsView;
  profile: Profile;
  /** Plats voulus : 10 (réglage de console) ; jusqu'au plafond total pour compléter un historique trop court (CR-62). */
  want: number;
  /** « Nouveaux plats de saison » : d'autres plats en plus de la sélection du mois. */
  more?: boolean;
  model?: AssistantModel;
}

/** Sélection de plats de saison du foyer pour le mois : sélection gardée → base commune → IA pour les manquants. Rien n'est demandé à l'IA si la base suffit (et rien n'est compté). */
export async function gatherSeasonDishes(ctx: Ctx, o: GatherOptions): Promise<SeasonResult> {
  const { db } = ctx;
  const month = monthStart(ctx.now);
  const max = await integerSetting(db, "meal_season_dishes_max", 44);
  const want = Math.min(Math.max(o.want, 0), max);
  const seen = await seenSeasonDishes(db, o.accountId, month);
  const kept = o.more ? [] : seen.selection;
  const keptCandidates = kept.length ? await findSeasonDishes(db, o.settings, o.profile, month, [], 200, kept) : [];
  const dishes = [...keptCandidates];
  const target = o.more ? seen.selection.length + want : want;
  let need = Math.max(0, (o.more ? want : target) - dishes.length);
  const exclude = [...new Set([...seen.selection, ...seen.inMenus])];
  if (need > 0) {
    const found = await findSeasonDishes(db, o.settings, o.profile, month, exclude, need);
    dishes.push(...found);
    need -= found.length;
  }
  let asked = false;
  let unavailable = false;
  if (need > 0) {
    const live = o.model ?? (env().MENU_IA === "live" ? await liveModel() : null);
    if (!live || !(await registerMenuRequest(ctx, o.accountId, o.userId))) unavailable = true;
    else {
      asked = true;
      const { ids, lotsFailed } = await askSeasonDishes(ctx, { accountId: o.accountId, settings: o.settings, profile: o.profile, month, count: need, known: [...dishes.map((d) => d.name)], model: live });
      if (lotsFailed && !ids.length) unavailable = true;
      const fresh = ids.length ? await findSeasonDishes(db, o.settings, o.profile, month, [...exclude, ...dishes.map((d) => d.id)], need, ids) : [];
      dishes.push(...fresh);
      need -= fresh.length;
    }
  }
  const chosen = dishes.map((d) => d.id).filter((id) => !seen.selection.includes(id));
  if (chosen.length) {
    await asProfile(db, o.userId, async (trx) => {
      await trx
        .insertInto("meal_season_household_dishes")
        .values(chosen.map((id) => ({ account_id: o.accountId, dish_id: id as never, season_month: month as never })))
        .onConflict((oc) => oc.doNothing())
        .execute();
    });
  }
  return { dishes, asked, unavailable, missing: Math.max(0, need) };
}

async function liveModel(): Promise<AssistantModel | null> {
  try {
    const { courseModel } = await import("../chat/service");
    return courseModel();
  } catch {
    return null;
  }
}
