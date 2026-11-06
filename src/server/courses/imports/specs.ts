import type { CellResult, ImportSpec } from "./spec";

const text = (raw: string): CellResult<string> => ({ ok: true, value: raw });

function positiveNumber(raw: string): CellResult<number> {
  const n = Number(raw.replace(",", "."));
  return Number.isFinite(n) && n > 0 ? { ok: true, value: Math.round(n) } : { ok: false, message: "doit être un nombre positif (minutes)." };
}

function percent(raw: string): CellResult<number> {
  const n = Number(raw.replace(",", ".").replace("%", ""));
  return Number.isFinite(n) && n >= 0 && n <= 100 ? { ok: true, value: Math.round(n) } : { ok: false, message: "doit être un pourcentage entre 0 et 100." };
}

function pipeList(raw: string): CellResult<string[]> {
  return { ok: true, value: raw.split("|").map((x) => x.trim()).filter((x) => x) };
}

export const PLANNING_DAY_COLUMNS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi"] as const;

/** Plannings de batch cooking (US-170) : une ligne par semaine type. Modèle : `plannings_batch.csv`. */
export const PLANNINGS_SPEC: ImportSpec = {
  title: "Plannings de batch cooking",
  templateFile: "plannings_batch.csv",
  idColumn: "id_semaine",
  columns: [
    { key: "id_semaine", required: true },
    { key: "cuisine", required: true },
    { key: "theme" },
    ...PLANNING_DAY_COLUMNS.map((key) => ({ key, required: true })),
    {
      key: "ids",
      parse: (raw) => {
        const list = raw.split("|").map((x) => x.trim());
        return list.length === 5 ? { ok: true, value: list } : { ok: false, message: "doit contenir 5 valeurs séparées par |." };
      },
    },
    { key: "etapes", parse: (raw) => ({ ok: true, value: raw.split(/\s\|\s|\n/).map((x) => x.trim()).filter((x) => x) }) },
    { key: "temps_total_min", required: true, parse: positiveNumber },
    { key: "mutualisation_pct", parse: percent },
  ],
};

export interface VersionsContext {
  /** Identifiants des plats du catalogue : un identifiant inconnu refuse tout l'import (US-172 RF3). */
  knownDishIds: Set<string>;
}

/** Versions allégées (US-172) : produits à retirer et à ajouter par plat. Modèle : `versions_allegees.csv`. */
export const VERSIONS_SPEC: ImportSpec<VersionsContext> = {
  title: "Versions allégées",
  templateFile: "versions_allegees.csv",
  idColumn: "id_plat",
  columns: [
    { key: "id_plat", required: true },
    { key: "plat", parse: text },
    { key: "retirer", parse: pipeList },
    { key: "ajouter", parse: pipeList },
    { key: "texte_source", parse: text },
  ],
  checkRow: (values, ctx) => (ctx.knownDishIds.has(String(values.id_plat)) ? [] : [{ column: "id_plat", message: `identifiant « ${values.id_plat} » inconnu dans le catalogue.` }]),
};

export const PLANNINGS_TEMPLATE_HEADERS = ["id_semaine", "cuisine", "theme", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "ids", "etapes", "temps_total_min", "mutualisation_pct"];
export const VERSIONS_TEMPLATE_HEADERS = ["id_plat", "plat", "retirer", "ajouter", "texte_source"];
