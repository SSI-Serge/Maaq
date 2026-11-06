import type { Kysely, Transaction } from "kysely";
import type { DB } from "@/server/db/schema.generated";
import { buildRefProducts, dishItems, findProd, type ReferenceRow } from "../engine/products";
import { DEFAULT_SEASONS, MEAT_KEYWORDS } from "../engine/dishes";
import { linkPlans, Matcher } from "../engine/matcher";
import { has, norm } from "../engine/text";
import type { Dish, Plan } from "../engine/types";

/**
 * Chargement initial du catalogue commun depuis le classeur actuel (section 5 de la spec : 60 plats et leurs références). Le fichier de départ est
 * `db/seed/courses/catalog.json`, extrait du classeur de référence. Ne s'exécute que sur un catalogue vide.
 */

export interface SeedDish {
  id: string;
  cuisine: string;
  name: string;
  ing: string;
  recipe: string;
  health: string;
  batch: string;
  time: string;
  minutes: number;
  tags: string[];
}
export interface SeedData {
  dishes: SeedDish[];
  plans: Plan[];
  refs: (Pick<ReferenceRow, "product" | "rayon" | "used" | "store" | "ref" | "price" | "conform"> & { /** Colonne « Statut » du classeur : Conforme, Sans objet, À vérifier, Aucun conforme trouvé, Non trouvé. */ status?: string; priceDate?: string | null; composition?: string })[];
  allege: { id: string; plat: string; remove: string[]; add: string[]; text: string }[];
}

/** Statut du classeur → statut de conformité déclaré en base (CR-37). */
const COMPLIANCE: Record<string, "compliant" | "to_check" | "none_found" | "not_applicable" | undefined> = {
  Conforme: "compliant",
  "Sans objet": "not_applicable",
  "À vérifier": "to_check",
  "Aucun conforme trouvé": "none_found",
};

export interface SeedReport {
  skipped: boolean;
  aisles: number;
  cuisines: number;
  tags: number;
  products: number;
  references: number;
  referencesWithoutPrice: number;
  /** Références « Non trouvé » du classeur, non chargées. */
  notLoadedReferences: number;
  dishes: number;
  ingredientLinks: number;
  batchWeeks: number;
  lightVersions: number;
  seasonLinks: number;
}

/** Les rayons de départ (US-169 RF1). */
export const DEFAULT_AISLES = [
  "Féculents", "Fruits et légumes", "Crèmerie", "Épicerie du monde", "Épices et aromates", "Huiles et condiments", "Légumineuses", "Charcuterie",
  "Conserves et surgelés", "Épicerie sucrée", "Boucherie", "Poissonnerie", "Volaille", "Sauces tomate", "Boissons", "Entretien", "Soins du corps", "Petit-déjeuner", "Autres",
];

export const MEAT_LABEL: Record<string, string> = { poulet: "Poulet", boeuf: "Bœuf", porc: "Porc", poisson: "Poisson", veau: "Veau", agneau: "Agneau" };
export const DIET_LABEL: Record<string, string> = { vegetarien: "Végétarien", "sans gluten": "Sans gluten" };
/** Allergènes de départ, déduits des mots du plat (indicatif, modifiables en console) : étiquette → mots. */
export const ALLERGENS: Record<string, string[]> = {
  Arachide: ["arachide", "cacahuete"],
  "Fruits à coque": ["noix", "amande", "noisette", "pistache", "cajou"],
  Œuf: ["oeuf"],
  Lait: ["lait", "creme", "fromage", "beurre", "yaourt", "mozzarella", "parmesan", "feta", "ricotta", "bechamel"],
};

/** Rayons du classeur qui doublonnent un rayon de départ : rangés dans celui-ci (anomalies de données du classeur, signalées au BA). */
const AISLE_ALIAS: Record<string, string> = { poissons: "Conserves et surgelés", "boissons (cuisine)": "Boissons" };
export const canonicalAisle = (rayon: string): string => AISLE_ALIAS[norm(rayon)] ?? rayon;

/** Clé normalisée d'un nom : minuscules, accents retirés, espaces simples (CR-25). */
export function nameKey(name: string): string {
  return norm(name).replace(/[\s-]+/g, " ").trim();
}

/** Clé d'enseigne ou de ville : minuscules et espaces simples, accents conservés (affichage remis en forme par l'application). */
export function placeKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Charge le catalogue dans une transaction déjà ouverte (utile aux tests, qui prennent un verrou avant). */
export async function seedWithin(trx: Transaction<DB>, data: SeedData, options: { priceDate: string }): Promise<SeedReport> {
  const report: SeedReport = { skipped: false, aisles: 0, cuisines: 0, tags: 0, products: 0, references: 0, referencesWithoutPrice: 0, notLoadedReferences: 0, dishes: 0, ingredientLinks: 0, batchWeeks: 0, lightVersions: 0, seasonLinks: 0 };
  {
    const existing = await trx.selectFrom("meal_dishes").select("id").limit(1).executeTakeFirst();
    if (existing) return { ...report, skipped: true };

    // rayons : les 19 de départ existent déjà (données de référence du schéma) ; on ajoute ceux que le classeur utilise en plus
    const aisleId = new Map<string, number>();
    for (const a of await trx.selectFrom("grocery_aisles").select(["id", "name"]).execute()) aisleId.set(norm(a.name), a.id);
    const aisleNames = [...DEFAULT_AISLES];
    for (const r of data.refs) if (r.rayon && !aisleNames.some((a) => norm(a) === norm(canonicalAisle(r.rayon)))) aisleNames.push(canonicalAisle(r.rayon));
    for (const [i, name] of aisleNames.entries()) {
      if (aisleId.has(norm(name))) continue;
      const row = await trx.insertInto("grocery_aisles").values({ name, sort_order: (i + 1) * 10 }).returning("id").executeTakeFirstOrThrow();
      aisleId.set(norm(name), row.id);
    }
    report.aisles = aisleId.size;
    const otherAisle = aisleId.get(norm("Autres"))!;
    const aisleOf = (rayon: string | undefined) => aisleId.get(norm(canonicalAisle(rayon ?? ""))) ?? otherAisle;

    // cuisines
    const cuisineId = new Map<string, number>();
    for (const [i, name] of [...new Set(data.dishes.map((d) => d.cuisine))].entries()) {
      const row = await trx.insertInto("meal_cuisines").values({ name, sort_order: (i + 1) * 10 }).returning("id").executeTakeFirstOrThrow();
      cuisineId.set(name, row.id);
      report.cuisines += 1;
    }

    // étiquettes et catégories
    const tagId = new Map<string, number>();
    const addTag = async (kind: "diet" | "meat" | "allergen", name: string, order: number) => {
      const row = await trx.insertInto("meal_dish_tags").values({ kind, name, sort_order: order }).returning("id").executeTakeFirstOrThrow();
      tagId.set(norm(name), row.id);
      report.tags += 1;
    };
    let order = 10;
    for (const code of Object.keys(MEAT_KEYWORDS)) await addTag("meat", MEAT_LABEL[code], order++);
    for (const label of Object.values(DIET_LABEL)) await addTag("diet", label, order++);
    for (const label of Object.keys(ALLERGENS)) await addTag("allergen", label, order++);
    const saladCategory = (await trx.insertInto("meal_dish_categories").values({ name: "Salades", sort_order: 10 }).returning("id").executeTakeFirstOrThrow()).id;

    // produits : ceux des références, puis les ingrédients libres des plats et les produits des versions allégées
    const refProducts = buildRefProducts(data.refs.map((r) => ({ ...r, priceDate: null })));
    const productId = new Map<string, string>();
    const ensureProduct = async (name: string, rayon?: string): Promise<string> => {
      const key = nameKey(name);
      const known = productId.get(key);
      if (known) return known;
      const row = await trx.insertInto("grocery_products").values({ name: name.slice(0, 120), name_key: key.slice(0, 120), aisle_id: aisleOf(rayon) }).returning("id").executeTakeFirstOrThrow();
      productId.set(key, row.id);
      report.products += 1;
      return row.id;
    };
    for (const p of refProducts.values()) await ensureProduct(p.name, p.rayon);

    // références du classeur (CR-37) : « Conforme », « Sans objet » et « À vérifier » sont proposées (la dernière avec la mention « Composition à vérifier sur l'étiquette »),
    // « Aucun conforme trouvé » n'est jamais proposée (rangée dans les ingrédients exclus), « Non trouvé » n'est pas chargée. Sans prix connu, le prix et sa date restent vides (« N/A »).
    for (const ref of data.refs) {
      const status = ref.status ?? (ref.conform ? "Conforme" : "Non trouvé");
      const compliance = COMPLIANCE[status];
      if (!compliance) {
        report.notLoadedReferences += 1;
        continue;
      }
      const priced = ref.price !== null && ref.price > 0;
      const inserted = await trx
        .insertInto("grocery_product_references")
        .values({
          product_id: productId.get(nameKey(ref.product))!,
          store_chain: placeKey(ref.store).slice(0, 80),
          reference_name: (ref.ref || "(aucune référence conforme trouvée)").slice(0, 160),
          unit_price: priced ? ref.price!.toFixed(2) : null,
          price_date: priced ? (ref.priceDate ?? options.priceDate) : null,
          compliance_status: compliance,
          composition_text: ref.composition ? ref.composition.slice(0, 2000) : null,
        })
        .onConflict((oc) => oc.columns(["product_id", "store_chain", "reference_name"]).doNothing())
        .returning("id")
        .executeTakeFirst();
      if (!inserted) continue;
      report.references += 1;
      if (!priced) report.referencesWithoutPrice += 1;
    }

    // plats
    const dishRows = new Map<string, string>();
    const engineDishes: Dish[] = data.dishes.map((d) => ({ id: d.id, cuisine: d.cuisine, name: d.name, ing: d.ing, recipe: d.recipe, health: d.health, batch: d.batch, time: d.time, minutes: d.minutes, tags: new Set(d.tags) }));
    for (const d of data.dishes) {
      const row = await trx
        .insertInto("meal_dishes")
        .values({ code: d.id, name: d.name.slice(0, 120), cuisine_id: cuisineId.get(d.cuisine)!, recipe: d.recipe || null, duration_minutes: Math.min(Math.max(d.minutes, 1), 600) })
        .returning("id")
        .executeTakeFirstOrThrow();
      dishRows.set(d.id, row.id);
      report.dishes += 1;
      const text = norm(`${d.name} ${d.ing}`);
      const tags = new Set<number>();
      for (const t of d.tags) {
        const label = MEAT_LABEL[t] ?? DIET_LABEL[t];
        if (label) tags.add(tagId.get(norm(label))!);
      }
      for (const [label, words] of Object.entries(ALLERGENS)) if (words.some((w) => has(w, text))) tags.add(tagId.get(norm(label))!);
      for (const id of tags) await trx.insertInto("meal_dish_tag_links").values({ dish_id: row.id, tag_id: id }).execute();
      if (d.tags.includes("salade")) await trx.insertInto("meal_dish_category_links").values({ dish_id: row.id, category_id: saladCategory }).execute();
      const { found, free } = dishItems(d, refProducts);
      const ids: string[] = [];
      for (const name of found) ids.push(await ensureProduct(name));
      for (const name of free) ids.push(await ensureProduct(capital(name)));
      for (const [i, id] of [...new Set(ids)].entries()) {
        await trx.insertInto("meal_dish_ingredients").values({ dish_id: row.id, product_id: id, position: i + 1 }).execute();
        report.ingredientLinks += 1;
      }
    }

    // semaines types de batch cooking et correspondances avec le catalogue
    const linked = linkPlans(data.plans, engineDishes);
    const matcher = new Matcher(engineDishes);
    for (const plan of linked) {
      const week = await trx
        .insertInto("meal_batch_weeks")
        .values({
          code: plan.id,
          cuisine_id: cuisineId.get(plan.cuisine) ?? [...cuisineId.values()][0],
          theme: plan.theme || null,
          session_text: plan.steps.join("\n") || "Séance à renseigner",
          session_minutes: Math.min(Math.max(plan.total, 1), 1000),
          shared_ingredients_pct: plan.pct,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      report.batchWeeks += 1;
      for (const [i, name] of plan.days.entries()) {
        const exact = plan.ids[i] && dishRows.has(plan.ids[i]) ? plan.ids[i] : null;
        const best = matcher.top(name, 1)[0];
        await trx
          .insertInto("meal_batch_week_days")
          .values({
            week_id: week.id,
            weekday: i + 1,
            planning_dish_name: name.slice(0, 160),
            dish_id: exact ? dishRows.get(exact)! : null,
            suggested_dish_id: exact ? dishRows.get(exact)! : best && best.score > 0 ? dishRows.get(best.id)! : null,
            match_pct: exact ? 100 : Math.round((best?.score ?? 0) * 100),
          })
          .execute();
      }
    }

    // versions allégées
    for (const a of data.allege) {
      const dishId = dishRows.get(a.id);
      if (!dishId || (!a.remove.length && !a.add.length && !a.text)) continue;
      await trx.insertInto("meal_light_versions").values({ dish_id: dishId, display_text: a.text || "Version allégée" }).execute();
      report.lightVersions += 1;
      const seen = new Set<string>();
      for (const [kind, names] of [["remove", a.remove], ["add", a.add]] as const) {
        for (const name of names) {
          const key = nameKey(name);
          if (!key || seen.has(`${kind}|${key}`)) continue;
          seen.add(`${kind}|${key}`);
          const product = kind === "remove" ? await ensureProduct(name) : (productId.get(key) ?? (findProd(refProducts, name) ? productId.get(nameKey(findProd(refProducts, name)!)) : undefined));
          await trx.insertInto("meal_light_version_items").values({ dish_id: dishId, kind, product_id: product ?? null, name_key: key.slice(0, 120) }).execute();
        }
      }
    }

    // calendrier de saison : les produits dont le nom contient le mot de saison reçoivent ses mois
    for (const season of DEFAULT_SEASONS) {
      const months: number[] = [];
      for (let m = season.from; ; m = (m % 12) + 1) {
        months.push(m);
        if (m === season.to) break;
      }
      for (const [key, id] of productId) {
        if (!has(season.key, key)) continue;
        for (const m of months) {
          await trx.insertInto("grocery_product_seasons").values({ product_id: id, season_month: m }).onConflict((oc) => oc.doNothing()).execute();
          report.seasonLinks += 1;
        }
      }
    }
    return report;
  }
}

export async function seedCoursesCatalog(db: Kysely<DB>, data: SeedData, options: { priceDate: string }): Promise<SeedReport> {
  return db.transaction().execute((trx) => seedWithin(trx, data, options));
}

