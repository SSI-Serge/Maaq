"use client";

import Link from "next/link";
import { useState } from "react";
import { useApiQuery } from "@/client/hooks";
import { AppShell, appStyles as s, Section } from "@/components/app/AppShell";
import { Loading, RetryNotice } from "@/components/ui";
import type { DigestDay, DigestView } from "@/server/assistant/digest";
import { clock, longDate, shortDate } from "./format";
import { Dots } from "./parts";
import { TaskRow } from "./TaskRow";
import styles from "./family.module.css";

type Tab = "summary" | "detail";

const taskWord = (n: number) => `${n} tâche${n > 1 ? "s" : ""}`;

/**
 * Point de la semaine (US-98 RF2) : « Synthèse » (fait la semaine passée, résumé, chiffres, bandeau des 7 jours, points d'attention) et « Détail jour par jour » (chaque jour,
 * puis « Encore ouvert de la semaine passée »). Sans couleur d'alerte ni reproche (AT-9). Chaque ligne ouvre son écran (RF5).
 */
export function DigestScreen() {
  const query = useApiQuery<{ digest: DigestView }>("/api/family/digest");
  const [tab, setTab] = useState<Tab>("summary");
  const [open, setOpen] = useState<string | null>(null);
  const d = query.data?.digest;

  return (
    <AppShell title="Point de la semaine" back={{ href: "/assistant", label: "Assistant Famille" }} subtitle={d ? `Du ${shortDate(d.weekStart)} au ${shortDate(d.weekEnd)}` : undefined}>
      {query.error && <RetryNotice message={query.error.kind === "server" ? "Le point de la semaine n'a pas pu être chargé." : query.error.message} onRetry={query.reload} />}
      {query.loading && !d && <Loading slow={query.slow} label="Chargement de la semaine…" />}

      {d && (
        <>
          <div className={s.segments} role="tablist" aria-label="Affichage">
            {([["summary", "Synthèse"], ["detail", "Détail jour par jour"]] as const).map(([value, label]) => (
              <button key={value} role="tab" aria-selected={tab === value} className={`${s.segment} ${tab === value ? s.segmentOn : ""}`} onClick={() => setTab(value)}>
                {label}
              </button>
            ))}
          </div>

          {d.calm && <div className={styles.nothing}>Semaine calme : rien de prévu pour l&apos;instant.</div>}

          {tab === "summary" && (
            <>
              {(d.lastWeek.doneTasks > 0 || d.lastWeek.doneEvents > 0) && (
                <Section title="Fait la semaine passée">
                  <p className={s.text}>
                    {d.lastWeek.doneTasks > 0 && `${taskWord(d.lastWeek.doneTasks)} faite${d.lastWeek.doneTasks > 1 ? "s" : ""}`}
                    {d.lastWeek.doneTasks > 0 && d.lastWeek.doneEvents > 0 && " · "}
                    {d.lastWeek.doneEvents > 0 && `${d.lastWeek.doneEvents} RDV assuré${d.lastWeek.doneEvents > 1 ? "s" : ""}`}
                  </p>
                </Section>
              )}

              {d.summary && (
                <Section title="Résumé">
                  <p className={s.text}>{d.summary.text}</p>
                </Section>
              )}

              <div className={styles.two} aria-label="Chiffres clés">
                <span className={styles.statBox}>
                  <strong>{d.counts.events}</strong> RDV
                </span>
                <span className={styles.statBox}>
                  <strong>{d.counts.tasks}</strong> tâche{d.counts.tasks > 1 ? "s" : ""}
                </span>
                <span className={styles.statBox}>
                  <strong>{d.counts.alerts}</strong> alerte{d.counts.alerts > 1 ? "s" : ""}
                </span>
                {d.parent && (
                  <span className={styles.statBox}>
                    <strong>{d.counts.toConfirm}</strong> à confirmer
                  </span>
                )}
              </div>

              <div className={styles.weekStrip} role="list" aria-label="Les sept jours">
                {d.days.map((day) => (
                  <button key={day.date} type="button" role="listitem" className={styles.weekDay} aria-pressed={open === day.date} onClick={() => { setOpen(day.date); setTab("detail"); }}>
                    <span className={styles.hint}>{shortDate(day.date).slice(0, 3)}</span>
                    <strong>{Number(day.date.slice(8, 10))}</strong>
                    <Dots members={day.events.flatMap((e) => e.members).slice(0, 3)} />
                    <span className={styles.hint}>{day.events.length + day.tasks.length || "·"}</span>
                    {day.conflict && <span className={styles.conflictMark} aria-label="Jour en conflit">!</span>}
                  </button>
                ))}
              </div>

              {d.attention.length > 0 && (
                <Section title="Points d'attention">
                  <div className={styles.taskList}>
                    {d.attention.map((a, i) => (
                      <Link key={`${a.kind}:${a.link.id}:${i}`} href={a.link.type === "event" ? `/calendrier/rdv/${a.link.id}` : `/assistant/taches/${a.link.id}`} className={styles.listItem}>
                        <span className={styles.listBody}>{a.text}</span>
                        <span className={styles.chevron} aria-hidden>
                          ›
                        </span>
                      </Link>
                    ))}
                  </div>
                </Section>
              )}
            </>
          )}

          {tab === "detail" && (
            <>
              {d.days.map((day) => (
                <DayBlock key={day.date} day={day} highlighted={open === day.date} onChanged={query.reload} />
              ))}
              {d.lastWeek.open.length > 0 && (
                <Section title="Encore ouvert de la semaine passée">
                  <p className={styles.hint}>À faire quand vous pouvez, à confier, ou à abandonner si elle n&apos;est plus utile.</p>
                  <div className={styles.taskList}>
                    {d.lastWeek.open.map((t) => (
                      <TaskRow key={t.id} task={t} assignable={[]} onChanged={query.reload} />
                    ))}
                  </div>
                </Section>
              )}
            </>
          )}
        </>
      )}
    </AppShell>
  );
}

function DayBlock({ day, highlighted, onChanged }: { day: DigestDay; highlighted: boolean; onChanged: () => void }) {
  const empty = day.events.length === 0 && day.tasks.length === 0;
  return (
    <section className={`${styles.day} ${highlighted ? styles.dayToday : ""}`} aria-label={longDate(day.date)}>
      <div className={styles.dayHead}>
        <Link href={`/calendrier/jour/${day.date}`}>{longDate(day.date)}</Link>
        {day.conflict && <span className={styles.tag}>Conflit</span>}
      </div>
      {empty && <div className={styles.nothing}>Rien de prévu</div>}
      {day.events.map((e) => (
        <Link key={e.id} href={`/calendrier/rdv/${e.id}`} className={`${styles.eventLine} ${e.status === "provisional" ? styles.eventProvisional : ""}`}>
          <span className={styles.eventTime}>{e.allDay ? "Journée" : clock(e.start)}</span>
          <Dots members={e.members} />
          <span className={styles.eventTitle}>{e.title}</span>
          {e.status === "provisional" && <span className={styles.tag}>À confirmer</span>}
        </Link>
      ))}
      {day.tasks.length > 0 && (
        <div className={styles.taskList}>
          {day.tasks.map((t) => (
            <TaskRow key={t.id} task={t} assignable={[]} showDate={false} onChanged={onChanged} />
          ))}
        </div>
      )}
    </section>
  );
}
