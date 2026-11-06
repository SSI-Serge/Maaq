"use client";

import { useState } from "react";
import { useApiQuery } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import family from "@/components/family/family.module.css";
import { Loading, Notice, RetryNotice } from "@/components/ui";
import type { BudgetView } from "@/server/courses/budget";
import { euro } from "./ListScreen";
import styles from "./courses.module.css";

const BACK = { href: "/courses", label: "Courses et repas" };
const MONTH_NAMES = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

const money = (value: number | null) => (value === null ? "—" : euro(value));

/** « Budget par rayon » (US-163) : dépenses du mois passé et moyennes mensuelles, d'après les tickets enregistrés. Réservé au couple. */
export function CoursesBudgetScreen() {
  const [compare, setCompare] = useState<number | null>(null);
  const query = useApiQuery<{ view: BudgetView }>(`/api/courses/budget${compare ? `?compare=${compare}` : ""}`);
  const forbidden = query.error?.body?.code === "forbidden";
  return (
    <AppShell title="Budget par rayon" eyebrow="Courses et repas" back={BACK}>
      <p className={family.hint}>Calculé seulement à partir des tickets enregistrés. Les achats cochés sans ticket n&apos;y figurent pas.</p>
      {query.loading && !query.data && <Loading slow={query.slow} label="Chargement du budget…" />}
      {forbidden && <Notice tone="info">Le budget est réservé aux deux parents du couple.</Notice>}
      {query.error && !forbidden && <RetryNotice message="Le budget n'a pas pu être chargé." onRetry={query.reload} />}
      {query.data && <Table view={query.data.view} compare={compare} onCompare={setCompare} />}
    </AppShell>
  );
}

function Table({ view, compare, onCompare }: { view: BudgetView; compare: number | null; onCompare: (year: number) => void }) {
  const { budget } = view;
  if (view.empty) return <p className={styles.empty}>Aucun ticket enregistré pour l&apos;instant. Enregistrez un ticket de caisse pour commencer.</p>;
  const [year, month] = budget.lastMonth.split("-").map(Number);
  return (
    <>
      {budget.previousYears.length > 0 && (
        <div className={family.wrapRow} role="group" aria-label="Comparer à">
          <span className={family.label} style={{ alignSelf: "center" }}>
            Comparer à :
          </span>
          {budget.previousYears.map((y) => (
            <button key={y} type="button" className={family.chipToggle} aria-pressed={(compare ?? budget.previousYear) === y} onClick={() => onCompare(y)}>
              {y}
            </button>
          ))}
        </div>
      )}
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">Rayon</th>
            <th scope="col">{view.monthLabel}</th>
            <th scope="col">Moy. {budget.year}</th>
            <th scope="col">{budget.previousYear ? `Moy. ${budget.previousYear}` : "—"}</th>
          </tr>
        </thead>
        <tbody>
          {budget.rows.map((r) => (
            <tr key={r.rayon}>
              <th scope="row">{r.rayon}</th>
              <td>{money(r.lastMonth)}</td>
              <td>{money(r.currentYearAverage)}</td>
              <td className={styles.soft}>{money(r.previousYearAverage)}</td>
            </tr>
          ))}
          <tr className={styles.totalLine}>
            <th scope="row">Total</th>
            <td>{money(budget.total.lastMonth)}</td>
            <td>{money(budget.total.currentYearAverage)}</td>
            <td className={styles.soft}>{money(budget.total.previousYearAverage)}</td>
          </tr>
        </tbody>
      </table>
      <p className={family.hint}>
        Moyennes mensuelles. Mois passé : {MONTH_NAMES[month - 1]} {year}. Jour du budget : {view.budgetDay === 1 ? "le 1er" : `le ${view.budgetDay}`} du mois.
      </p>
    </>
  );
}
