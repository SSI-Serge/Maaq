import { courseError } from "../household/settings";
import { additives } from "./objects/additives";
import { aisles } from "./objects/aisles";
import { dishes } from "./objects/dishes";
import { moduleSettings } from "./objects/module-settings";
import { matches, plannings } from "./objects/plannings";
import { prices } from "./objects/prices";
import { references } from "./objects/references";
import { taxonomy } from "./objects/taxonomy";
import { seasons } from "./objects/seasons";
import { unreferenced } from "./objects/unreferenced";
import { versions } from "./objects/versions";
import { OBJECT_KEYS, type ConsoleContext, type ConsoleSummary, type ConsoleObject, type ConsoleQuery, type ObjectKey } from "./types";

export * from "./types";
export { readQuery } from "./util";

/** Les objets de la console qui existent ; les autres s'ajoutent ici, un module chacun. */
const OBJECTS: Partial<Record<ObjectKey, ConsoleObject>> = {
  plats: dishes,
  cuisines: taxonomy,
  references,
  saisons: seasons,
  versions,
  plannings,
  correspondances: matches,
  additifs: additives,
  rayons: aisles,
  "a-referencer": unreferenced,
  "base-commune": prices,
  reglages: moduleSettings,
};

export const NAV: { key: ObjectKey; label: string }[] = [
  { key: "plats", label: "Plats" },
  { key: "cuisines", label: "Cuisines et catégories" },
  { key: "references", label: "Références par enseigne" },
  { key: "additifs", label: "Additifs à éviter" },
  { key: "saisons", label: "Saisons" },
  { key: "rayons", label: "Rayons" },
  { key: "plannings", label: "Plannings de batch" },
  { key: "correspondances", label: "Correspondances" },
  { key: "versions", label: "Versions allégées" },
  { key: "a-referencer", label: "Produits à référencer" },
  { key: "base-commune", label: "Base commune des prix" },
  { key: "reglages", label: "Réglages du module" },
];

export function consoleObject(key: string): { key: ObjectKey; impl: ConsoleObject } {
  if (!(OBJECT_KEYS as readonly string[]).includes(key)) throw courseError("not_found", "Cet objet n'existe pas.", 404);
  const impl = OBJECTS[key as ObjectKey];
  if (!impl) throw courseError("not_available", "Cet écran de la console n'est pas encore disponible.", 404);
  return { key: key as ObjectKey, impl };
}

export async function consoleSummary(c: ConsoleContext): Promise<ConsoleSummary> {
  const { db } = c.ctx;
  const [dishCount, aisleCount, unref, toCheck, weeks, refs] = await Promise.all([
    db.selectFrom("meal_dishes").select((eb) => eb.fn.countAll<string>().as("n")).where("retired_at", "is", null).executeTakeFirstOrThrow(),
    db.selectFrom("grocery_aisles").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow(),
    db.selectFrom("v_grocery_unreferenced").select((eb) => eb.fn.countAll<string>().as("n")).where("state", "=", "to_reference").executeTakeFirstOrThrow(),
    db.selectFrom("v_grocery_shared_prices_moderation").select((eb) => eb.fn.countAll<string>().as("n")).where("needs_check", "=", true).where("removed_at", "is", null).executeTakeFirstOrThrow(),
    db.selectFrom("meal_batch_weeks").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow(),
    db.selectFrom("grocery_product_references").select((eb) => eb.fn.countAll<string>().as("n")).executeTakeFirstOrThrow(),
  ]);
  const toConfirm = await db.selectFrom("v_meal_batch_week_days").select((eb) => eb.fn.countAll<string>().as("n")).where("match_status", "<>", "sure").executeTakeFirstOrThrow();
  return {
    available: (Object.keys(OBJECTS) as ObjectKey[]),
    counts: {
      plats: { n: Number(dishCount.n), todo: false },
      references: { n: Number(refs.n), todo: false },
      rayons: { n: Number(aisleCount.n), todo: false },
      plannings: { n: Number(weeks.n), todo: false },
      correspondances: { n: Number(toConfirm.n), todo: Number(toConfirm.n) > 0 },
      "a-referencer": { n: Number(unref.n), todo: Number(unref.n) > 0 },
      "base-commune": { n: Number(toCheck.n), todo: Number(toCheck.n) > 0 },
    },
  };
}

export async function loadObject(c: ConsoleContext, key: string, query: ConsoleQuery) {
  return consoleObject(key).impl.load(c, query);
}

export async function runAction(c: ConsoleContext, key: string, action: string, id: string, values: Record<string, string>): Promise<void> {
  const { impl } = consoleObject(key);
  if (!impl.act) throw courseError("unknown_action", "Action inconnue.", 422);
  await impl.act(c, action, id, values);
}

export async function downloadFile(c: ConsoleContext, key: string, file: string, query: ConsoleQuery) {
  const { impl } = consoleObject(key);
  if (!impl.download) throw courseError("not_found", "Ce fichier n'existe pas.", 404);
  return impl.download(c, file, query);
}

export async function importFile(c: ConsoleContext, key: string, file: { name: string; content: Buffer }, options: { replaceAll: boolean; dryRun: boolean }) {
  const { impl } = consoleObject(key);
  if (!impl.import) throw courseError("not_found", "Cet objet n'a pas d'import.", 404);
  return impl.import(c, file, options);
}

export async function lookupValue(c: ConsoleContext, key: string, value: string): Promise<string[]> {
  const { impl } = consoleObject(key);
  if (!impl.lookup) throw courseError("not_found", "Cet objet n'a pas de calcul.", 404);
  return impl.lookup(c, value.trim().slice(0, 160));
}
