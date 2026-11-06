import { round2 } from "./text";

/** Une ligne de ticket enregistrée, pour le budget (US-163). */
export interface SpendLine {
  /** Date du ticket « AAAA-MM-JJ ». */
  date: string;
  rayon: string;
  total: number;
}

export interface BudgetRow {
  rayon: string;
  /** Dépenses du mois passé. */
  lastMonth: number;
  /** Moyenne mensuelle de l'année en cours (sur les mois qui ont des tickets) ; null sans ticket cette année. */
  currentYearAverage: number | null;
  /** Moyenne mensuelle de l'année précédente choisie ; null si elle n'a pas de ticket. */
  previousYearAverage: number | null;
}

export interface Budget {
  /** Mois passé « AAAA-MM ». */
  lastMonth: string;
  year: number;
  previousYear: number | null;
  /** Années disponibles avant l'année en cours (deux au plus, CR-23). */
  previousYears: number[];
  rows: BudgetRow[];
  total: BudgetRow;
}

/**
 * Budget par rayon (US-163 RF1) : dépenses du mois passé, moyenne mensuelle de l'année en cours et d'une année précédente.
 * Les moyennes portent sur les mois où le foyer a enregistré au moins un ticket, comme dans courses.py.
 */
export function buildBudget(lines: SpendLine[], today: Date, previousYear?: number | null): Budget {
  const year = today.getFullYear();
  const last = new Date(year, today.getMonth() - 1, 1);
  const lastKey = `${last.getFullYear()}-${String(last.getMonth() + 1).padStart(2, "0")}`;
  const byRayon = new Map<string, Map<string, number>>();
  for (const l of lines) {
    const month = l.date.slice(0, 7);
    const rayon = l.rayon || "Autres";
    const m = byRayon.get(rayon) ?? new Map<string, number>();
    m.set(month, (m.get(month) ?? 0) + l.total);
    byRayon.set(rayon, m);
  }
  const months = [...new Set([...byRayon.values()].flatMap((m) => [...m.keys()]))].sort();
  const previousYears = [...new Set(months.map((m) => Number(m.slice(0, 4))).filter((y) => y < year))].sort((a, b) => b - a).slice(0, 2);
  const chosen = previousYear && previousYears.includes(previousYear) ? previousYear : (previousYears[0] ?? null);
  const average = (spend: (month: string) => number, ofYear: number): number | null => {
    const ms = months.filter((m) => m.startsWith(String(ofYear)));
    return ms.length ? round2(ms.reduce((s, m) => s + spend(m), 0) / ms.length) : null;
  };
  const row = (rayon: string, spend: (month: string) => number): BudgetRow => ({
    rayon,
    lastMonth: round2(spend(lastKey)),
    currentYearAverage: average(spend, year),
    previousYearAverage: chosen === null ? null : average(spend, chosen),
  });
  const rows = [...byRayon.keys()].sort((a, b) => a.localeCompare(b, "fr")).map((r) => row(r, (m) => byRayon.get(r)!.get(m) ?? 0));
  const total = row("TOTAL", (m) => [...byRayon.values()].reduce((s, v) => s + (v.get(m) ?? 0), 0));
  return { lastMonth: lastKey, year, previousYear: chosen, previousYears, rows, total };
}
