import { norm } from "../engine/text";
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

export interface HouseholdDishesContext {
  /** Cuisines connues (minuscules, sans accent) : une cuisine inconnue refuse tout l'import. */
  cuisines: Set<string>;
}

/** Plats du foyer (US-159) : « plat, cuisine, ingrédients » ; plusieurs ingrédients séparés par | ou par une virgule. Modèle : `mes_plats.csv`. */
export const HOUSEHOLD_DISHES_SPEC: ImportSpec<HouseholdDishesContext> = {
  title: "Mes plats",
  templateFile: "mes_plats.csv",
  idColumn: "plat",
  columns: [
    { key: "plat", required: true, parse: (raw) => (raw.length <= 80 ? { ok: true, value: raw } : { ok: false, message: "80 caractères au plus." }) },
    { key: "cuisine", required: true },
    {
      key: "ingredients",
      required: true,
      parse: (raw) => {
        const list = [...new Set(raw.split(/[|,]/).map((x) => x.trim()).filter((x) => x))];
        if (!list.length) return { ok: false, message: "au moins un ingrédient." };
        return list.length <= 40 && list.every((x) => x.length <= 120) ? { ok: true, value: list } : { ok: false, message: "40 ingrédients au plus, 120 caractères chacun." };
      },
    },
  ],
  checkRow: (values, ctx) => (ctx.cuisines.has(norm(String(values.cuisine))) ? [] : [{ column: "cuisine", message: `cuisine « ${values.cuisine} » inconnue.` }]),
};

export const HOUSEHOLD_DISHES_TEMPLATE_HEADERS = ["plat", "cuisine", "ingredients"];

export type ReferenceStatusLabel = "conforme" | "sans objet" | "a verifier" | "aucun conforme trouve";

function decimalPrice(raw: string): CellResult<number> {
  const n = Number(raw.replace(/\s/g, "").replace("€", "").replace(",", "."));
  return Number.isFinite(n) && n > 0 && n <= 10000 ? { ok: true, value: Math.round(n * 100) / 100 } : { ok: false, message: "doit être un prix supérieur à 0 (ou vide : N/A)." };
}

function isoDate(raw: string): CellResult<string> {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw) ?? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (!m) return { ok: false, message: "date attendue au format AAAA-MM-JJ (ou JJ/MM/AAAA)." };
  const [y, mo, d] = raw.includes("/") ? [m[3], m[2], m[1]] : [m[1], m[2], m[3]];
  const date = new Date(`${y}-${mo}-${d}T12:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== `${y}-${mo}-${d}` ? { ok: false, message: "date inexistante." } : { ok: true, value: `${y}-${mo}-${d}` };
}

function referenceStatus(raw: string): CellResult<string> {
  const key = norm(raw).trim();
  return ["conforme", "sans objet", "a verifier", "aucun conforme trouve"].includes(key) ? { ok: true, value: raw } : { ok: false, message: "attendu : Conforme, Sans objet, À vérifier ou Aucun conforme trouvé." };
}

/** Références par enseigne (US-166, US-174). Modèle : `references.csv`. Le prix et sa date vont ensemble ; sans prix, la référence s'affiche « N/A ». */
export const REFERENCES_SPEC: ImportSpec = {
  title: "Références par enseigne",
  templateFile: "references.csv",
  idColumn: "produit",
  rowKey: (v) => `${norm(String(v.produit))}|${norm(String(v.enseigne))}|${norm(String(v.reference))}`,
  columns: [
    { key: "produit", required: true },
    { key: "rayon" },
    { key: "enseigne", required: true },
    { key: "reference", required: true },
    { key: "format", parse: (raw) => (raw.length <= 80 ? { ok: true, value: raw } : { ok: false, message: "80 caractères au plus." }) },
    { key: "prix", parse: decimalPrice },
    { key: "date_prix", parse: isoDate },
    { key: "statut", parse: referenceStatus },
    { key: "additifs", parse: (raw) => ({ ok: true, value: [...new Set(raw.split("|").map((x) => norm(x).trim()).filter((x) => x))] }) },
    { key: "composition", parse: (raw) => (raw.length <= 2000 ? { ok: true, value: raw } : { ok: false, message: "2 000 caractères au plus." }) },
    // facultatifs : la quantité du format en kg ou en litres (la base la déduit du format quand elle n'est pas fournie) et l'unité du prix (CR-39, CR-40)
    { key: "package_amount", parse: (raw) => { const n = Number(raw.replace(",", ".")); return Number.isFinite(n) && n > 0 && n < 10_000_000 ? { ok: true, value: Math.round(n * 1000) / 1000 } : { ok: false, message: "doit être une quantité positive (en kg ou en litres)." }; } },
    { key: "package_unit", parse: (raw) => (["kg", "l"].includes(raw.toLowerCase()) ? { ok: true, value: raw.toLowerCase() } : { ok: false, message: "attendu : kg ou l." }) },
    { key: "unite_prix", parse: (raw) => (["unit", "kg", "l"].includes(raw.toLowerCase()) ? { ok: true, value: raw.toLowerCase() } : { ok: false, message: "attendu : unit (par article), kg ou l." }) },
  ],
  checkRow: (v) => {
    const out: { column: string | null; message: string }[] = [];
    if ((v.package_amount === null) !== (v.package_unit === null)) out.push({ column: "package_unit", message: "la quantité du format et son unité vont ensemble." });
    if (v.prix !== null && !v.date_prix) out.push({ column: "date_prix", message: "la date du prix est obligatoire quand il y a un prix." });
    if (v.prix === null && v.date_prix) out.push({ column: "prix", message: "un prix est obligatoire quand il y a une date (sinon laissez les deux vides)." });
    return out;
  },
};

export const REFERENCES_TEMPLATE_HEADERS = ["produit", "rayon", "enseigne", "reference", "format", "prix", "date_prix", "statut", "additifs", "composition", "package_amount", "package_unit", "unite_prix"];
