"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell, appStyles as s, Section } from "@/components/app/AppShell";
import { Button, Loading, Notice, RetryNotice } from "@/components/ui";
import type { HomeworkSetting } from "@/server/assistant/homework/settings";
import type { WeekChildView, WeekItemView, WeekSummary, WeekView } from "@/server/assistant/homework/weeks";
import { addDays, longDate, shortDate } from "./format";
import styles from "./family.module.css";

const BACK = { href: "/assistant/devoirs", label: "Devoirs" };
/** « lun. 2 nov. » : `shortDate` donne déjà le jour de la semaine. */
const dayLabel = (weekStart: string, iso: number) => shortDate(addDays(weekStart, iso - 1));
const rangeLabel = (start: string, end: string) => `${shortDate(start)} – ${shortDate(end)}`;

/** Écran « Devoirs » : les semaines préparées et les semaines à venir à préparer (US-119 RF9). Réservé aux parents, aide activée. */
export function HomeworkListScreen() {
  const list = useApiQuery<{ weeks: WeekSummary[]; today: string; mondays: { weekStart: string; prepared: boolean }[] }>("/api/family/homework/weeks");
  const setting = useApiQuery<{ setting: HomeworkSetting }>("/api/family/homework");
  const data = list.data;
  const enabled = setting.data?.setting.enabled;
  return (
    <AppShell title="Devoirs" back={{ href: "/assistant", label: "Assistant Famille" }}>
      {list.error && <RetryNotice message={list.error.kind === "server" ? "Les semaines de devoirs n'ont pas pu être chargées." : list.error.message} onRetry={list.reload} />}
      {list.loading && !data && <Loading slow={list.slow} />}
      {enabled === false && (
        <Notice tone="info">
          L&apos;aide Devoirs est désactivée. <Link href="/assistant/reglages">Réglages</Link>
        </Notice>
      )}
      {data && enabled !== false && (
        <>
          <Section title="Préparer une semaine">
            <p className={styles.hint}>L&apos;aide vous propose des exercices de maths et des activités pour chaque enfant ; vous choisissez tout.</p>
            <div className={styles.taskList}>
              {data.mondays.map((m) => (
                <Link key={m.weekStart} href={`/assistant/devoirs/preparer?semaine=${m.weekStart}`} className={styles.linkRow} aria-disabled={m.prepared} style={m.prepared ? { opacity: 0.55, pointerEvents: "none" } : undefined}>
                  <span>
                    Semaine du {shortDate(m.weekStart)}
                    <span className={styles.linkRowSub}>{m.prepared ? "Déjà préparée" : "Préparer les devoirs de la semaine"}</span>
                  </span>
                  <span aria-hidden>›</span>
                </Link>
              ))}
            </div>
          </Section>
          <Section title="Semaines préparées">
            {data.weeks.length === 0 && <p className={styles.hint}>Aucune semaine préparée pour le moment.</p>}
            <div className={styles.taskList}>
              {data.weeks.map((w) => (
                <Link key={w.id} href={`/assistant/devoirs/${w.id}`} className={styles.linkRow}>
                  <span>
                    Semaine du {shortDate(w.weekStart)}
                    <span className={styles.linkRowSub}>
                      {w.children.join(", ")} · {w.items} {w.items > 1 ? "éléments" : "élément"}
                    </span>
                  </span>
                  <span aria-hidden>›</span>
                </Link>
              ))}
            </div>
          </Section>
        </>
      )}
    </AppShell>
  );
}

/**
 * Écran « Semaine de devoirs » (US-119 RF4) : une page par enfant, une colonne par jour de travail. On coche ce qui est fait (sans valider : seules les photos valident, RF6),
 * on déplace un élément d'un jour à l'autre, on en retire, on en ajoute, on affiche les corrigés, on imprime. Aucun compteur ni barre de progression (AT-9).
 */
export function HomeworkWeekScreen({ id }: { id: string }) {
  const query = useApiQuery<{ week: WeekView }>(`/api/family/homework/weeks/${id}`);
  const week = query.data?.week;
  const gone = query.error?.body?.code === "not_found";
  const [child, setChild] = useState<string | null>(null);
  const [answers, setAnswers] = useState(false);
  const current = week?.children.find((c) => c.memberId === child) ?? week?.children[0];

  return (
    <AppShell title="Semaine de devoirs" back={BACK}>
      {query.loading && !week && <Loading slow={query.slow} />}
      {gone && <Notice tone="info">Cette page n&apos;existe plus ou ne vous est pas accessible.</Notice>}
      {query.error && !gone && <RetryNotice message={query.error.kind === "server" ? "La semaine n'a pas pu être chargée." : query.error.message} onRetry={query.reload} />}
      {week && (
        <>
          <p className={styles.hint}>
            Semaine du {longDate(week.weekStart)} au {longDate(week.weekEnd)}
          </p>
          {week.children.length > 1 && (
            <div className={s.segments} role="tablist" aria-label="Enfant">
              {week.children.map((c) => (
                <button key={c.memberId} role="tab" aria-selected={c.memberId === current?.memberId} className={`${s.segment} ${c.memberId === current?.memberId ? s.segmentOn : ""}`} onClick={() => setChild(c.memberId)}>
                  {c.firstName}
                </button>
              ))}
            </div>
          )}
          <div className={styles.actionsRow}>
            <button type="button" className={styles.chipToggle} aria-pressed={answers} onClick={() => setAnswers((v) => !v)}>
              Afficher les corrigés
            </button>
            <Link href={`/assistant/devoirs/${week.id}/imprimer`} className={styles.link}>
              Imprimer
            </Link>
          </div>
          {current && <ChildWeek week={week} child={current} answers={answers} onChanged={query.reload} />}
          {week.children.length === 0 && <p className={styles.hint}>Cette semaine n&apos;a plus aucun élément.</p>}
        </>
      )}
    </AppShell>
  );
}

function ChildWeek({ week, child, answers, onChanged }: { week: WeekView; child: WeekChildView; answers: boolean; onChanged: () => void }) {
  const mutation = useApiMutation();
  const [adding, setAdding] = useState(false);

  async function patch(item: WeekItemView, body: Record<string, unknown>) {
    const done = await mutation.run(`/api/family/homework/items/${item.id}`, { method: "PATCH", body });
    if (done !== undefined) onChanged();
  }
  async function remove(item: WeekItemView) {
    const done = await mutation.run(`/api/family/homework/items/${item.id}`, { method: "DELETE" });
    if (done !== undefined) onChanged();
  }

  return (
    <>
      <p className={styles.hint}>
        {child.firstName} · niveau {child.levelLabel}
      </p>
      {child.suggestOlderAge && <Notice tone="info">{child.firstName} a validé tous les exercices du niveau. Vous pouvez augmenter son âge des devoirs d&apos;un an dans les réglages.</Notice>}
      {week.workDays.map((day) => {
        const items = child.items.filter((i) => i.day === day);
        return (
          <Section key={day} title={dayLabel(week.weekStart, day)}>
            {items.length === 0 && <p className={styles.hint}>Repos</p>}
            <div className={styles.taskList}>
              {items.map((item) => (
                <ItemRow key={item.id} item={item} workDays={week.workDays} weekStart={week.weekStart} answers={answers} busy={mutation.pending} onCheck={(checked) => void patch(item, { checked })} onMove={(to) => void patch(item, { day: to })} onRemove={() => void remove(item)} />
              ))}
            </div>
          </Section>
        );
      })}
      {mutation.error && <Notice tone="error">{mutation.error.kind === "server" ? "La modification n'a pas pu être enregistrée." : mutation.error.message}</Notice>}
      {!adding ? (
        <Button variant="secondary" onClick={() => setAdding(true)}>
          Ajouter une activité
        </Button>
      ) : (
        <AddCustom weekId={week.id} memberId={child.memberId} workDays={week.workDays} weekStart={week.weekStart} onDone={() => { setAdding(false); onChanged(); }} onCancel={() => setAdding(false)} />
      )}
    </>
  );
}

function ItemRow({ item, workDays, weekStart, answers, busy, onCheck, onMove, onRemove }: { item: WeekItemView; workDays: number[]; weekStart: string; answers: boolean; busy: boolean; onCheck: (checked: boolean) => void; onMove: (day: number) => void; onRemove: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={styles.taskRow}>
      <input type="checkbox" className={styles.taskCheck} checked={item.checked} disabled={busy} onChange={(e) => onCheck(e.target.checked)} aria-label={`${item.checked ? "Décocher" : "Cocher"} : ${item.title}`} />
      <div className={styles.taskBody}>
        <button type="button" className={styles.taskTitle} onClick={() => setOpen((v) => !v)} aria-expanded={open} style={{ textAlign: "left", background: "none", border: 0, padding: 0, font: "inherit", cursor: "pointer" }}>
          {item.title}
        </button>
        <div className={styles.taskMeta}>
          <span>{item.source}</span>
        </div>
        {open && (
          <div className={styles.hint}>
            {item.statement && <p>{item.statement}</p>}
            {item.materials && <p>Matériel : {item.materials}</p>}
            {item.steps.length > 0 && (
              <ol>
                {item.steps.map((step, i) => (
                  <li key={i}>{step}</li>
                ))}
              </ol>
            )}
            {item.card && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={item.card} alt={`Carte : ${item.title}`} style={{ maxWidth: "100%", borderRadius: 8 }} />
            )}
            <div className={styles.actionsRow}>
              <label className={styles.label} htmlFor={`move-${item.id}`}>
                Déplacer vers
              </label>
              <select id={`move-${item.id}`} className={styles.select} value={item.day} disabled={busy} onChange={(e) => onMove(Number(e.target.value))}>
                {workDays.map((d) => (
                  <option key={d} value={d}>
                    {dayLabel(weekStart, d)}
                  </option>
                ))}
              </select>
              <Button variant="ghost" onClick={onRemove} disabled={busy}>
                Retirer
              </Button>
            </div>
          </div>
        )}
        {answers && item.answer && <p className={styles.hint}>Corrigé : {item.answer}</p>}
      </div>
    </div>
  );
}

function AddCustom({ weekId, memberId, workDays, weekStart, onDone, onCancel }: { weekId: string; memberId: string; workDays: number[]; weekStart: string; onDone: () => void; onCancel: () => void }) {
  const mutation = useApiMutation();
  const [title, setTitle] = useState("");
  const [days, setDays] = useState<number[]>([]);
  const invalid = !title.trim() || title.length > 100 || days.length === 0;
  async function submit() {
    if (invalid) return;
    const done = await mutation.run(`/api/family/homework/weeks/${weekId}/items`, { method: "POST", body: { memberId, item: { kind: "custom", title: title.trim(), days } } });
    if (done !== undefined) onDone();
  }
  return (
    <div className={styles.form}>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="custom-title">
          Activité du parent
        </label>
        <input id="custom-title" className={styles.input} value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} placeholder="Ex. Lecture 15 min" />
      </div>
      <div className={styles.label}>Jours</div>
      <div className={styles.actionsRow}>
        {workDays.map((d) => (
          <button key={d} type="button" className={styles.chipToggle} aria-pressed={days.includes(d)} onClick={() => setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d]))}>
            {dayLabel(weekStart, d)}
          </button>
        ))}
      </div>
      {mutation.error && <Notice tone="error">{mutation.error.kind === "server" ? "L'activité n'a pas pu être ajoutée." : mutation.error.message}</Notice>}
      <div className={styles.actionsRow}>
        <Button variant="ghost" onClick={onCancel} disabled={mutation.pending}>
          Annuler
        </Button>
        <Button onClick={() => void submit()} loading={mutation.pending} disabled={invalid}>
          Ajouter
        </Button>
      </div>
    </div>
  );
}

/**
 * Version imprimable (US-119 RF4, CA 4.2) : une page A4 par enfant avec ses jours, puis les cartes illustrées des activités, à découper. La boîte d'impression
 * s'ouvre à l'arrivée sur la page.
 */
export function HomeworkPrintScreen({ id }: { id: string }) {
  const query = useApiQuery<{ week: WeekView }>(`/api/family/homework/weeks/${id}`);
  const week = query.data?.week;
  useEffect(() => {
    if (week) {
      const timer = setTimeout(() => window.print(), 400);
      return () => clearTimeout(timer);
    }
  }, [week]);
  if (query.loading && !week) return <Loading slow={query.slow} />;
  if (!week) return <Notice tone="info">Cette page n&apos;existe plus ou ne vous est pas accessible.</Notice>;
  return (
    <div className="print-week">
      <style>{`@page { size: A4; margin: 14mm; } @media print { .no-print { display: none !important; } .print-page { break-after: page; } } .print-week { font-family: system-ui, sans-serif; color: #111; padding: 16px; } .print-week h1 { font-size: 20px; } .print-week h2 { font-size: 15px; margin: 14px 0 4px; } .print-week li { margin: 2px 0; } .print-cards { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; } .print-cards img { width: 100%; border: 1px dashed #999; }`}</style>
      <div className="no-print">
        <Link href={`/assistant/devoirs/${week.id}`}>‹ Retour à la semaine</Link>{" "}
        <button type="button" onClick={() => window.print()}>
          Imprimer
        </button>
      </div>
      {week.children.map((child) => (
        <section key={child.memberId} className="print-page">
          <h1>
            {child.firstName} · semaine du {rangeLabel(week.weekStart, week.weekEnd)}
          </h1>
          {week.workDays.map((day) => {
            const items = child.items.filter((i) => i.day === day);
            return (
              <div key={day}>
                <h2>{dayLabel(week.weekStart, day)}</h2>
                {items.length === 0 ? <p>Repos</p> : (
                  <ul>
                    {items.map((i) => (
                      <li key={i.id}>
                        ☐ {i.title} <small>({i.source})</small>
                        {i.statement && i.kind === "exercise" && <div>{i.statement}</div>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </section>
      ))}
      {week.children.some((c) => c.items.some((i) => i.card)) && (
        <section>
          <h1>Cartes des activités</h1>
          <div className="print-cards">
            {week.children.flatMap((c) => c.items.filter((i) => i.card).map((i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={`${c.memberId}-${i.id}`} src={i.card!} alt={i.title} />
            )))}
          </div>
        </section>
      )}
    </div>
  );
}
