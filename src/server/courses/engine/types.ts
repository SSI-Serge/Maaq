/** Types du moteur « Courses et repas ». Aucun lien avec la base : les adaptateurs (US-153 et suivantes) fournissent ces données. */

export interface Dish {
  id: string;
  cuisine: string;
  name: string;
  /** Ingrédients, texte libre séparé par des virgules (CR-25 : pas de quantités). */
  ing: string;
  recipe: string;
  /** Texte de la version santé. */
  health: string;
  /** Déroulé de la séance de batch du plat. */
  batch: string;
  /** Durée affichée (« 45 min »). */
  time: string;
  minutes: number;
  /** Étiquettes gérées en console (CR-30) : salade, poulet, boeuf, porc, poisson, veau, agneau, vegetarien, « sans gluten »… */
  tags: Set<string>;
  /** Plat personnel du foyer (CR-04). */
  mine?: boolean;
}

export interface Profile {
  /** Objectifs cumulables : « temps », « mes plats », « saison ». */
  objectives: string;
  repetitionWeeks: number;
  preferredCuisines: string[];
  /** Cuisines ou « mes plats » : d'où viennent les remplacements (US-153). */
  replacementSource: string[];
  batchMaxMinutes: number;
  allergies: string[];
  regimes: string[];
}

/** Semaine type de batch cooking (US-170). */
export interface Plan {
  id: string;
  cuisine: string;
  theme: string;
  /** Un plat par jour, du lundi au vendredi. */
  days: string[];
  /** Identifiants de plats du catalogue, facultatifs. */
  ids: string[];
  steps: string[];
  total: number;
  pct: number | null;
}

export type MatchStatus = "ok" | "confirmer" | "absent";
/** [plat sûr ou null, statut, score 0-1, meilleur candidat ou null] */
export type PlanMatch = [string | null, MatchStatus, number, string | null];
export interface LinkedPlan extends Plan {
  match: PlanMatch[];
}

export interface SeasonRange {
  /** Mot cherché dans les ingrédients. */
  key: string;
  /** Mois de début et de fin, de 1 à 12 ; une période à cheval sur deux années a from > to. */
  from: number;
  to: number;
}

export interface MenuEntry {
  day: string;
  id: string;
  alts: string[];
  /** Le plat vient de la semaine type (séance de batch). */
  batch: boolean;
  /** Pour un plat de planning remplacé par un plat proche : nom du plat du planning (correspondance à confirmer). */
  confirm: string;
}

export interface BatchInfo {
  source: "planning" | "estimation";
  id?: string;
  theme?: string;
  cuisine?: string;
  total: number;
  pct?: number | null;
  steps: string[];
  cap: number;
  confirm?: number;
}

export interface MenuState {
  week: string;
  batch: BatchInfo;
  menu: MenuEntry[];
  express: string[];
  /** Moins de plats express que demandé (US-156 RF11). */
  expressShort: boolean;
  /** Semaines types écartées parce qu'un de leurs plats n'a aucun équivalent dans le catalogue. */
  blockedPlans: number;
}
