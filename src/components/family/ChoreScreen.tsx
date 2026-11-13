"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useApiQuery } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import { Loading, Notice, RetryNotice } from "@/components/ui";
import type { ChoreDetail } from "@/server/assistant/chores";
import { aboutMinutes, CHORE_DAYS, clockLabel } from "./ChoresSettings";
import styles from "./family.module.css";

const card = { background: "var(--bg-raised)", border: "1px solid var(--line)", borderRadius: "var(--radius)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6 } as const;
const kick = { fontFamily: "var(--font-mono, 'IBM Plex Mono', monospace)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--ink-soft)" } as const;
const pill = { display: "inline-flex", alignItems: "center", fontSize: 12, fontWeight: 700, borderRadius: 100, padding: "3px 10px", background: "var(--bg-sunken)" } as const;
const dayName = (day: number) => CHORE_DAYS[day - 1]?.name ?? "";
const previous = (day: number) => (day === 1 ? 7 : day - 1);

/**
 * Le pas à pas d'une tâche ménagère (US-182, maquette RDV-Tache-Menage v89), dans l'ordre : nom, temps et personne ; « À ne jamais faire », toujours visible ; le lien
 * « Première fois ? » ; les gestes, à cocher pour se repérer (rien n'est enregistré) ; « Si ça ne se passe pas bien » ; « Avant de commencer », replié, en bas.
 * Sorties de poubelles : quel bac pour quoi et ses jours de collecte, le soir de collecte, l'entretien et les autres déchets, sans « Avant de commencer ».
 */
export function ChoreDetailView({ d, binId }: { d: ChoreDetail; binId: number | null }) {
  const [ticked, setTicked] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState(false);
  const before = useRef<HTMLDivElement>(null);
  const collection = d.mode === "day_before_collection";
  const bin = binId !== null ? d.bins.find((b) => b.binId === binId) : undefined;
  const ironing = (d.before?.fabrics.length ?? 0) > 0;
  const toggle = (i: number) => setTicked((cur) => { const next = new Set(cur); if (next.has(i)) next.delete(i); else next.add(i); return next; });
  const firstTime = () => {
    setOpen(true);
    setTimeout(() => before.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };
  return (
    <>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        <span style={pill}>⏱ {aboutMinutes(d.minutes)}</span>
        <span style={pill}>{d.person ?? "Personne"}</span>
        {!collection && d.days.length > 0 && <span style={pill}>{d.days.map(dayName).join(", ")}</span>}
        {bin?.collectionDay && d.binTime && <span style={pill}>le {dayName(previous(bin.collectionDay))} à {clockLabel(d.binTime)}</span>}
      </div>

      {d.neverDo.length > 0 && (
        <div role="note" aria-label="À ne jamais faire" style={{ background: "var(--error-bg)", borderLeft: "4px solid var(--error)", borderRadius: "var(--radius)", padding: "10px 12px" }}>
          <div style={{ fontWeight: 700, fontSize: 13, color: "var(--error)" }}>⚠ À ne jamais faire</div>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: 13, lineHeight: 1.45 }}>
            {d.neverDo.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}

      {d.before && (
        <button type="button" onClick={firstTime} style={{ alignSelf: "flex-start", border: "none", background: "none", padding: "2px 0", textAlign: "left", fontSize: 13, fontWeight: 700, color: "var(--primary)", textDecoration: "underline", lineHeight: 1.4, cursor: "pointer" }}>
          Première fois ? Règles d&apos;or, matériel et produits dans « Avant de commencer » ›
        </button>
      )}
      {d.intro.map((t, i) => (
        <p key={i} className={styles.hint} style={{ margin: 0, fontSize: 13 }}>
          {t}
        </p>
      ))}

      {collection && (
        <>
          <div style={kick}>Quel bac pour quoi</div>
          {d.bins.map((b) => (
            <div key={b.binId} style={{ ...card, borderColor: b.binId === binId ? "var(--primary)" : "var(--line)" }}>
              <b>{b.name}</b>
              <span style={{ fontSize: 13 }}>{b.contents}</span>
              <span className={styles.hint}>
                {b.collectionDay ? `Collecte le ${dayName(b.collectionDay)} · à sortir le ${dayName(previous(b.collectionDay))} à ${clockLabel(d.binTime ?? "19:00")}` : `Pas de collecte${b.hint ? ` (${b.hint})` : ""}`}
              </span>
            </div>
          ))}
          <Link href="/assistant/reglages" className={styles.link}>
            Changer les jours de collecte ›
          </Link>
        </>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <span style={{ fontWeight: 700 }}>{ironing ? "Pas à pas par pièce" : collection ? "Le soir de collecte" : "Les gestes, dans l'ordre"}</span>
        {!collection && (
          <span className={styles.hint}>
            {ticked.size} sur {d.gestures.length} gestes
          </span>
        )}
      </div>
      {d.gestures.map((g, i) => (
        <div key={i} style={card}>
          <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
            <button
              type="button"
              role="checkbox"
              aria-checked={ticked.has(i)}
              aria-label={g.name}
              onClick={() => toggle(i)}
              style={{ width: 26, height: 26, flexShrink: 0, borderRadius: 6, border: `2px solid ${ticked.has(i) ? "var(--success)" : "var(--line)"}`, background: ticked.has(i) ? "var(--success)" : "transparent", color: "#fff", fontWeight: 700, cursor: "pointer" }}
            >
              {ticked.has(i) ? "✓" : ""}
            </button>
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontWeight: 700, fontSize: 14, textDecoration: ticked.has(i) ? "line-through" : undefined }}>
                {i + 1}. {g.name}
              </span>
              {(g.product || g.minutes) && <span className={styles.hint}>{[g.product, g.minutes ? `${g.minutes} min` : null].filter(Boolean).join(" · ")}</span>}
            </div>
          </div>
          <ol style={{ margin: 0, paddingLeft: 54, fontSize: 13, lineHeight: 1.45 }}>
            {g.steps.map((s, j) => (
              <li key={j}>{s}</li>
            ))}
          </ol>
        </div>
      ))}
      <p className={styles.hint} style={{ margin: 0 }}>
        Ces coches vous aident à vous repérer. La tâche entière se coche dans la liste des tâches.
      </p>

      {d.notes.length > 0 && (
        <div style={card}>
          {d.notes.map((n, i) => (
            <div key={i} style={{ fontSize: 13, lineHeight: 1.45 }}>
              {n.title && (i === 0 || d.notes[i - 1].title !== n.title) && <div style={{ ...kick, paddingTop: i ? 6 : 0 }}>{n.title}</div>}
              {n.body}
            </div>
          ))}
        </div>
      )}

      {/* Toujours affichée, au moins avec la ligne fixe « Problème que ce guide ne couvre pas » (décision du PO). */}
      {d.troubleshooting.length > 0 && (
        <>
          <div style={{ fontWeight: 700 }}>Si ça ne se passe pas bien</div>
          <div style={card}>
            {d.troubleshooting.map((x, i) => (
              <div key={i} style={{ display: "flex", flexDirection: "column", gap: 1, fontSize: 13, lineHeight: 1.4, borderTop: i ? "1px solid var(--line)" : undefined, paddingTop: i ? 6 : 0 }}>
                <b>{x.problem}</b>
                <span>{x.solution}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {d.before && (
        <div ref={before} style={card}>
          <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%", border: "none", background: "none", padding: 0, fontWeight: 700, fontSize: 14, color: "var(--ink)", cursor: "pointer" }}>
            <span>Avant de commencer</span>
            <span aria-hidden="true">{open ? "▾" : "▸"}</span>
          </button>
          {open && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 13, lineHeight: 1.45 }}>
              {d.before.steps.length > 0 && (
                <ol style={{ margin: 0, paddingLeft: 18 }}>
                  {d.before.steps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              )}
              {d.before.fabrics.length > 0 && (
                <div>
                  <div style={kick}>Réglages par tissu</div>
                  {d.before.fabrics.map((x) => (
                    <div key={x.fabric} style={{ display: "flex", flexDirection: "column", padding: "4px 0", borderBottom: "1px solid var(--line)" }}>
                      <b>{x.fabric}</b>
                      <span>
                        {x.points} point{x.points > 1 ? "s" : ""} · {x.temperature} °C max
                      </span>
                      <span className={styles.hint}>{x.advice}</span>
                    </div>
                  ))}
                </div>
              )}
              <div>
                <div style={kick}>Les {d.before.rules.length} règles d&apos;or</div>
                <ol style={{ margin: 0, paddingLeft: 18 }}>
                  {d.before.rules.map((r) => (
                    <li key={r.title}>
                      <b>{r.title}</b> : {r.body}
                    </li>
                  ))}
                </ol>
              </div>
              {d.before.materials.length > 0 && (
                <div>
                  <div style={kick}>Le matériel</div>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {d.before.materials.map((m) => (
                      <li key={m.name}>
                        {m.name}
                        {m.detail ? ` : ${m.detail}` : ""}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {d.before.products.length > 0 && (
                <div>
                  <div style={kick}>Les produits de cette tâche</div>
                  {d.before.products.map((p) => (
                    <div key={p.name} style={{ display: "flex", flexDirection: "column", padding: "4px 0", borderBottom: "1px solid var(--line)" }}>
                      <b>
                        {p.name}
                        {p.optional ? " (facultatif)" : ""}
                      </b>
                      <span>Sert à : {p.usedFor}</span>
                      {p.avoidOn && <span>À ne pas utiliser sur : {p.avoidOn}</span>}
                    </div>
                  ))}
                </div>
              )}
              {d.before.recipes.length > 0 && (
                <div>
                  <div style={kick}>Recettes et dosages</div>
                  {d.before.recipes.map((r) => (
                    <div key={r.name} style={{ display: "flex", flexDirection: "column", padding: "4px 0", borderBottom: "1px solid var(--line)" }}>
                      <b>{r.name}</b>
                      <span>{r.dosage}</span>
                      <span className={styles.hint}>Pour : {r.usedFor}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <Link href="/assistant/taches" className={styles.link}>
        Retour aux tâches
      </Link>
    </>
  );
}

/** Écran « Tâche ménagère » : `/assistant/taches/menage/[id]`, `?bac=` pour la tâche d'un bac (« Sortir le bac jaune »). */
export function ChoreScreen({ taskId, binId }: { taskId: string; binId: number | null }) {
  const query = useApiQuery<{ detail: ChoreDetail }>(`/api/family/chores/${taskId}`);
  const d = query.data?.detail;
  const bin = d && binId !== null ? d.bins.find((b) => b.binId === binId) : undefined;
  return (
    <AppShell title={bin?.taskTitle ?? d?.name ?? "Tâche ménagère"} eyebrow={d?.mode === "day_before_collection" ? "Sorties de poubelles" : "Tâche ménagère"} back={{ href: "/assistant/taches", label: "Tâches" }}>
      {query.loading && !d && <Loading slow={query.slow} />}
      {query.error?.body?.code === "not_found" && <Notice tone="info">Cette tâche n&apos;est plus proposée.</Notice>}
      {query.error && query.error.body?.code !== "not_found" && <RetryNotice message={query.error.kind === "server" ? "Le pas à pas n'a pas pu être chargé." : query.error.message} onRetry={query.reload} />}
      {d && <ChoreDetailView d={d} binId={binId} />}
    </AppShell>
  );
}
