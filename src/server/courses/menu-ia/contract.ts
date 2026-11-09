import { z } from "zod";

/**
 * Contrat du menu composé par l'IA (CR-42, US-156 RF3 à RF8) : le modèle rend le menu par l'outil `proposer_menu`, dont le schéma est strict. MAAQ vérifie tout (nombre de dîners,
 * durées, rang des étapes…) avant de montrer ou d'enregistrer quoi que ce soit ; une erreur est renvoyée au modèle pour qu'il corrige (deux essais, CR-44).
 */

export const DINNER_COUNT = 7;
export const EXPRESS_MAX = 4;
export const MAX_STEPS = 30;

const text = (max: number) => z.string().trim().min(1).max(max);

/** Unités d'un ingrédient dans le format du menu ; « cuillere » et « pincee » deviennent spoon et pinch en base (CR-50). */
export const INGREDIENT_UNITS = ["g", "kg", "ml", "cl", "l", "piece", "cuillere", "pincee"] as const;

export const ingredientInput = z.strictObject({
  nom: text(120),
  /** Quantité pour le NOMBRE DE PERSONNES DU FOYER (pas pour 4), dans l'unité `unite`. */
  quantite: z.number().positive().max(100_000).optional(),
  unite: z.enum(INGREDIENT_UNITS).optional(),
});

export const dishInput = z.strictObject({
  /** Identifiant d'un plat de « Mes plats » donné dans le contexte (« H:… ») ; sinon le plat est reconnu par son nom, ou c'est un plat libre. */
  plat_id: z.string().trim().max(60).optional(),
  nom: text(80),
  /** Cuisine du plat (une de celles du contexte) : obligatoire pour un plat libre. */
  cuisine: z.string().trim().max(60).optional(),
  duree_minutes: z.number().int().min(1).max(600).optional(),
  /** Recette écrite pour le nombre de personnes du foyer (CR-49), pour TOUT plat : libre, de Mes plats ou du catalogue. */
  recette: z.string().trim().max(4000).optional(),
  /** Ingrédients de TOUT plat du menu, un produit par entrée, avec leur quantité pour le foyer (CR-50). */
  ingredients: z.array(ingredientInput).max(40).optional(),
  version_allegee: z
    .strictObject({
      texte: text(1000),
      retirer: z.array(text(120)).max(10).default([]),
      ajouter: z.array(text(120)).max(10).default([]),
    })
    .optional(),
});

export const stepInput = z.strictObject({
  texte: text(2000),
  /** Nom EXACT du plat concerné (un des dîners ou plats express du menu) ; à laisser vide pour une étape générale (préparation, nettoyage…). */
  plat: z.string().trim().max(160).optional(),
  duree_minutes: z.number().int().min(1).max(600).optional(),
  /** Rang (à partir de 1) d'une étape PRÉCÉDENTE avec laquelle celle-ci se fait en même temps. */
  en_meme_temps_que: z.number().int().min(1).max(MAX_STEPS).optional(),
  /** Étape de conservation d'un plat : « frigo » ou « congelateur », et le jour où le sortir (1 = lundi … 7 = dimanche). */
  conservation: z.enum(["frigo", "congelateur"]).optional(),
  jour_sortie: z.number().int().min(1).max(7).optional(),
});

export const menuInput = z.strictObject({
  /** Lundi de la semaine du menu (AAAA-MM-JJ) ; par défaut la semaine suivante. */
  semaine: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Les sept dîners, du lundi au dimanche (moins de sept : menu incomplet, sans bouton « Valider »). */
  diners: z.array(dishInput).min(1).max(DINNER_COUNT),
  express: z.array(dishInput).max(EXPRESS_MAX).default([]),
  /** Identifiant d'une semaine type du contexte, si les cinq premiers dîners la reprennent telle quelle. */
  semaine_type: z.string().trim().max(40).optional(),
  /** Déroulé de la séance de batch (sans semaine type) : ordre des étapes, chevauchements, conservation. */
  etapes: z.array(stepInput).max(MAX_STEPS).default([]),
});

export type MenuInput = z.infer<typeof menuInput>;
export type DishInput = z.infer<typeof dishInput>;
export type IngredientInput = z.infer<typeof ingredientInput>;
export type StepInput = z.infer<typeof stepInput>;

/** Schéma JSON de l'outil, tiré du schéma ci-dessus (une seule source). */
export function menuToolSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(menuInput, { io: "input" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export const MENU_TOOLS = [
  {
    name: "preparer_menu",
    description:
      "À appeler AVANT de composer un menu : donne les données du foyer utiles au menu (cuisines préférées, objectifs, nombre de personnes, régimes et allergies, « Mes plats » avec leurs ingrédients, plats servis récemment, semaines types, mois en cours, noms des produits du catalogue). Réservé aux parents du couple.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "produits_achetes",
    description:
      "Donne les NOMS des produits du dernier ticket de caisse enregistré (sans prix, magasin ni date), pour composer un menu à partir de ce que le foyer vient d'acheter. À appeler quand la personne veut un menu « avec ce que j'ai acheté » ou après un ticket. Réservé aux parents du couple.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "proposer_menu",
    description:
      "Rend le menu de la semaine à MAAQ, qui l'affiche en carte dans le tchat avec le bouton « Valider le menu ». 7 dîners (lundi à dimanche) et 4 plats express, tous respectant les régimes et allergies du foyer. POUR CHAQUE plat, express compris, y compris ceux de « Mes plats » et du catalogue : la recette ET la liste des ingrédients avec leur quantité et leur unité, écrites pour le NOMBRE DE PERSONNES du foyer (900 g de blanc de poulet pour 6, pas pour 4). Les cinq premiers dîners forment la séance de batch : donne leur déroulé dans `etapes`. Rappelle l'outil avec le menu COMPLET à chaque correction demandée. Réservé aux parents du couple.",
    input_schema: menuToolSchema(),
  },
] as const;
