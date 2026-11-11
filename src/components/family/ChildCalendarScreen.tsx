"use client";

import Link from "next/link";
import type { ReactNode } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import { Loading, Notice, RetryNotice } from "@/components/ui";
import type { CalendarListItem } from "@/server/assistant/events";
import type { TaskView } from "@/server/assistant/tasks";
import { addDays, clock, dayOf, longDate, timeOf, todayLocal } from "./format";

const GOLD = "var(--secondary)";
const BLUE = "#3F6B8A";
const card = (border: string) =>
  ({ display: "flex", alignItems: "center", gap: 14, minHeight: 72, padding: "12px 14px", borderRadius: 14, background: "var(--bg-raised)", border: `2px solid ${border}`, color: "var(--ink)", textDecoration: "none", textAlign: "left", width: "100%", font: "inherit" }) as const;
const icon = (color: string, filled: boolean) =>
  ({ width: 40, height: 40, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 700, color: "#fff", border: `2px solid ${color}`, background: filled ? color : "transparent" }) as const;
const titleStyle = { display: "block", fontSize: 17, fontWeight: 700 } as const;
const sub = { display: "block", fontSize: 14, fontWeight: 400, color: "var(--ink-soft)" } as const;
const time = { fontSize: 16, fontWeight: 700 } as const;

/** « mardi 10 » : le jour sans le mois, comme sur la maquette. */
const dayLabel = (day: string) => longDate(day).split(" ").slice(0, 2).join(" ");
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

type Entry = { key: string; at: string; node: ReactNode };

/**
 * Les sept jours de « Mon calendrier » (maquette RDV-Calendrier-Enfant). Dans un jour, les tâches et les RDV sont mêlés et triés par heure ; ce qui n'a pas d'heure vient
 * en dernier. Une tâche à faire porte un anneau or vide ; une fois faite, une pastille or avec « ✓ » et le titre barré. Un RDV (pastille et contour bleus) n'ouvre rien.
 */
export function ChildCalendarDays({ days, tasks, events, busy, onToggle }: { days: string[]; tasks: TaskView[]; events: CalendarListItem[]; busy: boolean; onToggle: (task: TaskView) => void }) {
  return (
    <>
      {days.map((day, i) => {
        const entries: Entry[] = [
          ...events
            .filter((e) => dayOf(e.start) === day && e.status !== "set_aside")
            .map((e) => ({
              key: `r${e.id}`,
              at: e.allDay ? "00:00" : timeOf(e.start),
              node: (
                <div style={card(BLUE)}>
                  <span style={icon(BLUE, true)} aria-hidden>
                    ●
                  </span>
                  <span style={{ flex: 1 }}>
                    <span style={titleStyle}>{e.title}</span>
                    <span style={sub}>Rendez-vous</span>
                  </span>
                  <span style={time}>{e.allDay ? "toute la journée" : clock(e.start)}</span>
                </div>
              ),
            })),
          ...tasks
            .filter((t) => t.due === day)
            .map((t) => {
              const done = t.status === "done";
              const body = (
                <>
                  <span style={icon(GOLD, done)} aria-hidden>
                    {done ? "✓" : ""}
                  </span>
                  <span style={{ flex: 1 }}>
                    <span style={{ ...titleStyle, textDecoration: done ? "line-through" : undefined }}>{t.title}</span>
                    <span style={sub}>{t.isHomeworkPrep ? "Mes devoirs du jour ›" : "Tâche"}</span>
                  </span>
                  <span style={time}>{t.dueTime ? clock(`0000-00-00T${t.dueTime}`) : "dans la journée"}</span>
                </>
              );
              return {
                key: `t${t.id}`,
                at: t.dueTime ? t.dueTime.slice(0, 5) : "99:99",
                node: t.isHomeworkPrep ? (
                  <Link href={`/assistant/devoirs/tache?tache=${t.id}`} style={card("var(--line)")}>
                    {body}
                  </Link>
                ) : (
                  <button type="button" role="checkbox" aria-checked={done} disabled={!t.can.check || busy} onClick={() => onToggle(t)} style={{ ...card("var(--line)"), cursor: t.can.check ? "pointer" : "default" }}>
                    {body}
                  </button>
                ),
              };
            }),
        ].sort((a, b) => a.at.localeCompare(b.at));
        return (
          <section key={day} style={{ display: "flex", flexDirection: "column", gap: 8 }} aria-label={longDate(day)}>
            <div style={{ fontSize: 17, fontWeight: 700, color: i === 0 ? "var(--primary)" : "var(--ink)" }}>{i === 0 ? `Aujourd'hui · ${dayLabel(day)}` : capital(dayLabel(day))}</div>
            {entries.length === 0 && <span style={{ fontSize: 15, color: "var(--ink-soft)", padding: "4px 2px" }}>Rien ce jour-là.</span>}
            {entries.map((e) => (
              <div key={e.key}>{e.node}</div>
            ))}
          </section>
        );
      })}
    </>
  );
}

/**
 * « Mon calendrier » de l'enfant qui a un profil (D73 S-54) : sept jours à partir d'aujourd'hui, de grandes cartes, peu de texte. Ses tâches (or) et les RDV où il est
 * nommé (bleu) ; jamais un RDV de toute la famille : le serveur ne les lui renvoie pas (S-45). Il coche ses propres tâches (S-46), pas la tâche des devoirs, qui
 * ouvre son écran (S-40). Le retour mène à l'accueil.
 */
export function ChildCalendarScreen() {
  const today = todayLocal();
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i));
  const range = `from=${days[0]}&to=${days[6]}`;
  const tasks = useApiQuery<{ tasks: TaskView[] }>(`/api/family/tasks?${range}`);
  const events = useApiQuery<{ events: CalendarListItem[] }>(`/api/family/events?${range}`);
  const check = useApiMutation();

  async function toggle(task: TaskView) {
    if (await check.run(`/api/family/tasks/${task.id}/check`, { method: "POST", body: { done: task.status !== "done", version: task.version } })) tasks.reload();
  }

  const loading = (tasks.loading && !tasks.data) || (events.loading && !events.data);
  return (
    <AppShell title="Mon calendrier" subtitle="Tes tâches et tes rendez-vous." back={{ href: "/accueil", label: "Accueil" }}>
      {loading && <Loading slow={tasks.slow || events.slow} />}
      {tasks.error && <RetryNotice message={tasks.error.kind === "server" ? "Tes tâches n'ont pas pu être chargées." : tasks.error.message} onRetry={tasks.reload} />}
      {events.error && <RetryNotice message={events.error.kind === "server" ? "Tes rendez-vous n'ont pas pu être chargés." : events.error.message} onRetry={events.reload} />}
      {check.error && <Notice tone="error">{check.error.kind === "server" ? "La tâche n'a pas pu être cochée." : check.error.message}</Notice>}
      {!loading && <ChildCalendarDays days={days} tasks={tasks.data?.tasks ?? []} events={events.data?.events ?? []} busy={check.pending} onToggle={(t) => void toggle(t)} />}
    </AppShell>
  );
}
