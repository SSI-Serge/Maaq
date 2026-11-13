"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import { Loading, Notice, RetryNotice } from "@/components/ui";
import type { MenuSummary } from "@/server/courses/list/service";
import type { WeekMenuView } from "@/server/courses/menu-week";
import { BatchSession, RecipeBody } from "./MenuRecipes";
import styles from "./courses.module.css";

const BACK = { href: "/courses", label: "Courses et repas" };
const DAY_NAMES = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"];
const SHORT = ["Lun.", "Mar.", "Mer.", "Jeu.", "Ven.", "Sam.", "Dim."];
const kick = { fontFamily: "var(--font-mono, 'IBM Plex Mono', monospace)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--ink-soft)", paddingTop: 4 } as const;
const cardStyle = { background: "var(--bg-raised)", border: "1px solid var(--line)", borderRadius: "var(--radius)", padding: "2px 14px" } as const;

type Recipe = MenuSummary["recipes"][number];

/** Jour du mois d'un rang de la semaine (1 = lundi), à partir du lundi « AAAA-MM-JJ ». */
function dayOfMonth(week: string, slot: number): number {
  const [y, m, d] = week.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + slot - 1)).getUTCDate();
}

/** Rang d'un plat dans le menu : `dinner:3` pour le dîner du mercredi, `express:2` pour le deuxième plat express. */
function slotOf(recipe: Recipe): string {
  return recipe.kind === "dinner" ? `dinner:${DAY_NAMES.indexOf(recipe.day) + 1}` : `express:${Number(recipe.day.replace(/\D/g, "")) || 0}`;
}

/**
 * Les plats d'un menu validé (maquette CR-Menu-Semaine) : une ligne par plat, recette dépliable. Un dîner porte son jour (« Lun. 9 »), « Ce soir » le jour même et
 * « Passé » avant ; un plat express n'a pas de jour dans les données. Un plat qui n'est pas encore dans « Mes plats » propose « Ajouter à mes plats ».
 */
export function MenuDishRows({ week, today, recipes, servings, addable, added, busy, onAdd }: { week: string; today: number | null; recipes: Recipe[]; servings: number | null; addable: string[]; added: string[]; busy: boolean; onAdd: (slot: string) => void }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  return (
    <div style={cardStyle}>
      {recipes.map((r, i) => {
        const slot = slotOf(r);
        const rank = r.kind === "dinner" ? DAY_NAMES.indexOf(r.day) + 1 : 0;
        const past = r.kind === "dinner" && today !== null && rank < today;
        const tonight = r.kind === "dinner" && today !== null && rank === today;
        const isOpen = open.has(slot);
        return (
          <div key={slot} style={{ borderTop: i ? "1px solid var(--line)" : undefined, opacity: past ? 0.6 : 1 }}>
            <button
              type="button"
              aria-expanded={isOpen}
              onClick={() => setOpen((cur) => { const next = new Set(cur); if (next.has(slot)) next.delete(slot); else next.add(slot); return next; })}
              style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "10px 0", border: "none", background: "none", textAlign: "left", color: "var(--ink)" }}
            >
              <span style={{ width: 66, flexShrink: 0, fontSize: 12, fontWeight: 700, color: "var(--ink-soft)" }}>{r.kind === "dinner" ? `${SHORT[rank - 1] ?? ""} ${dayOfMonth(week, rank)}` : "Express"}</span>
              <span style={{ flex: 1 }}>
                <span style={{ display: "block", fontSize: 14, fontWeight: 600 }}>{r.name}</span>
                {tonight && <span style={{ display: "inline-block", marginTop: 2, fontSize: 10, fontWeight: 700, borderRadius: 100, padding: "2px 8px", background: "var(--secondary-soft)", color: "var(--secondary-strong)" }}>Ce soir</span>}
                {past && <span style={{ display: "block", fontSize: 11, color: "var(--ink-soft)" }}>Passé</span>}
              </span>
              <span className={styles.meta} style={{ whiteSpace: "nowrap" }}>{r.time}</span>
              <span aria-hidden="true" style={{ color: "var(--ink-soft)" }}>{isOpen ? "▾" : "▸"}</span>
            </button>
            {isOpen && (
              <div style={{ padding: "0 0 10px 74px" }}>
                <RecipeBody recipe={r} servings={servings} />
              </div>
            )}
            {addable.includes(slot) && !added.includes(slot) && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0 0 10px 74px" }}>
                <span className={styles.meta} style={{ flex: 1 }}>Nouveau plat, pas encore dans « Mes plats ».</span>
                <button type="button" disabled={busy} onClick={() => onAdd(slot)} style={{ border: "1px solid var(--line)", borderRadius: 7, background: "transparent", minHeight: 30, padding: "0 10px", fontSize: 12, fontWeight: 700, color: "var(--ink)" }}>
                  Ajouter à mes plats
                </button>
              </div>
            )}
            {added.includes(slot) && <div style={{ padding: "0 0 10px 74px", fontSize: 12, fontWeight: 700, color: "var(--success)" }}>✓ Ajouté à « Mes plats »</div>}
          </div>
        );
      })}
    </div>
  );
}

function Menu({ view, onWeek, reload }: { view: WeekMenuView; onWeek: (week: string) => void; reload: () => void }) {
  const add = useApiMutation();
  const [added, setAdded] = useState<string[]>([]);
  const menu = view.menu;
  const tab = view.tabs.find((t) => t.week === view.week);

  async function addDish(slot: string) {
    if (await add.run("/api/courses/chat/menu/dishes", { method: "POST", body: { week: view.week, slots: [slot] } })) setAdded((cur) => [...cur, slot]);
  }

  const dinners = menu?.recipes.filter((r) => r.kind === "dinner") ?? [];
  const express = menu?.recipes.filter((r) => r.kind === "express") ?? [];
  const addable = view.addable.map((a) => a.slot);
  const count = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
  return (
    <>
      <div role="group" aria-label="Semaine" style={{ display: "flex", gap: 6 }}>
        {view.tabs.map((t) => {
          const on = t.week === view.week;
          return (
            <button key={t.week} type="button" aria-pressed={on} onClick={() => onWeek(t.week)} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 1, minHeight: 44, borderRadius: 8, fontSize: 13, fontWeight: 700, border: `1px solid ${on ? "var(--primary)" : "var(--line)"}`, background: on ? "var(--primary)" : "transparent", color: on ? "var(--primary-ink)" : "var(--ink)" }}>
              <span style={{ fontSize: 10, fontWeight: 600 }}>{t.label}</span>
              <span>{t.range.replace(/^du /, "")}</span>
            </button>
          );
        })}
      </div>

      {!menu && (
        <>
          <Notice tone="info">Aucun menu validé {tab?.range ?? "pour cette semaine"}.</Notice>
          <Link href="/courses?menu=1" className={styles.scenarioCard} style={{ minHeight: 44, background: "var(--primary)", borderColor: "var(--primary)", color: "var(--primary-ink)" }}>
            <span>Préparer le menu de la semaine</span>
            <span aria-hidden="true">›</span>
          </Link>
        </>
      )}

      {menu && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontFamily: "var(--font-serif, 'Newsreader', serif)", fontSize: 18 }}>{(tab?.range ?? "").replace(/^d/, "D")}</span>
            <span className={styles.meta}>
              {count(dinners.length, "dîner", "dîners")}
              {express.length ? ` · ${count(express.length, "plat express", "plats express")}` : ""}
            </span>
          </div>
          <Link href={view.listValidated ? `/courses/ma-liste?week=${view.week}` : `/courses/liste?week=${view.week}`} className={styles.scenarioCard} style={{ background: "var(--primary-soft)" }}>
            <span>
              <div className={styles.lineName}>{view.listValidated ? "Liste de courses de la semaine" : "Préparer la liste de courses"}</div>
              <div className={styles.lineSub}>{view.listValidated ? "Validée" : "Comparatif des prix et choix des magasins pour ce menu"}</div>
            </span>
            <span aria-hidden="true">›</span>
          </Link>

          <div style={kick}>Dîners · touchez un plat pour sa recette</div>
          <MenuDishRows week={view.week} today={view.today} recipes={dinners} servings={menu.servings} addable={addable} added={added} busy={add.pending} onAdd={(slot) => void addDish(slot)} />

          {express.length > 0 && (
            <>
              <div style={kick}>{count(express.length, "plat express", "plats express")}</div>
              <MenuDishRows week={view.week} today={null} recipes={express} servings={menu.servings} addable={addable} added={added} busy={add.pending} onAdd={(slot) => void addDish(slot)} />
            </>
          )}
          {add.error && <Notice tone="error">{add.error.kind === "server" ? "Le plat n'a pas pu être ajouté à « Mes plats »." : add.error.message}</Notice>}

          <div style={kick}>Séance de batch · déroulé</div>
          <div style={{ ...cardStyle, padding: "12px 14px" }}>
            <BatchSession summary={menu} onWritten={reload} />
          </div>
          <Link href={`/courses/liste?week=${view.week}`} className={styles.link} style={{ alignSelf: "flex-start" }}>
            Ingrédients de la semaine dans la liste ›
          </Link>
          <p className={styles.meta} style={{ margin: 0 }}>
            Pour changer ce menu, demandez-le dans le tchat de Courses et repas.
          </p>
        </>
      )}
    </>
  );
}

function Screen() {
  const params = useSearchParams();
  const asked = params.get("week");
  const [week, setWeek] = useState<string | null>(asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : null);
  const query = useApiQuery<{ view: WeekMenuView }>(`/api/courses/menu${week ? `?week=${week}` : ""}`);
  const forbidden = query.error?.body?.code === "forbidden";
  return (
    <>
      {query.loading && !query.data && <Loading slow={query.slow} />}
      {forbidden && <Notice tone="info">Le menu de la semaine est réservé aux deux parents du foyer.</Notice>}
      {query.error && !forbidden && <RetryNotice message={query.error.kind === "server" ? "Le menu n'a pas pu être chargé." : query.error.message} onRetry={query.reload} />}
      {query.data && <Menu key={query.data.view.week} view={query.data.view} onWeek={setWeek} reload={query.reload} />}
    </>
  );
}

/** Écran « Menu de la semaine » de Courses et repas (CR-72, US-180bis) : le menu validé complet, cette semaine ou la suivante. Réservé au couple. */
export function MenuWeekScreen() {
  return (
    <AppShell title="Menu de la semaine" eyebrow="Courses et repas" back={BACK}>
      <Suspense fallback={<Loading />}>
        <Screen />
      </Suspense>
    </AppShell>
  );
}
