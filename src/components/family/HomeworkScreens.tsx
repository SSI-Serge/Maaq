"use client";

import Link from "next/link";
import { useApiQuery } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import { Loading, Notice, RetryNotice } from "@/components/ui";
import type { HomeworkSetting } from "@/server/assistant/homework/settings";
import type { WeekSummary } from "@/server/assistant/homework/weeks";
import { weekHref, weekTitle } from "./homework-domains";
import styles from "./family.module.css";

const WEEKDAY_NAMES = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
/** « Léo », « Léo et Mia », « Léo, Mia et Zoé » */
const names = (list: string[]) => (list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} et ${list[list.length - 1]}`);
const kick = { fontFamily: "var(--font-mono, 'IBM Plex Mono', monospace)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--ink-soft)", padding: "8px 0 2px" } as const;
const pill = (current: boolean) =>
  ({ fontSize: 10, fontWeight: 700, borderRadius: 100, padding: "2px 8px", whiteSpace: "nowrap", background: current ? "var(--success-bg)" : "var(--secondary-soft)", color: current ? "var(--success)" : "var(--secondary-strong)" }) as const;

/** Les semaines préparées en deux groupes (S-52, maquette RDV-Devoirs-Historique) : « À venir et en cours », puis « Semaines passées », de la plus récente à la plus ancienne. */
export function HistoryList({ weeks, today }: { weeks: WeekSummary[]; today: string }) {
  const groups = [
    { title: "À venir et en cours", weeks: weeks.filter((w) => w.weekEnd >= today) },
    { title: "Semaines passées", weeks: weeks.filter((w) => w.weekEnd < today) },
  ].filter((g) => g.weeks.length > 0);
  return (
    <>
      {groups.map((g) => (
        <div key={g.title} className={styles.taskList}>
          <div style={kick}>{g.title}</div>
          {g.weeks.map((w) => {
            const past = w.weekEnd < today;
            const current = !past && w.weekStart <= today;
            const days = past ? "" : w.workDays.map((d) => WEEKDAY_NAMES[d - 1]).join(", ");
            return (
              <Link key={w.id} href={weekHref(w.id, null, true)} className={styles.linkRow}>
                <span>
                  {weekTitle(w.weekStart)}
                  <span className={styles.linkRowSub}>{[names(w.children), days].filter(Boolean).join(" · ")}</span>
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {!past && <span style={pill(current)}>{current ? "En cours" : "À venir"}</span>}
                  <span aria-hidden>›</span>
                </span>
              </Link>
            );
          })}
        </div>
      ))}
    </>
  );
}

/**
 * Écran « Devoirs » (S-52) : l'historique des semaines préparées, passées comprises. On ne prépare plus de semaine ici : « Préparer les devoirs » est sur l'écran de la tâche.
 * Il s'ouvre depuis Réglages › Aide Devoirs et depuis la tâche (« Semaines passées › ») ; le retour mène à l'écran d'où l'on vient. Réservé aux parents, aide activée.
 */
export function HomeworkListScreen({ from }: { from: "tache" | "reglages" }) {
  const list = useApiQuery<{ weeks: WeekSummary[]; today: string }>("/api/family/homework/weeks");
  const setting = useApiQuery<{ setting: HomeworkSetting }>("/api/family/homework");
  const data = list.data;
  const enabled = setting.data?.setting.enabled;
  const back = from === "tache" ? { href: "/assistant/devoirs/tache", label: "Préparer les devoirs" } : { href: "/assistant/reglages", label: "Réglages" };
  return (
    <AppShell title="Devoirs" eyebrow="Aide Devoirs" back={back}>
      {list.error && <RetryNotice message={list.error.kind === "server" ? "Les semaines de devoirs n'ont pas pu être chargées." : list.error.message} onRetry={list.reload} />}
      {list.loading && !data && <Loading slow={list.slow} />}
      {enabled === false && (
        <Notice tone="info">
          L&apos;aide Devoirs est désactivée. <Link href="/assistant/reglages">Réglages</Link>
        </Notice>
      )}
      {data && enabled !== false && (
        <>
          {data.weeks.length === 0 ? (
            <Notice tone="info">Aucune semaine préparée pour le moment.</Notice>
          ) : (
            <>
              <p className={styles.hint}>Les semaines préparées, de la plus récente à la plus ancienne. Pour préparer une semaine, passez par la tâche « Préparer les devoirs ».</p>
              <HistoryList weeks={data.weeks} today={data.today} />
              <p className={styles.hint}>Les semaines sont gardées 12 mois.</p>
            </>
          )}
        </>
      )}
    </AppShell>
  );
}

export { HomeworkWeekScreen } from "./HomeworkWeekScreen";
export { HomeworkPrintScreen } from "./HomeworkPrint";
