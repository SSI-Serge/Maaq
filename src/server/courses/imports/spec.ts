import { norm } from "../engine/text";
import type { Table } from "./table";

/** Un problème trouvé dans un fichier d'import : la ligne (1 = en-tête) et la colonne en cause. */
export interface ImportIssue {
  line: number | null;
  column: string | null;
  message: string;
}

export type CellResult<V> = { ok: true; value: V } | { ok: false; message: string };

export interface ColumnSpec {
  /** Nom de la colonne dans le fichier (minuscules, sans accent, `_` pour les espaces). */
  key: string;
  required?: boolean;
  /** Lit la cellule (texte brut, déjà nettoyé) ; par défaut le texte tel quel. */
  parse?: (raw: string, row: Record<string, string>) => CellResult<unknown>;
}

export interface ImportSpec<Ctx = undefined> {
  /** Nom affiché (« Plannings de batch cooking »). */
  title: string;
  /** Nom du modèle à télécharger (`plannings_batch.csv`). */
  templateFile: string;
  columns: ColumnSpec[];
  /** Colonne dont la valeur identifie la ligne : deux lignes du fichier ne peuvent pas la partager. */
  idColumn: string;
  /** Identifiant composé (produit + enseigne + référence) quand une seule colonne ne suffit pas. */
  rowKey?: (values: Record<string, unknown>) => string;
  /** Contrôle de toute la ligne une fois les colonnes lues. */
  checkRow?: (values: Record<string, unknown>, ctx: Ctx) => { column: string | null; message: string }[];
}

export interface ImportOutcome {
  rows: { line: number; values: Record<string, unknown> }[];
  issues: ImportIssue[];
}

/** Nom de colonne normalisé : « Temps total min » → `temps_total_min`. */
export function headerKey(header: string): string {
  return norm(header).trim().replace(/\s+/g, "_");
}

const MAX_ISSUES = 100;

/**
 * Vérifie TOUT le fichier avant la moindre écriture (règles communes des imports, section 5) : une seule ligne invalide refuse l'import,
 * et chaque problème indique la ligne et la colonne. Ne touche à aucune donnée.
 */
export function validateTable<Ctx>(spec: ImportSpec<Ctx>, table: Table, ctx: Ctx): ImportOutcome {
  const issues: ImportIssue[] = [];
  const head = table.rows[0].map(headerKey);
  const missing = spec.columns.filter((c) => c.required && !head.includes(c.key)).map((c) => c.key);
  if (missing.length) {
    return { rows: [], issues: [{ line: 1, column: missing.join(", "), message: `Colonne(s) manquante(s) : ${missing.join(", ")}.` }] };
  }
  // les colonnes inconnues du fichier sont ignorées (un classeur peut garder des colonnes de travail)
  const rows: ImportOutcome["rows"] = [];
  const seen = new Map<string, number>();
  table.rows.slice(1).forEach((cells, index) => {
    const line = table.lines[index + 1];
    const raw: Record<string, string> = {};
    head.forEach((h, i) => {
      if (h) raw[h] = (cells[i] ?? "").trim();
    });
    const values: Record<string, unknown> = {};
    let bad = false;
    for (const col of spec.columns) {
      const text = raw[col.key] ?? "";
      if (!text) {
        if (col.required) {
          issues.push({ line, column: col.key, message: "valeur obligatoire manquante." });
          bad = true;
        }
        values[col.key] = col.parse ? null : "";
        continue;
      }
      if (!col.parse) {
        values[col.key] = text;
        continue;
      }
      const r = col.parse(text, raw);
      if (r.ok) values[col.key] = r.value;
      else {
        issues.push({ line, column: col.key, message: r.message });
        bad = true;
      }
    }
    if (bad) return;
    const id = spec.rowKey ? spec.rowKey(values) : String(values[spec.idColumn] ?? "");
    if (id) {
      const first = seen.get(id);
      if (first !== undefined) {
        issues.push({ line, column: spec.idColumn, message: `identifiant « ${id} » déjà présent à la ligne ${first}.` });
        return;
      }
      seen.set(id, line);
    }
    const extra = spec.checkRow ? spec.checkRow(values, ctx) : [];
    for (const e of extra) issues.push({ line, column: e.column, message: e.message });
    if (!extra.length) rows.push({ line, values });
  });
  if (issues.length > MAX_ISSUES) {
    const total = issues.length;
    issues.length = MAX_ISSUES;
    issues.push({ line: null, column: null, message: `… et ${total - MAX_ISSUES} autre(s) problème(s).` });
  }
  return { rows: issues.length ? [] : rows, issues };
}

/** Le texte du refus d'un import : rien n'a été modifié. */
export function describeIssues(issues: ImportIssue[]): string[] {
  return issues.map((i) => {
    const where = [i.line ? `ligne ${i.line}` : null, i.column ? `colonne « ${i.column} »` : null].filter(Boolean).join(", ");
    return where ? `${where} : ${i.message}` : i.message;
  });
}
