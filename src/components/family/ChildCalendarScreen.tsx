"use client";

import Link from "next/link";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import { Loading, Notice, RetryNotice } from "@/components/ui";
import type { CalendarListItem } from "@/server/assistant/events";
import type { TaskView } from "@/server/assistant/tasks";
import { addDays, clock, dayOf, longDate, todayLocal } from "./format";

const card = { display: "flex", alignItems: "center", gap: 12, minHeight: 56, padding: "10px 14px", borderRadius: 12, background: "var(--bg-raised)", border: "1px solid var(--line)", fontSize: 16, fontWeight: 600, color: "var(--ink)", textDecoration: "none", textAlign: "left", width: "100%", font: "inherit" } as const;
const pill = (color: string, filled: boolean) => ({ width: 26, height: 26, borderRadius: "50%", flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, color: filled ? "#fff" : color, border: `2px solid ${color}`, background: filled ? color : "transparent" }) as const;
const GOLD = "var(--secondary-strong)";
const BLUE = "#3f6b8a";
const sub = { display: "block", fontSize: 13, fontWeight: 500, color: "var(--ink-soft)" } as const;

/**
 * « Mon calendrier » de l'enfant qui a un profil (D73 S-54) : sept jours à partir d'aujourd'hui, de grandes cartes, peu de texte. Ses tâches (pastille or) et les RDV où il est
 * nommé (pastille bleue) ; jamais un RDV de toute la famille : le serveur ne les lui renvoie pas (S-45). Il coche ses propres tâches (S-46), pas la tâche des devoirs, qui
 * ouvre son écran (S-40).
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
      {!loading &&
        days.map((day, i) => {
          const dayTasks = (tasks.data?.tasks ?? []).filter((t) => t.due === day);
          const dayEvents = (events.data?.events ?? []).filter((e) => dayOf(e.start) === day && e.status !== "set_aside").sort((a, b) => a.start.localeCompare(b.start));
          return (
            <section key={day} style={{ display: "flex", flexDirection: "column", gap: 8 }} aria-label={longDate(day)}>
              <div style={{ fontSize: 15, fontWeight: 700, paddingTop: 4 }}>{i === 0 ? `Aujourd'hui · ${longDate(day)}` : longDate(day)}</div>
              {dayTasks.length === 0 && dayEvents.length === 0 && <span style={{ fontSize: 15, color: "var(--ink-soft)" }}>Rien ce jour-là.</span>}
              {dayEvents.map((e) => (
                <Link key={e.id} href={`/calendrier/rdv/${e.id}`} style={card}>
                  <span style={pill(BLUE, true)} aria-hidden />
                  <span style={{ flex: 1 }}>
                    {e.title}
                    <span style={sub}>{e.allDay ? "Toute la journée" : clock(e.start)}</span>
                  </span>
                </Link>
              ))}
              {dayTasks.map((t) =>
                t.isHomeworkPrep ? (
                  <Link key={t.id} href={`/assistant/devoirs/tache?tache=${t.id}`} style={card}>
                    <span style={pill(GOLD, t.status === "done")} aria-hidden>
                      {t.status === "done" ? "✓" : ""}
                    </span>
                    <span style={{ flex: 1 }}>
                      {t.title}
                      <span style={sub}>Mes devoirs du jour ›</span>
                    </span>
                  </Link>
                ) : (
                  <button key={t.id} type="button" role="checkbox" aria-checked={t.status === "done"} disabled={!t.can.check || check.pending} onClick={() => void toggle(t)} style={{ ...card, cursor: t.can.check ? "pointer" : "default" }}>
                    <span style={pill(GOLD, t.status === "done")} aria-hidden>
                      {t.status === "done" ? "✓" : ""}
                    </span>
                    <span style={{ flex: 1, textDecoration: t.status === "done" ? "line-through" : undefined }}>
                      {t.title}
                      {t.dueTime && <span style={sub}>avant {clock(`0000-00-00T${t.dueTime}`)}</span>}
                    </span>
                  </button>
                ),
              )}
            </section>
          );
        })}
    </AppShell>
  );
}
