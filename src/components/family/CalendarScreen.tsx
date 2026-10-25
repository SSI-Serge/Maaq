"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useApiQuery } from "@/client/hooks";
import { AppShell, appStyles as s } from "@/components/app/AppShell";
import { Loading, RetryNotice } from "@/components/ui";
import type { CalendarListItem, MemberChip } from "@/server/assistant/events";
import {
  addDays, addMonths, dayOf, monthGrid, monthLabel, monthStart, shortDate, todayLocal, weekStart, weekdayShort,
} from "./format";
import { Dots, EventLine, FALLBACK_COLOR } from "./parts";
import styles from "./family.module.css";

type View = "week" | "month";
const MAX_PAST_MONTHS = 12; // US-78 RF12 : 12 derniers mois
const MAX_FUTURE_MONTHS = 24; // et 24 prochains mois

/**
 * Calendrier familial partagé (US-78) : semaine par défaut, vue mois, légende des membres avec filtre, « Aujourd'hui ».
 * Seule la période affichée est chargée (RT4). Le serveur ne renvoie que les rendez-vous que ce profil a le droit de voir (RT1).
 */
export function CalendarScreen() {
  const today = todayLocal();
  const [view, setView] = useState<View>("week");
  const [anchor, setAnchor] = useState(today);
  const [filter, setFilter] = useState<string | null>(null);

  const range = useMemo(() => {
    if (view === "week") {
      const from = weekStart(anchor);
      return { from, to: addDays(from, 6) };
    }
    const grid = monthGrid(anchor);
    return { from: grid[0], to: grid[grid.length - 1] };
  }, [view, anchor]);

  const members = useApiQuery<{ members: (MemberChip & { isYou: boolean })[] }>("/api/family/members");
  const events = useApiQuery<{ events: CalendarListItem[] }>(`/api/family/events?from=${range.from}&to=${range.to}`);
  // Le message « aucun rendez-vous » n'a de sens que si le foyer n'en a aucun à venir : la période affichée peut simplement être vide.
  const upcoming = useApiQuery<{ events: CalendarListItem[] }>("/api/assistant/upcoming");

  const minDay = addMonths(monthStart(today), -MAX_PAST_MONTHS);
  const maxDay = addDays(addMonths(monthStart(today), MAX_FUTURE_MONTHS + 1), -1);
  const prev = view === "week" ? addDays(range.from, -7) : addMonths(monthStart(anchor), -1);
  const next = view === "week" ? addDays(range.from, 7) : addMonths(monthStart(anchor), 1);
  const canPrev = addDays(range.from, -1) >= minDay;
  const canNext = addDays(range.to, 1) <= maxDay;

  const visible = (events.data?.events ?? []).filter((e) => !filter || e.allFamily || e.members.some((m) => m.id === filter));
  const byDay = new Map<string, CalendarListItem[]>();
  for (const e of visible) byDay.set(dayOf(e.start), [...(byDay.get(dayOf(e.start)) ?? []), e]);

  const monthTitle = monthLabel(anchor);
  const title = view === "week" ? `${shortDate(range.from)} – ${shortDate(range.to)}` : monthTitle.charAt(0).toUpperCase() + monthTitle.slice(1);
  const legend = members.data?.members ?? [];

  return (
    <AppShell title="Calendrier familial" back={{ href: "/assistant", label: "Assistant Famille" }}>
      <div className={s.segments} role="tablist" aria-label="Affichage">
        {(["week", "month"] as const).map((v) => (
          <button key={v} role="tab" aria-selected={view === v} className={`${s.segment} ${view === v ? s.segmentOn : ""}`} onClick={() => setView(v)}>
            {v === "week" ? "Semaine" : "Mois"}
          </button>
        ))}
      </div>

      <div className={styles.legend} aria-label="Légende des membres">
        {legend.map((m) => (
          <button key={m.id} type="button" className={styles.legendItem} aria-pressed={filter === m.id} onClick={() => setFilter(filter === m.id ? null : m.id)}>
            <span className={styles.dot} style={{ background: m.color || FALLBACK_COLOR }} aria-hidden />
            {m.firstName}
          </button>
        ))}
        <span className={`${styles.legendItem} ${styles.legendStatic}`}>
          <span className={`${styles.dot} ${styles.dotProvisional}`} aria-hidden />
          Provisoire
        </span>
      </div>

      <div className={styles.periodBar}>
        <button type="button" className={styles.arrow} onClick={() => setAnchor(prev)} disabled={!canPrev} aria-label="Période précédente">
          ‹
        </button>
        <div className={styles.periodTitle} aria-live="polite">
          {title}
        </div>
        <button type="button" className={styles.arrow} onClick={() => setAnchor(next)} disabled={!canNext} aria-label="Période suivante">
          ›
        </button>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" className={styles.todayButton} onClick={() => setAnchor(today)}>
          Aujourd&apos;hui
        </button>
        <button type="button" className={styles.todayButton} onClick={events.reload}>
          Actualiser
        </button>
      </div>

      {events.error && <RetryNotice message={events.error.message} onRetry={events.reload} />}
      {events.loading && <Loading slow={events.slow} />}

      {events.data && !events.loading && events.data.events.length === 0 && upcoming.data?.events.length === 0 && !events.error && (
        <div className={s.empty}>
          <p className={s.text}>Aucun rendez-vous pour le moment. Dictez, photographiez ou écrivez votre prochaine demande à l&apos;Assistant Famille.</p>
          <Link href="/assistant/demande" className={styles.cta}>
            Nouvelle demande
          </Link>
        </div>
      )}

      {events.data && !events.loading && view === "week" && Array.from({ length: 7 }, (_, i) => addDays(range.from, i)).map((day) => {
        const list = byDay.get(day) ?? [];
        return (
          <section key={day} className={`${styles.day} ${day === today ? styles.dayToday : ""}`} aria-label={shortDate(day)}>
            <div className={styles.dayHead}>
              <Link href={`/calendrier/jour/${day}`}>{shortDate(day)}</Link>
              {day === today && <span className={styles.tag}>Aujourd&apos;hui</span>}
            </div>
            {list.length === 0 && <div className={styles.nothing}>Rien de prévu</div>}
            {list.slice(0, 3).map((e) => (
              <EventLine key={e.id} event={e} />
            ))}
            {list.length > 3 && (
              <Link href={`/calendrier/jour/${day}`} className={styles.more}>
                + {list.length - 3} autre{list.length - 3 > 1 ? "s" : ""}
              </Link>
            )}
          </section>
        );
      })}

      {events.data && !events.loading && view === "month" && (
        <div className={styles.monthGrid} role="grid" aria-label={monthLabel(anchor)}>
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className={styles.monthHead} role="columnheader">
              {weekdayShort(i)}
            </div>
          ))}
          {monthGrid(anchor).map((day) => {
            const count = byDay.get(day)?.length ?? 0;
            const outside = day.slice(0, 7) !== anchor.slice(0, 7);
            return (
              <Link
                key={day}
                href={`/calendrier/jour/${day}`}
                role="gridcell"
                aria-label={`${shortDate(day)}, ${count} rendez-vous`}
                className={`${styles.cell} ${outside ? styles.cellOut : ""} ${day === today ? styles.cellToday : ""}`}
              >
                {Number(day.slice(8, 10))}
                {count > 0 && <span className={styles.count}>{count}</span>}
                {count > 0 && <Dots members={byDay.get(day)![0].members.slice(0, 3)} />}
              </Link>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}
