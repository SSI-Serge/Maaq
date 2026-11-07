import type { Ctx } from "@/server/auth/service";

/**
 * Console d'administration du catalogue commun de « Courses et repas » (US-164 à US-175) : un objet = un tableau, des filtres, des actions par ligne, un export.
 * Les écrans de la console sont tous bâtis sur ces types, pour qu'un nouvel objet ne demande qu'un module serveur.
 */

export const OBJECT_KEYS = ["plats", "cuisines", "references", "additifs", "saisons", "rayons", "plannings", "correspondances", "versions", "a-referencer", "base-commune", "reglages"] as const;
export type ObjectKey = (typeof OBJECT_KEYS)[number];

export interface ConsoleColumn {
  key: string;
  label: string;
  align?: "right";
}

export interface FormField {
  key: string;
  label: string;
  type: "text" | "number" | "textarea" | "select";
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
  import?: boolean;
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
}

export const ROW_LIMIT = 200;

export interface ConsoleSummary {
  /** Objets disponibles. */
  available: ObjectKey[];
  /** Compteur affiché à droite ; `todo` = à traiter. */
  counts: Partial<Record<ObjectKey, { n: number; todo: boolean }>>;
}
