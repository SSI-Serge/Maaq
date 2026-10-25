"use client";

import Link from "next/link";
import { useApiQuery } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import { Loading, Notice, RetryNotice } from "@/components/ui";
import type { CalendarListItem } from "@/server/assistant/events";
import { addDays, longDate, period, PERIODS, todayLocal } from "./format";
import { EventLine } from "./parts";
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
 * commun sont signalés ; deux rendez-vous en conflit déclenchent une alerte. Pas de tâches au MVP (RF11).
 */
export function DayScreen({ day }: { day: string }) {
  const today = todayLocal();
  const ok = validDay(day);
  const events = useApiQuery<{ events: CalendarListItem[] }>(ok ? `/api/family/events?from=${day}&to=${day}` : null);

  if (!ok) {
    return (
      <AppShell title="Jour" back={{ href: "/calendrier", label: "Calendrier" }}>
        <Notice tone="error">Cette date n&apos;existe pas.</Notice>
      </AppShell>
    );
  }

  const all = events.data?.events ?? [];
  const allDay = all.filter((e) => e.allDay);
  const timed = all.filter((e) => !e.allDay);

  return (
    <AppShell title={longDate(day)} back={{ href: "/calendrier", label: "Calendrier" }} subtitle={events.data ? `${all.length} rendez-vous` : undefined}>
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

      {events.error && <RetryNotice message={events.error.message} onRetry={events.reload} />}
      {events.loading && !events.data && <Loading slow={events.slow} />}
      {events.data && all.length === 0 && <div className={styles.nothing}>Rien de prévu ce jour-là.</div>}

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
    </AppShell>
  );
}
