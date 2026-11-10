import type { Ctx } from "@/server/auth/service";

/**
 * Console d'administration du catalogue commun de « Courses et repas » (US-164 à US-175) : un objet = un tableau, des filtres, des actions par ligne, un export.
 * Les écrans de la console sont tous bâtis sur ces types, pour qu'un nouvel objet ne demande qu'un module serveur.
 */

export const OBJECT_KEYS = ["plats", "cuisines", "references", "additifs", "saisons", "rayons", "plannings", "correspondances", "versions", "a-referencer", "base-commune", "plats-de-saison", "reglages"] as const;
export type ObjectKey = (typeof OBJECT_KEYS)[number];

export interface ConsoleColumn {
  key: string;
  label: string;
  align?: "right";
}

export interface FormField {
  key: string;
  label: string;
  /** « chips » : pastilles à cocher (plusieurs valeurs, rendues en liste séparée par des virgules) ; « info » : texte en lecture seule. */
  type: "text" | "number" | "textarea" | "select" | "chips" | "info";
  value?: string | number | null;
  options?: { value: string; label: string }[];
  required?: boolean;
}

export interface RowAction {
  key: string;
  label: string;
  /** Texte de confirmation avant d'agir (actions qui retirent ou fusionnent). */
  confirm?: string;
  /** Champs à renseigner avant d'agir (modifier, renommer, fusionner…). */
  fields?: FormField[];
  /** Fenêtre en lecture seule (« Voir ») : le seul bouton est « Fermer », rien n'est envoyé. */
  readOnly?: boolean;
}

export interface ConsoleRow {
  id: string;
  cells: Record<string, string | number | null>;
  /** Pastille d'état de la ligne : ok (vert), info, warn, muted (grise). */
  tone?: "ok" | "info" | "warn" | "muted";
  actions: RowAction[];
}

export interface ConsoleFilter {
  key: string;
  label: string;
  value: string;
  options: { value: string; label: string }[];
}

export interface ConsoleTools {
  /** Nom des fichiers que l'on peut télécharger : modèle, export, listes de contrôle. */
  downloads?: { key: string; label: string }[];
  /** Import par fichier CSV ou xlsx ; `replaceAll` ajoute la case « Tout remplacer ». */
  import?: { replaceAll: boolean; check?: boolean; checkOnly?: boolean };
  /** Calcul à la demande sur un texte saisi (pourcentage de correspondance d'un nom de plat). */
  lookup?: { label: string; placeholder: string };
  /** Formulaire d'ajout d'une ligne. */
  add?: { label: string; fields: FormField[] };
}

export interface ConsoleTable {
  object: ObjectKey;
  title: string;
  intro: string;
  info: string | null;
  columns: ConsoleColumn[];
  rows: ConsoleRow[];
  filters: ConsoleFilter[];
  search: boolean;
  total: number;
  footer: string | null;
  tools: ConsoleTools;
}

export interface ConsoleQuery {
  q: string;
  filters: Record<string, string>;
}

export interface ConsoleContext {
  ctx: Ctx;
  adminId: string;
}

export interface ConsoleObject {
  load(c: ConsoleContext, query: ConsoleQuery): Promise<ConsoleTable>;
  /** Action d'une ligne (`id` est celui de la ligne) ou d'ajout (`action` = « add », `id` vide). */
  act?(c: ConsoleContext, action: string, id: string, values: Record<string, string>): Promise<void>;
  download?(c: ConsoleContext, key: string, query: ConsoleQuery): Promise<{ file: string; content: string }>;
  /** Importe un fichier : tout est vérifié avant l'écriture ; `dryRun` contrôle sans rien écrire. */
  import?(c: ConsoleContext, file: { name: string; content: Buffer }, options: { replaceAll: boolean; dryRun: boolean }): Promise<{ count: number; lines: string[] }>;
  lookup?(c: ConsoleContext, value: string): Promise<string[]>;
}

export const ROW_LIMIT = 200;

export interface ConsoleSummary {
  /** Objets disponibles. */
  available: ObjectKey[];
  /** Compteur affiché à droite ; `todo` = à traiter. */
  counts: Partial<Record<ObjectKey, { n: number; todo: boolean }>>;
}
