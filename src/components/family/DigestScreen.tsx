"use client";

import Link from "next/link";
import { useState } from "react";
import { useApiQuery } from "@/client/hooks";
import { AppShell, appStyles as s, Section } from "@/components/app/AppShell";
import { Loading, Notice, RetryNotice } from "@/components/ui";
import type { DigestDay, DigestView } from "@/server/assistant/digest";
import type { TaskView } from "@/server/assistant/tasks";
import { clock, longDate, shortDate } from "./format";
import { Dots } from "./parts";
import { QuestionCard } from "./QuestionCards";
import { ReviewSteps } from "./ReviewScreen";
import { TaskRow } from "./TaskRow";
import { useHandOver } from "./useHandOver";
import emo from "./emotions.module.css";
import styles from "./family.module.css";

type Tab = "summary" | "detail";

const LEVEL_LABEL = { calm: "Calme", busy: "Chargé", very_busy: "Très" } as const;
const LEVEL_TEXT = { calm: "calme", busy: "chargé", very_busy: "très chargé" } as const;
const weekdayName = (day: string) => longDate(day).split(" ")[0];

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
  const hand = useHandOver(query.reload);
  const couple = d?.couple ?? null;

  return (
    <AppShell title="Point de la semaine" back={{ href: "/assistant", label: "Assistant Famille" }} subtitle={d ? `Du ${shortDate(d.weekStart)} au ${shortDate(d.weekEnd)}` : undefined}>
      {couple && <ReviewSteps current="point" />}
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
              {d.lastWeek && (d.lastWeek.doneTasks > 0 || d.lastWeek.doneEvents > 0) && (
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

              {couple && <LoadBlock d={d} onOpen={(day) => { setOpen(day); setTab("detail"); }} />}

              {d.parent && d.questions.length > 0 && (
                <Section title="Questions de la semaine">
                  {d.questions.map((q) => (
                    <QuestionCard key={q.id} question={q} onAnswered={query.reload} />
                  ))}
                </Section>
              )}

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
                <DayBlock key={day.date} day={day} highlighted={open === day.date} onChanged={query.reload} couple={couple} onHandOver={(t) => void hand.handOver(t)} busy={hand.pending} />
              ))}
              {hand.error && <Notice tone="error">{hand.error.kind === "rejected" ? hand.error.message : "La tâche n'a pas pu être confiée : réessayez."}</Notice>}
              {d.lastWeek && d.lastWeek.open.length > 0 && (
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
      {hand.toast}
    </AppShell>
  );
}

/** « Charge de chacun » (US-145 RF2) : un indicateur qualitatif par jour et par parent (Calme, Chargé, Très chargé), jamais un nombre ; les jours très chargés ouvrent le détail du jour. */
function LoadBlock({ d, onOpen }: { d: DigestView; onOpen: (day: string) => void }) {
  const people = d.days[0]?.load ?? [];
  if (people.length === 0) return null;
  const veryBusy = d.days.flatMap((day) => day.load.filter((l) => l.level === "very_busy").map((l) => ({ day: day.date, who: l.firstName })));
  return (
    <div className={emo.load}>
      <div className={emo.kick}>Charge de chacun</div>
      {people.map((p, index) => (
        <div key={p.firstName} className={emo.loadRow}>
          <span className={emo.loadName}>{p.firstName}</span>
          {d.days.map((day) => {
            const level = day.load[index].level;
            return (
              <span key={day.date} className={`${emo.chip} ${level === "busy" ? emo.chipBusy : level === "very_busy" ? emo.chipVery : ""}`} aria-label={`${weekdayName(day.date)} : ${LEVEL_TEXT[level]} pour ${p.firstName}`}>
                {LEVEL_LABEL[level]}
              </span>
            );
          })}
        </div>
      ))}
      {veryBusy.map((v) => (
        <button key={`${v.day}:${v.who}`} type="button" className={emo.loadLink} onClick={() => onOpen(v.day)}>
          <b>{weekdayName(v.day)}</b> : très chargé pour {v.who} ›
        </button>
      ))}
    </div>
  );
}

function DayBlock({ day, highlighted, onChanged, couple, onHandOver, busy }: { day: DigestDay; highlighted: boolean; onChanged: () => void; couple: DigestView["couple"]; onHandOver: (task: TaskView) => void; busy: boolean }) {
  const mine = day.load.find((l) => l.mine);
  const veryBusyNames = day.load.filter((l) => l.level === "very_busy").map((l) => l.firstName);
  const empty = day.events.length === 0 && day.tasks.length === 0;
  return (
    <section className={`${styles.day} ${highlighted ? styles.dayToday : ""}`} aria-label={longDate(day.date)}>
      <div className={styles.dayHead}>
        <Link href={`/calendrier/jour/${day.date}`}>{longDate(day.date)}</Link>
        {day.conflict && <span className={styles.tag}>Conflit</span>}
      </div>
      {veryBusyNames.length > 0 && <div className={emo.dayLoad}>{veryBusyNames.map((n) => `Très chargé pour ${n}`).join(" · ")}</div>}
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
            <div key={t.id}>
              <TaskRow task={t} assignable={[]} showDate={false} onChanged={onChanged} />
              {couple && t.assignee?.id === couple.myMemberId && t.can.manage && couple.partnerMemberId && (
                <button type="button" className={`${emo.handOver} ${mine?.level === "very_busy" ? emo.handOverStrong : ""}`} disabled={busy} onClick={() => onHandOver(t)}>
                  Confier à {couple.partner}
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
