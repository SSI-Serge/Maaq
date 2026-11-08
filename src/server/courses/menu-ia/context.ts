import type { Kysely } from "kysely";
import { loadPseudoMembers } from "@/server/assistant/family";
import { Pseudonymizer } from "@/server/assistant/pseudonymize";
import type { DB } from "@/server/db/schema.generated";
import { norm } from "../engine";
import type { SettingsView } from "../household/settings";
import { loadEngineData, type EngineData } from "../menu/data";

/**
 * Ce que le modèle reçoit pour composer un menu (CR-43, remplace CR-16) : cuisines, objectifs, nombre de personnes, régimes et allergies, « Mes plats » (noms et ingrédients), plats des
 * dernières semaines, mois en cours, semaines types comme modèles, et les noms des produits du catalogue. Jamais un nom ni un prénom (les textes libres passent par la pseudonymisation de
 * l'assistant), ni la ville, les magasins, les prix ou le budget. Ce texte n'est donné qu'au moment où l'agent prépare un menu (outil `preparer_menu`), pas à chaque message.
 */

export const MAX_OWN_DISHES = 150;
const MAX_INGREDIENTS_SHOWN = 15;
const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const GOAL_TEXT: Record<string, string> = { time: "gagner du temps (batch cooking)", ownDishes: "mes plats", season: "plats de saison" };

export interface MenuContext {
  text: string;
  data: EngineData;
  cuisines: { id: number; name: string }[];
  householdSize: number | null;
}

export async function loadMenuContext(db: Kysely<DB>, accountId: string, settings: SettingsView, now: Date): Promise<MenuContext> {
  const [data, cuisines, products, members] = await Promise.all([
    loadEngineData(db, accountId, settings),
    db.selectFrom("meal_cuisines").select(["id", "name"]).orderBy("id").execute(),
    db.selectFrom("grocery_products").select("name").orderBy("name").execute(),
    loadPseudoMembers(db, accountId),
  ]);
  const pseudo = new Pseudonymizer(members);
  const safe = (text: string) => pseudo.toModel(text);
  const { profile } = data;

  const goals = (Object.keys(settings.goals) as (keyof typeof settings.goals)[]).filter((g) => settings.goals[g]).map((g) => GOAL_TEXT[g]);
  const own = data.dishes.filter((d) => d.mine).slice(0, MAX_OWN_DISHES);
  const fromWeek = new Date(now.getTime() - 7 * 86_400_000 * Math.max(1, profile.repetitionWeeks)).toISOString().slice(0, 10);
  const recent = [...new Set(data.history.filter((h) => h.week >= fromWeek).map((h) => h.dishName))];
  const plans = data.plans.map((p) => `- ${p.id} : ${safe(p.theme)} (${p.cuisine}) ; lundi à vendredi : ${p.days.map(safe).join(" / ")} ; séance ${p.total} min`);

  const lines = [
    "<foyer>",
    `Mois en cours : ${MONTHS[now.getMonth()]}`,
    `Nombre de personnes : ${settings.householdSize ?? "non renseigné"} (les recettes sont prévues pour 4)`,
    `Cuisines préférées : ${profile.preferredCuisines.join(", ") || "aucune préférence"}`,
    `Objectifs : ${goals.join(", ") || "aucun"}`,
    `Régimes : ${settings.diets.join(", ") || "aucun"}`,
    `Allergies : ${[...settings.allergens, ...settings.allergyText.split(/[,;\n]/).map((s) => safe(s.trim())).filter(Boolean)].join(", ") || "aucune"}`,
    `Séance de batch : au plus ${data.sessionCap} minutes`,
    `Cuisines du catalogue (pour les plats libres) : ${cuisines.map((c) => c.name).join(", ")}`,
    "",
    `Mes plats (${own.length}) : id | nom | ingrédients`,
    ...(own.length ? own.map((d) => `${d.id} | ${safe(d.name)} | ${safe(d.ing.split(",").slice(0, MAX_INGREDIENTS_SHOWN).join(","))}`) : ["(aucun plat)"]),
    "",
    `Plats servis ces ${profile.repetitionWeeks} dernières semaines (à ne pas répéter sans raison) : ${recent.map(safe).join(" ; ") || "aucun"}`,
    "",
    "Semaines types (modèles de séance de batch ; si les cinq premiers dîners reprennent exactement une semaine type, donne son id dans `semaine_type`) :",
    ...(plans.length ? plans : ["(aucune)"]),
    "",
    `Produits du catalogue (écris les ingrédients avec ces noms quand c'est possible) : ${products.map((p) => p.name).join(" ; ")}`,
    "</foyer>",
  ];
  return { text: lines.join("\n"), data, cuisines, householdSize: settings.householdSize };
}

/** Pour les tests : les mots que le modèle ne doit jamais recevoir. */
export const norms = (values: string[]) => values.map((v) => norm(v)).filter(Boolean);
