"use client";

import Link from "next/link";
import { useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell, Section } from "@/components/app/AppShell";
import { Loading, Notice, RetryNotice } from "@/components/ui";
import type { PageFolder } from "@/server/assistant/homework/pages";
import type { HomeworkToday, TodayItem } from "@/server/assistant/homework/weeks";
import type { TaskLists, TaskView } from "@/server/assistant/tasks";
import { longDate, plainDate } from "./format";
import { dueTimeLabel } from "./TaskRow";
import styles from "./family.module.css";
import sheet from "./homework-page.module.css";
import week from "./homework-week.module.css";
import { weekHref } from "./homework-domains";

const WEEKDAY_NAMES = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];

/** Pastille de couleur du domaine (maths, nature…) : les mêmes couleurs que l'écran « Semaine de devoirs ». */
const Dot = ({ item, big }: { item: TodayItem; big?: boolean }) => (
  <span className={week.root} style={{ display: "inline-flex", flexShrink: 0 }} aria-hidden>
    <span style={{ width: big ? 14 : 8, height: big ? 14 : 8, borderRadius: "50%", background: `var(--c-${item.domain}, var(--ink-soft))` }} />
  </span>
);

/**
 * Écran de la tâche « Préparer les devoirs » (US-119 RF1, RF11, US-180 RF1, RF5, RF7, D71 à D73). Pour un parent : cocher la tâche pour aujourd'hui, « Préparer les devoirs » à tout
 * moment, le planning du jour de chaque enfant, le dossier « Exercices » et « Créer des exercices à partir d'une leçon » (avec le choix de l'enfant). Pour le profil d'un enfant :
 * son seul planning du jour, en lecture seule (S-40), « Créer mes exercices à partir d'une leçon » et « Mes exercices », sans corrigé. Les liens restent accessibles quand la
 * tâche est cochée, et tous les jours, pas seulement les jours de devoirs.
 */
export function HomeworkTaskScreen({ taskId }: { taskId: string | null }) {
  const today = useApiQuery<{ today: HomeworkToday }>("/api/family/homework/today");
  const lists = useApiQuery<{ lists: TaskLists }>("/api/family/tasks");
  const pages = useApiQuery<{ folder: PageFolder }>("/api/family/homework/pages");
  const check = useApiMutation();
  const [picking, setPicking] = useState(false);
  const data = today.data?.today;
  const folder = pages.data?.folder;
  const pageCount = folder?.role === "parent" ? folder.children.reduce((sum, c) => sum + c.pages.length, 0) : 0;
  const all = lists.data ? [...lists.data.lists.overdue, ...lists.data.lists.today, ...lists.data.lists.upcoming, ...lists.data.lists.done] : [];
  // La tâche ouverte depuis la liste ; sinon celle d'aujourd'hui.
  const task: TaskView | undefined = all.find((t) => t.id === taskId) ?? all.find((t) => t.isHomeworkPrep && t.due === lists.data?.lists.todayDate);
  const disabled = today.error?.body?.code === "homework_disabled";
  const forbidden = today.error?.body?.code === "forbidden";
  const child = data?.role === "child";

  async function toggle(done: boolean) {
    if (!task) return;
    if (await check.run(`/api/family/tasks/${task.id}/check`, { method: "POST", body: { done, version: task.version } })) lists.reload();
  }

  return (
    <AppShell title="Préparer les devoirs" eyebrow={child ? "Mes devoirs" : "Tâche du foyer"} back={{ href: "/assistant/taches", label: "Tâches" }}>
      {today.loading && !data && <Loading slow={today.slow} />}
      {disabled && <Notice tone="info">L&apos;aide Devoirs est désactivée pour la famille.</Notice>}
      {forbidden && <Notice tone="info">Les devoirs sont réservés aux parents du foyer et aux enfants qui ont un profil.</Notice>}
      {today.error && !disabled && !forbidden && <RetryNotice message={today.error.kind === "server" ? "Les devoirs du jour n'ont pas pu être chargés." : today.error.message} onRetry={today.reload} />}

      {data?.role === "parent" && (
        <>
          <p className={styles.hint}>
            {longDate(data.today)}
            {task?.dueTime ? ` · ${dueTimeLabel(task.dueTime)}` : ""} · les jours de devoirs : {data.days.map((d) => WEEKDAY_NAMES[d - 1]).join(", ")}. Tâche du foyer
            {data.children.some((c) => c.hasProfile) ? `, visible aussi par ${data.children.filter((c) => c.hasProfile).map((c) => c.firstName).join(" et ")}, qui ${data.children.filter((c) => c.hasProfile).length > 1 ? "ont leur profil" : "a son profil"}.` : "."}
          </p>
          {task && (
            <label className={styles.taskRow} style={{ alignItems: "center", gap: 10 }}>
              <input type="checkbox" className={styles.taskCheck} checked={task.status === "done"} disabled={!task.can.check || check.pending} onChange={(e) => void toggle(e.target.checked)} />
              <span>
                Faite pour {task.due === data.today ? "aujourd'hui" : `le ${longDate(task.due)}`}
                <span className={styles.hint} style={{ display: "block" }}>
                  Elle revient au prochain jour de devoirs.
                </span>
              </span>
            </label>
          )}
          {check.error && <Notice tone="error">{check.error.kind === "server" ? "La tâche n'a pas pu être cochée." : check.error.message}</Notice>}
          <Link href="/assistant/devoirs/preparer" className={styles.cta}>
            Préparer les devoirs
          </Link>
          <p className={styles.hint}>La semaine en cours ou une des 4 suivantes, pour tous les enfants à la fois.</p>

          <Section title="Planning du jour">
            {data.children.length === 0 && (
              <p className={styles.hint}>
                Indiquez l&apos;âge des devoirs de vos enfants dans les <Link href="/assistant/reglages">réglages</Link>.
              </p>
            )}
            {data.children.map((k) => (
              <div key={k.memberId} className={styles.form}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
                  <b>{k.firstName}</b>
                  <span className={styles.hint}>
                    Âge des devoirs : {k.homeworkAge} ans · {k.levelLabel}
                  </span>
                </div>
                {k.items.length === 0 && <span className={styles.hint}>Rien de prévu aujourd&apos;hui.</span>}
                {k.items.map((it, i) => (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--line)", fontSize: 13 }}>
                    <Dot item={it} />
                    <span style={{ flex: 1 }}>
                      {it.title}
                      <span className={styles.hint} style={{ display: "block" }}>
                        {it.sub}
                      </span>
                    </span>
                  </div>
                ))}
                {k.weekId && (
                  <Link href={weekHref(k.weekId, k.memberId)} className={styles.link}>
                    Voir la semaine de {k.firstName} ›
                  </Link>
                )}
              </div>
            ))}
          </Section>
          <Link href="/assistant/devoirs?retour=tache" className={styles.link}>
            Semaines passées ›
          </Link>
          <Section title="Exercices">
            <Link href="/assistant/devoirs/exercices" className={styles.linkRow}>
              <span>Dossier « Exercices »</span>
              <span className={styles.hint}>{folder ? `${pageCount} page${pageCount > 1 ? "s" : ""} ›` : "›"}</span>
            </Link>
            <button type="button" className={styles.cta} style={{ width: "100%" }} onClick={() => setPicking(true)} disabled={data.children.length === 0}>
              Créer des exercices à partir d&apos;une leçon
            </button>
          </Section>
          {task && task.status === "todo" && (
            <Link href={`/assistant/taches/${task.id}`} className={styles.link}>
              Changer l&apos;heure de la tâche ›
            </Link>
          )}
          {picking && (
            <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(43, 33, 31, 0.5)", display: "flex", flexDirection: "column", justifyContent: "flex-end" }}>
              <div role="dialog" aria-modal="true" aria-label="Pour quel enfant ?" className={styles.form} style={{ background: "var(--bg-raised)", borderRadius: "16px 16px 0 0" }}>
                <div className={styles.confirmTitle}>Pour quel enfant ?</div>
                <span className={styles.hint}>La page sera rangée dans son dossier.</span>
                {data.children.map((k) => (
                  <Link key={k.memberId} href={`/assistant/devoirs/lecon?enfant=${k.memberId}`} className={styles.linkRow}>
                    <span>{k.firstName}</span>
                    <span className={styles.hint}>
                      {k.levelLabel} · {k.hasProfile ? "a un profil" : "sans profil"}
                    </span>
                  </Link>
                ))}
                <button type="button" className={styles.chipToggle} onClick={() => setPicking(false)}>
                  Annuler
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {data?.role === "child" && (
        <>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <div style={{ fontFamily: "var(--font-serif, 'Newsreader', serif)", fontSize: 24 }}>Bonjour {data.firstName} !</div>
            <Link href="/calendrier/moi" className={sheet.big} style={{ minHeight: 52, fontSize: 15, padding: "0 14px" }}>
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                <rect x="4" y="5" width="16" height="15" rx="2" />
                <path d="M4 10h16M9 3v4M15 3v4" />
              </svg>
              Mon calendrier
            </Link>
          </div>
          <div className={styles.form}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Aujourd&apos;hui</div>
            {data.items.length === 0 && <span style={{ fontSize: 16 }}>Rien de prévu aujourd&apos;hui.</span>}
            {data.items.map((it, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, minHeight: 56, padding: "8px 12px", borderRadius: 12, background: "var(--bg)", fontSize: 16, fontWeight: 600 }}>
                <Dot item={it} big />
                <span style={{ flex: 1 }}>
                  {it.childTitle}
                  <span style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--ink-soft)" }}>{it.childSub}</span>
                </span>
              </div>
            ))}
          </div>
          <Link href="/assistant/devoirs/lecon" className={sheet.big} style={{ minHeight: 72 }}>
            <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <path d="M4 8h3l2-3h6l2 3h3v11H4z" />
              <circle cx="12" cy="13" r="3.5" />
            </svg>
            Créer mes exercices à partir d&apos;une leçon
          </Link>
          {folder?.role === "child" && folder.pages.length > 0 && (
            <>
              <div style={{ fontSize: 15, fontWeight: 700, paddingTop: 4 }}>Mes exercices</div>
              {folder.pages.map((p) => (
                <Link key={p.id} href={`/assistant/devoirs/exercices/${p.id}`} className={sheet.mine}>
                  <span>
                    {p.theme}
                    <small>
                      {plainDate(p.created).slice(0, 5)}
                      {p.createdBy ? ` · préparée par ${p.createdBy}` : ""}
                    </small>
                  </span>
                  <span style={{ color: "var(--primary)", fontSize: 20 }} aria-hidden>
                    ›
                  </span>
                </Link>
              ))}
            </>
          )}
        </>
      )}
    </AppShell>
  );
}
