"use client";

import Link from "next/link";
import { useState } from "react";
import { useApiQuery } from "@/client/hooks";
import { AppShell, appStyles as s } from "@/components/app/AppShell";
import { Loading, Notice, RetryNotice } from "@/components/ui";
import type { CalendarListItem } from "@/server/assistant/events";
import type { TaskView } from "@/server/assistant/tasks";
import { addDays, longDate, period, PERIODS, todayLocal } from "./format";
import { EventLine } from "./parts";
import { TaskRow } from "./TaskRow";
import styles from "./family.module.css";

/** Groupes de rendez-vous à horaires qui se chevauchent, dans l'ordre du jour. Un rendez-vous seul forme un groupe d'un. */
function overlapGroups(events: CalendarListItem[]): CalendarListItem[][] {
  const groups: CalendarListItem[][] = [];
  let end = "";
  for (const e of events) {
    const last = groups[groups.length - 1];
    if (last && e.start < end) {
      last.push(e);
      if (e.end > end) end = e.end;
    } else {
      groups.push([e]);
      end = e.end;
    }
  }
  return groups;
}

const validDay = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`));

/**
 * Vue Jour (US-78 RF9) : les rendez-vous du jour par période (matin, midi, après-midi, soir). Deux rendez-vous simultanés sans membre en
 * commun sont signalés ; deux rendez-vous en conflit déclenchent une alerte. Les tâches du jour s'y ajoutent, avec les filtres « Tout / RDV / Tâches » (US-110 RF9, AT-5) : une
 * tâche ne crée jamais de conflit avec un rendez-vous.
 */
export function DayScreen({ day }: { day: string }) {
  const today = todayLocal();
  const ok = validDay(day);
  const events = useApiQuery<{ events: CalendarListItem[] }>(ok ? `/api/family/events?from=${day}&to=${day}` : null);
  const tasks = useApiQuery<{ tasks: TaskView[] }>(ok ? `/api/family/tasks?from=${day}&to=${day}` : null);
  const [show, setShow] = useState<"all" | "events" | "tasks">("all");

  if (!ok) {
    return (
      <AppShell title="Jour" back={{ href: "/calendrier", label: "Calendrier" }}>
        <Notice tone="error">Cette date n&apos;existe pas.</Notice>
      </AppShell>
    );
  }

  const all = show === "tasks" ? [] : (events.data?.events ?? []);
  const dayTasks = show === "events" ? [] : (tasks.data?.tasks ?? []);
  const allDay = all.filter((e) => e.allDay);
  const timed = all.filter((e) => !e.allDay);

  return (
    <AppShell title={longDate(day)} back={{ href: "/calendrier", label: "Calendrier" }} subtitle={events.data ? `${events.data.events.length} rendez-vous${tasks.data ? ` · ${tasks.data.tasks.length} tâche${tasks.data.tasks.length > 1 ? "s" : ""}` : ""}` : undefined}>
      <div className={styles.periodBar}>
        <Link href={`/calendrier/jour/${addDays(day, -1)}`} className={styles.arrow} style={{ display: "grid", placeItems: "center" }} aria-label="Jour précédent">
          ‹
        </Link>
        <div style={{ flex: 1, textAlign: "center" }}>
          {day !== today && (
            <Link href={`/calendrier/jour/${today}`} className={styles.link}>
              Aujourd&apos;hui
            </Link>
          )}
        </div>
        <Link href={`/calendrier/jour/${addDays(day, 1)}`} className={styles.arrow} style={{ display: "grid", placeItems: "center" }} aria-label="Jour suivant">
          ›
        </Link>
      </div>

      <div className={s.segments} role="tablist" aria-label="Afficher">
        {([["all", "Tout"], ["events", "RDV"], ["tasks", "Tâches"]] as const).map(([value, label]) => (
          <button key={value} role="tab" aria-selected={show === value} className={`${s.segment} ${show === value ? s.segmentOn : ""}`} onClick={() => setShow(value)}>
            {label}
          </button>
        ))}
      </div>

      {events.error && <RetryNotice message={events.error.message} onRetry={events.reload} />}
      {tasks.error && <RetryNotice message={tasks.error.message} onRetry={tasks.reload} />}
      {events.loading && !events.data && <Loading slow={events.slow} />}
      {events.data && tasks.data && all.length === 0 && dayTasks.length === 0 && <div className={styles.nothing}>{show === "tasks" ? "Aucune tâche ce jour-là." : "Rien de prévu ce jour-là."}</div>}

      {allDay.length > 0 && (
        <section className={styles.periodSection}>
          <div className={styles.periodName}>Toute la journée</div>
          {allDay.map((e) => (
            <EventLine key={e.id} event={e} showConflict />
          ))}
        </section>
      )}

      {PERIODS.map((name) => {
        const inPeriod = timed.filter((e) => period(e.start) === name);
        if (inPeriod.length === 0) return null;
        return (
          <section key={name} className={styles.periodSection}>
            <div className={styles.periodName}>{name}</div>
            {overlapGroups(inPeriod).map((group) => {
              const clash = group.some((e) => e.conflictsWith.length > 0);
              return (
                <div key={group[0].id} className={styles.periodSection}>
                  {group.length > 1 && !clash && (
                    <div className={`${styles.alert} ${styles.alertInfo}`}>
                      {group.length} RDV en même temps, chacun avec un parent différent
                    </div>
                  )}
                  {clash && (
                    <div className={`${styles.alert} ${styles.alertError}`} role="alert">
                      Conflit : ces rendez-vous se chevauchent pour au moins une même personne.
                    </div>
                  )}
                  {group.map((e) => (
                    <EventLine key={e.id} event={e} showConflict />
                  ))}
                </div>
              );
            })}
          </section>
        );
      })}

      {dayTasks.length > 0 && (
        <section className={styles.periodSection}>
          <div className={styles.periodName}>Tâches</div>
          <div className={styles.taskList}>
            {dayTasks.map((t) => (
              <TaskRow key={t.id} task={t} assignable={[]} showDate={false} onChanged={tasks.reload} />
            ))}
          </div>
        </section>
      )}
    </AppShell>
  );
}
