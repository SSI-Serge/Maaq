"use client";

import { useState } from "react";
import type { MenuSummary } from "@/server/courses/list/service";
import { servingsNote } from "./menu-text";
import styles from "./courses.module.css";

type Recipe = MenuSummary["recipes"][number];

/** Imprime un bloc de la page : une fenêtre propre avec seulement ce bloc, pour ne pas imprimer toute la liste de courses. */
function printBlock(title: string, element: HTMLElement | null): void {
  if (!element) return;
  const win = window.open("", "_blank", "width=720,height=900");
  if (!win) return;
  win.document.write(
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${title.replace(/</g, "&lt;")}</title><style>body{font-family:system-ui,sans-serif;margin:24px;color:#222;font-size:14px;line-height:1.5}h1{font-size:20px}h2{font-size:16px;margin:18px 0 4px}ol,ul{margin:4px 0 8px;padding-left:20px}button{display:none}.meta{color:#555;font-size:12px}</style></head><body><h1>${title.replace(/</g, "&lt;")}</h1>${element.innerHTML}</body></html>`,
  );
  win.document.close();
  win.focus();
  win.print();
}

/** Recette d'un plat : ingrédients et étapes pour 4 personnes, ou « Recette non renseignée » (CR-46). */
function RecipeBody({ recipe }: { recipe: Recipe }) {
  if (!recipe.ingredients.length && !recipe.steps.length) return <p className={styles.meta}>Recette non renseignée. Vous pouvez l&apos;ajouter dans « Mes plats ».</p>;
  return (
    <div style={{ fontSize: 12, lineHeight: 1.5 }}>
      <div className={styles.meta} style={{ textTransform: "uppercase" }}>
        Ingrédients · pour 4
      </div>
      <div>{recipe.ingredients.join(", ") || "—"}</div>
      <div className={styles.meta} style={{ textTransform: "uppercase", paddingTop: 4 }}>
        Étapes
      </div>
      {recipe.steps.length ? (
        <ol style={{ margin: 0, paddingLeft: 18, display: "flex", flexDirection: "column", gap: 2 }}>
          {recipe.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ol>
      ) : (
        <p className={styles.meta} style={{ margin: 0 }}>
          Étapes non renseignées.
        </p>
      )}
    </div>
  );
}

/** Liste de plats avec recette dépliable ; `all` déplie ou replie tout d'un coup. */
export function RecipeList({ recipes, householdSize, title, showDays }: { recipes: Recipe[]; householdSize: number | null; title: string; showDays: boolean }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [ref, setRef] = useState<HTMLDivElement | null>(null);
  const key = (r: Recipe) => `${r.kind}:${r.day}:${r.name}`;
  const allOpen = recipes.length > 0 && open.size === recipes.length;
  const note = servingsNote(householdSize);
  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, padding: "6px 0", flexWrap: "wrap" }}>
        {note && <span style={{ fontSize: 12 }}>{note}</span>}
        <button type="button" className={styles.link} style={{ background: "none", border: "none", padding: "4px 0", marginLeft: "auto" }} onClick={() => setOpen(allOpen ? new Set() : new Set(recipes.map(key)))}>
          {allOpen ? "Replier toutes les recettes" : "Déplier toutes les recettes"}
        </button>
        <button type="button" className={styles.link} style={{ border: "1px solid var(--line)", borderRadius: 8, background: "transparent", padding: "6px 10px" }} onClick={() => printBlock(title, ref)}>
          Imprimer les recettes
        </button>
      </div>
      <div ref={setRef}>
        {recipes.map((r) => {
          const k = key(r);
          const isOpen = open.has(k);
          return (
            <div key={k} style={{ borderBottom: "1px solid var(--line)" }}>
              <button
                type="button"
                aria-expanded={isOpen}
                onClick={() => setOpen((cur) => { const next = new Set(cur); if (next.has(k)) next.delete(k); else next.add(k); return next; })}
                style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "8px 0", border: "none", background: "none", textAlign: "left", fontSize: 13, color: "var(--ink)" }}
              >
                {showDays && <span className={styles.meta} style={{ width: 62, flexShrink: 0 }}>{r.day}</span>}
                <span style={{ flex: 1, fontWeight: 600 }}>{r.name}</span>
                <span className={styles.meta}>{r.time}</span>
                <span aria-hidden="true" style={{ width: 14, color: "var(--ink-soft)" }}>{isOpen ? "⌃" : "⌄"}</span>
              </button>
              {isOpen && (
                <div style={{ paddingBottom: 8 }}>
                  <RecipeBody recipe={r} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Séance de batch : durée (réelle ou estimée), déroulé étape par étape, chevauchements, conservation de chaque plat (CR-47). */
export function BatchSession({ summary }: { summary: MenuSummary }) {
  const [ref, setRef] = useState<HTMLDivElement | null>(null);
  const { session, batch } = summary;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "6px 0" }}>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.45 }}>
        Dimanche, {session.label}
        {session.estimated ? " (durée estimée)" : ""}
        {session.theme ? ` · semaine type « ${session.theme} »` : ""}. Lundi à vendredi.
      </p>
      {session.overCap && <div style={{ alignSelf: "flex-start", fontSize: 12, fontWeight: 700, background: "var(--warning-bg)", borderRadius: 6, padding: "4px 8px" }}>Séance au-dessus de 2 h.</div>}
      {(batch.steps.length > 0 || batch.storage.length > 0) && (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, paddingTop: 4 }}>
            <span className={styles.meta} style={{ textTransform: "uppercase" }}>
              Déroulé
            </span>
            <button type="button" className={styles.link} style={{ border: "1px solid var(--line)", borderRadius: 8, background: "transparent", padding: "6px 10px" }} onClick={() => printBlock("Séance de batch", ref)}>
              Imprimer la séance
            </button>
          </div>
          <div ref={setRef}>
            <ol style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 6, fontSize: 13, lineHeight: 1.4 }}>
              {batch.steps.map((s) => (
                <li key={s.position}>
                  <span style={{ display: "block" }}>{s.text}</span>
                  {(s.dish || s.minutes) && (
                    <span className={styles.meta} style={{ display: "block" }}>
                      {[s.dish, s.minutes ? `⏱ ${s.minutes} min` : null].filter(Boolean).join(" · ")}
                    </span>
                  )}
                  {s.overlap && <span style={{ display: "inline-block", marginTop: 3, fontSize: 10, fontWeight: 700, borderRadius: 100, padding: "2px 8px", background: "var(--success-bg)" }}>{s.overlap}</span>}
                </li>
              ))}
            </ol>
            {batch.overlapping && (
              <div style={{ fontSize: 12, fontWeight: 700, background: "var(--bg-sunken)", borderRadius: 6, padding: "6px 8px", marginTop: 6 }}>
                Les étapes se chevauchent : durée totale de la séance {session.estimated ? "environ " : ""}
                {session.label}.
              </div>
            )}
            {batch.storage.length > 0 && (
              <>
                <div className={styles.meta} style={{ textTransform: "uppercase", paddingTop: 6 }}>
                  Conservation
                </div>
                {batch.storage.map((c) => (
                  <div key={c.dish} style={{ display: "flex", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--line)", fontSize: 12, lineHeight: 1.4 }}>
                    <span style={{ flex: 1, fontWeight: 600 }}>{c.dish}</span>
                    <span style={{ flex: 1.3 }}>{c.how}</span>
                  </div>
                ))}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
