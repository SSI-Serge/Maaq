import { sql, type Kysely } from "kysely";
import type { DB } from "@/server/db/schema.generated";

/**
 * Catalogue d'anticipation (US-102 RF1, RT1, RT4) : liste d'échéances types, chargée par l'équipe technique à partir d'un fichier de données (D60). Le fichier a les colonnes
 * et les contrôles de la future console (US-111, D50, RF3 à RF8) : code unique, âge minimal ≤ âge maximal, source, date de revue et « validé par » pour un rappel médical.
 * Le chargement se fait par code, entièrement ou pas du tout ; un rappel absent du fichier est désactivé, jamais supprimé.
 */

type Db = Kysely<DB>;

/** Une ligne du fichier, telle qu'écrite par l'équipe produit (clés en français, valeurs « oui » ou « non »). */
export interface CatalogFileRow {
  code?: unknown;
  libelle?: unknown;
  categorie?: unknown;
  medical?: unknown;
  /** « oui » : la question vise un membre précis (âge, rôle) ; « non » : la famille. */
  par_membre?: unknown;
  periode_debut_mois?: unknown;
  periode_debut_jour?: unknown;
  periode_fin_mois?: unknown;
  periode_fin_jour?: unknown;
  delai_jours?: unknown;
  frequence_annees?: unknown;
  /** parent, enfant, autre, ou vide pour toute la famille. */
  role?: unknown;
  age_min_mois?: unknown;
  age_max_mois?: unknown;
  /** « vehicle=oui », « pet=non »… ou vide. */
  situation?: unknown;
  source?: unknown;
  date_revue?: unknown;
  valide_par?: unknown;
  actif?: unknown;
}

export interface CatalogItem {
  code: string;
  label: string;
  category: string;
  isMedical: boolean;
  perMember: boolean;
  active: boolean;
  periodStart: { month: number; day: number };
  periodEnd: { month: number; day: number };
  leadDays: number;
  everyNYears: number;
  targetRole: "parent" | "child" | "other" | null;
  minAgeMonths: number | null;
  maxAgeMonths: number | null;
  situationKey: string | null;
  situationValue: boolean | null;
  sourceReference: string | null;
  reviewedAt: string | null;
  reviewedBy: string | null;
}

export interface CatalogError {
  /** Numéro de ligne du fichier (la première ligne de données est la ligne 1). */
  line: number;
  column: string;
  message: string;
}

const ROLES: Record<string, "parent" | "child" | "other"> = { parent: "parent", enfant: "child", autre: "other" };
const MAX_LABEL = 150;

const text = (v: unknown) => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");

/** « oui » ou « non » (majuscules, accents et « true » tolérés) ; vide vaut `fallback`. */
function yesNo(v: unknown, fallback: boolean): boolean | null {
  const t = text(v).toLowerCase();
  if (t === "") return typeof v === "boolean" ? v : fallback;
  if (["oui", "true", "1", "vrai"].includes(t)) return true;
  if (["non", "false", "0", "faux"].includes(t)) return false;
  return null;
}

function int(v: unknown): number | null {
  const t = text(v);
  return /^-?\d+$/.test(t) ? Number(t) : null;
}

const isoDate = (v: unknown) => /^\d{4}-\d{2}-\d{2}$/.test(text(v)) && !Number.isNaN(Date.parse(`${text(v)}T00:00:00Z`));

/**
 * Contrôle chaque ligne selon les règles du catalogue. Rend les rappels corrects et la liste des erreurs, avec numéro de ligne, colonne et message : tant qu'il y a une erreur,
 * rien ne doit être appliqué (US-111 RF7).
 */
export function validateCatalog(rows: CatalogFileRow[], situationKeys: string[]): { items: CatalogItem[]; errors: CatalogError[] } {
  const items: CatalogItem[] = [];
  const errors: CatalogError[] = [];
  const seen = new Set<string>();
  if (rows.length > 1000) return { items, errors: [{ line: 0, column: "fichier", message: "Le fichier ne peut pas dépasser 1 000 lignes." }] };
  rows.forEach((row, index) => {
    const line = index + 1;
    const bad = (column: string, message: string) => errors.push({ line, column, message });
    const code = text(row.code);
    if (!/^[a-z0-9_]+$/.test(code)) bad("code", "obligatoire : lettres minuscules, chiffres et tirets bas.");
    else if (seen.has(code)) bad("code", `le code « ${code} » figure déjà dans le fichier.`);
    seen.add(code);
    const label = text(row.libelle);
    if (!label) bad("libellé", "obligatoire.");
    else if (label.length > MAX_LABEL) bad("libellé", `${MAX_LABEL} caractères au plus.`);
    const medical = yesNo(row.medical, false);
    if (medical === null) bad("médical", "« oui » ou « non ».");
    const active = yesNo(row.actif, true);
    if (active === null) bad("actif", "« oui » ou « non ».");
    const perMember = yesNo(row.par_membre, /\{membre\}/.test(label));
    if (perMember === null) bad("par membre", "« oui » ou « non ».");
    const month = (column: string, v: unknown) => {
      const n = int(v);
      if (n === null || n < 1 || n > 12) bad(column, "un mois de 1 à 12.");
      return n ?? 1;
    };
    const day = (column: string, v: unknown, fallback: number) => {
      if (text(v) === "") return fallback;
      const n = int(v);
      if (n === null || n < 1 || n > 31) bad(column, "un jour de 1 à 31.");
      return n ?? fallback;
    };
    const periodStart = { month: month("début de période (mois)", row.periode_debut_mois), day: day("début de période (jour)", row.periode_debut_jour, 1) };
    const periodEnd = { month: month("fin de période (mois)", row.periode_fin_mois), day: day("fin de période (jour)", row.periode_fin_jour, 28) };
    const lead = text(row.delai_jours) === "" ? 21 : int(row.delai_jours);
    if (lead === null || lead < 0 || lead > 365) bad("délai d'anticipation", "un nombre de jours de 0 à 365.");
    const every = text(row.frequence_annees) === "" ? 1 : int(row.frequence_annees);
    if (every === null || every < 1 || every > 10) bad("fréquence", "un nombre d'années de 1 à 10.");
    const roleText = text(row.role).toLowerCase();
    if (roleText && !ROLES[roleText]) bad("rôle", "parent, enfant, autre, ou vide pour toute la famille.");
    const minAge = text(row.age_min_mois) === "" ? null : int(row.age_min_mois);
    const maxAge = text(row.age_max_mois) === "" ? null : int(row.age_max_mois);
    if ((text(row.age_min_mois) !== "" && (minAge === null || minAge < 0)) || (text(row.age_max_mois) !== "" && (maxAge === null || maxAge < 0))) bad("âge", "un nombre de mois, 0 ou plus.");
    else if (minAge !== null && maxAge !== null && minAge > maxAge) bad("âge maximal", "doit être supérieur à l'âge minimal.");
    if (perMember === false && (roleText || minAge !== null || maxAge !== null)) bad("par membre", "un rôle ou un âge exige un rappel par membre.");
    let situationKey: string | null = null;
    let situationValue: boolean | null = null;
    if (text(row.situation)) {
      const m = /^([a-z_]+)\s*=\s*(oui|non)$/i.exec(text(row.situation));
      if (!m || !situationKeys.includes(m[1])) bad("situation", `« clé=oui » ou « clé=non », avec une clé parmi : ${situationKeys.join(", ")}.`);
      else {
        situationKey = m[1];
        situationValue = m[2].toLowerCase() === "oui";
      }
    }
    // Contenu médical : source officielle, date de revue et « validé par » (US-102 RT4, D54), libellé sans référence à un RDV passé (D44).
    const source = text(row.source) || null;
    const reviewedBy = text(row.valide_par) || null;
    const reviewedAt = text(row.date_revue) || null;
    if (reviewedAt && !isoDate(reviewedAt)) bad("date de revue", "une date AAAA-MM-JJ.");
    if (medical && active !== false) {
      if (!source) bad("source", "obligatoire pour un rappel médical actif.");
      if (!reviewedAt) bad("date de revue", "obligatoire pour un rappel médical actif.");
      if (!reviewedBy) bad("validé par", "obligatoire pour un rappel médical actif : le référent santé qui a validé le contenu.");
    }
    if (medical && /\b(dernier|derniere|précédent|precedent|déjà fait|deja fait)\b/i.test(label)) bad("libellé", "un rappel médical reste générique, sans référence à un rendez-vous passé.");
    if (medical && !perMember) bad("par membre", "un rappel médical vise un membre précis.");
    if (errors.some((e) => e.line === line)) return;
    items.push({
      code, label, category: text(row.categorie) || "autre", isMedical: Boolean(medical), perMember: Boolean(perMember), active: Boolean(active), periodStart, periodEnd, leadDays: lead!, everyNYears: every!,
      targetRole: roleText ? ROLES[roleText] : null, minAgeMonths: minAge, maxAgeMonths: maxAge, situationKey, situationValue, sourceReference: source, reviewedAt, reviewedBy,
    });
  });
  return { items, errors };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Aperçu et chargement
// ---------------------------------------------------------------------------------------------------------------------------

export interface CatalogPreview {
  created: string[];
  updated: { code: string; changes: { field: string; before: unknown; after: unknown }[] }[];
  /** Rappels absents du fichier, ou désactivés par lui : « Le code X n'est plus présent : le rappel sera désactivé » (US-111 RF12). */
  deactivated: string[];
  unchanged: string[];
}

type Row = {
  code: string; label: string; category: string; is_medical: boolean; active: boolean; per_member: boolean; period_start_month: number; period_start_day: number; period_end_month: number;
  period_end_day: number; lead_days: number; every_n_years: number; target_role: string | null; min_age_months: number | null; max_age_months: number | null; situation_key: string | null;
  situation_required_value: boolean | null; source_reference: string | null; reviewed_at: Date | null; reviewed_by: string | null; version: number;
};

const COLUMNS = [
  "code", "label", "category", "is_medical", "active", "per_member", "period_start_month", "period_start_day", "period_end_month", "period_end_day", "lead_days", "every_n_years", "target_role",
  "min_age_months", "max_age_months", "situation_key", "situation_required_value", "source_reference", "reviewed_at", "reviewed_by", "version",
] as const;

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

function toRow(item: CatalogItem): Omit<Row, "version" | "reviewed_at"> & { reviewed_at: string | null } {
  return {
    code: item.code, label: item.label, category: item.category, is_medical: item.isMedical, active: item.active, per_member: item.perMember, period_start_month: item.periodStart.month,
    period_start_day: item.periodStart.day, period_end_month: item.periodEnd.month, period_end_day: item.periodEnd.day, lead_days: item.leadDays, every_n_years: item.everyNYears,
    target_role: item.targetRole, min_age_months: item.minAgeMonths, max_age_months: item.maxAgeMonths, situation_key: item.situationKey, situation_required_value: item.situationValue,
    source_reference: item.sourceReference, reviewed_at: item.reviewedAt, reviewed_by: item.reviewedBy,
  };
}

const FIELDS = COLUMNS.filter((c) => c !== "code" && c !== "version");

function differences(before: Row, after: ReturnType<typeof toRow>) {
  return FIELDS.flatMap((field) => {
    const a = field === "reviewed_at" ? day(before.reviewed_at) : (before as unknown as Record<string, unknown>)[field];
    const b = (after as unknown as Record<string, unknown>)[field];
    return a === b ? [] : [{ field, before: a, after: b }];
  });
}

async function current(db: Db): Promise<Map<string, Row>> {
  const rows = (await db.selectFrom("anticipation_catalog_items").select(COLUMNS as never).execute()) as unknown as Row[];
  return new Map(rows.map((r) => [r.code, r]));
}

/** Ce que le chargement ferait, sans rien modifier : rappels créés, modifiés (avec les champs changés), désactivés et inchangés (US-111 RF6). */
export async function previewCatalog(db: Db, items: CatalogItem[]): Promise<CatalogPreview> {
  const existing = await current(db);
  const preview: CatalogPreview = { created: [], updated: [], deactivated: [], unchanged: [] };
  const inFile = new Set(items.map((i) => i.code));
  for (const item of items) {
    const row = existing.get(item.code);
    if (!row) preview.created.push(item.code);
    else {
      const changes = differences(row, toRow(item));
      if (changes.length) preview.updated.push({ code: item.code, changes });
      else preview.unchanged.push(item.code);
    }
  }
  for (const [code, row] of existing) if (!inFile.has(code) && row.active) preview.deactivated.push(code);
  return preview;
}

export interface CatalogResult extends CatalogPreview {
  /** Questions encore sans réponse retirées parce que leur rappel est désactivé (US-111 RF9). */
  withdrawnQuestions: number;
}

/**
 * Applique le fichier par code, en une seule transaction (US-111 RF7, RF8, RT2) : un code nouveau crée un rappel, un code existant le met à jour (sa version monte quand son
 * contenu change), un rappel absent du fichier est désactivé, jamais supprimé. Un rappel désactivé n'est plus proposé et ses questions sans réponse sont retirées ; les réponses
 * déjà données sont conservées (RF9).
 */
export async function applyCatalog(db: Db, items: CatalogItem[]): Promise<CatalogResult> {
  return db.transaction().execute(async (trx) => {
    const preview = await previewCatalog(trx, items);
    for (const item of items) {
      const row = toRow(item);
      if (preview.created.includes(item.code)) await trx.insertInto("anticipation_catalog_items").values(row as never).execute();
      else if (preview.updated.some((u) => u.code === item.code)) {
        await trx.updateTable("anticipation_catalog_items").set({ ...row, version: sql<number>`version + 1` } as never).where("code", "=", item.code).execute();
      }
    }
    const gone = [...preview.deactivated, ...items.filter((i) => !i.active).map((i) => i.code)];
    if (preview.deactivated.length) await trx.updateTable("anticipation_catalog_items").set({ active: false, version: sql<number>`version + 1` }).where("code", "in", preview.deactivated).execute();
    let withdrawn = 0;
    if (gone.length) {
      const removed = await trx
        .deleteFrom("anticipation_questions")
        .where("status", "in", ["pending", "snoozed"])
        .where("catalog_item_id", "in", trx.selectFrom("anticipation_catalog_items").select("id").where("code", "in", gone))
        .executeTakeFirst();
      withdrawn = Number(removed.numDeletedRows);
    }
    return { ...preview, withdrawnQuestions: withdrawn };
  });
}

export async function situationKeys(db: Db): Promise<string[]> {
  return (await db.selectFrom("family_situation_questions").select("situation_key").orderBy("sort_order").execute()).map((r) => r.situation_key);
}
