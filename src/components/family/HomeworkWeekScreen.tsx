"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import { Loading, Notice, RetryNotice } from "@/components/ui";
import type { WeekChildView, WeekItemView, WeekView } from "@/server/assistant/homework/weeks";
import { todayLocal } from "./format";
import { childOfWeek, DAY_LONG, DAY_SHORT, DOMAIN_LABEL, dayDate, weekHref, weekRange, weekTitle } from "./homework-domains";
import { PhotoPanel } from "./HomeworkPhotoPanel";
import styles from "./family.module.css";
import week from "./homework-week.module.css";

const BACK = { href: "/assistant/devoirs?retour=tache", label: "Semaines de devoirs" };
const DAYS = [1, 2, 3, 4, 5, 6, 7];

/**
 * Écran « Semaine de devoirs » (US-119 RF4, maquette RDV-Devoirs-Semaine) : en-tête de la semaine, une section par enfant, une grille de sept cartes de jour. On coche ce qui est fait
 * (sans valider : seules les photos valident, RF6), on déplace un élément d'un jour à l'autre, on en retire, on en ajoute dans un jour, on affiche les corrigés, on imprime.
 * Aucun compteur ni barre de progression (AT-9).
 */
export function HomeworkWeekScreen({ id, childId = null }: { id: string; childId?: string | null }) {
  const query = useApiQuery<{ week: WeekView }>(`/api/family/homework/weeks/${id}`);
  const data = query.data?.week;
  const gone = query.error?.body?.code === "not_found";
  // La semaine s'ouvre sur la page de l'enfant visé par le lien (« Voir la semaine de [prénom] », retour de « Refaire ») ; l'onglet choisi ensuite reste dans l'adresse.
  const router = useRouter();
  const [child, setChildState] = useState<string | null>(childId);
  const setChild = (memberId: string) => {
    setChildState(memberId);
    router.replace(weekHref(id, memberId), { scroll: false });
  };
  const [answers, setAnswers] = useState(false);
  const current = data ? childOfWeek(data.children, child) : undefined;
  const workDays = data ? data.workDays.map((d) => DAY_SHORT[d - 1]).join(", ") : "";

  return (
    <AppShell
      wide
      eyebrow="Devoirs à la maison"
      title={data ? weekTitle(data.weekStart) : "Semaine de devoirs"}
      subtitle={data ? `${weekRange(data.weekStart, data.weekEnd)}${workDays ? ` · jours de travail : ${workDays}` : ""}` : undefined}
      back={BACK}
    >
      {query.loading && !data && <Loading slow={query.slow} />}
      {gone && <Notice tone="info">Cette page n&apos;existe plus ou ne vous est pas accessible.</Notice>}
      {query.error && !gone && <RetryNotice message={query.error.kind === "server" ? "La semaine n'a pas pu être chargée." : query.error.message} onRetry={query.reload} />}
      {data && (
        <div className={week.week}>
          <WeekPages data={data} childId={current?.memberId ?? null} answers={answers} onPick={setChild} onAnswers={() => setAnswers((v) => !v)} onChanged={query.reload} />
        </div>
      )}
    </AppShell>
  );
}

/**
 * Les pages de la semaine : un onglet par enfant et la page de l'enfant affiché. Chaque enfant suivi par l'aide Devoirs a sa page, même sans élément cette semaine : le lien
 * d'un enfant ouvre toujours la sienne (« Rien de prévu pour [prénom] cette semaine », avec « Refaire la semaine de [prénom] »), jamais celle d'un autre enfant.
 */
export function WeekPages({ data, childId, answers, onPick, onAnswers, onChanged }: { data: WeekView; childId: string | null; answers: boolean; onPick: (memberId: string) => void; onAnswers: () => void; onChanged: () => void }) {
  const current = childOfWeek(data.children, childId);
  return (
    <>
      <div className={week.bar}>
        {data.children.length > 1 && (
          <div role="tablist" aria-label="Enfant" className={week.bar}>
            {data.children.map((c) => (
              <button key={c.memberId} type="button" role="tab" aria-selected={c.memberId === current?.memberId} className={week.tab} onClick={() => onPick(c.memberId)}>
                {c.firstName}
              </button>
            ))}
          </div>
        )}
        <span className={week.spacer} />
        <button type="button" className={week.toggle} aria-pressed={answers} onClick={onAnswers}>
          Corrigés (parents)
        </button>
        <Link href={`/assistant/devoirs/${data.id}/imprimer`} className={week.barLink}>
          Imprimer
        </Link>
      </div>
      {current && <ChildWeek weekView={data} child={current} answers={answers} onChanged={onChanged} />}
      {data.children.length === 0 && <p className={styles.hint}>Cette semaine n&apos;a plus aucun élément.</p>}
    </>
  );
}

function ChildWeek({ weekView, child, answers, onChanged }: { weekView: WeekView; child: WeekChildView; answers: boolean; onChanged: () => void }) {
  const mutation = useApiMutation();
  const [adding, setAdding] = useState<number | null>(null);
  const [zoom, setZoom] = useState<WeekItemView | null>(null);

  async function patch(item: WeekItemView, body: Record<string, unknown>) {
    const done = await mutation.run(`/api/family/homework/items/${item.id}`, { method: "PATCH", body });
    if (done !== undefined) onChanged();
  }
  async function remove(item: WeekItemView) {
    const done = await mutation.run(`/api/family/homework/items/${item.id}`, { method: "DELETE" });
    if (done !== undefined) onChanged();
  }

  useEffect(() => {
    if (!zoom) return;
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setZoom(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoom]);

  return (
    <section className={week.kid} aria-label={`Semaine de ${child.firstName}`}>
      <div className={week.kidHead}>
        <h2 className={week.kidName}>{child.firstName}</h2>
        <span className={week.kidLevel}>{child.levelLabel}</span>
        <span className={week.scrollHint}>Faites glisser pour voir la semaine ›</span>
      </div>
      {child.items.length === 0 && <Notice tone="info">Rien de prévu pour {child.firstName} cette semaine.</Notice>}
      {child.suggestOlderAge && <Notice tone="info">{child.firstName} a validé tous les exercices du niveau. Vous pouvez augmenter son âge des devoirs d&apos;un an dans les réglages.</Notice>}
      <div className={week.grid}>
        {DAYS.map((day) => {
          const working = weekView.workDays.includes(day);
          const items = child.items.filter((i) => i.day === day);
          const rest = !working && items.length === 0;
          return (
            <div key={day} className={`${week.day} ${rest ? week.rest : ""}`}>
              <h3 className={week.dayHead}>
                <span>
                  <span className={week.dayLong}>{DAY_LONG[day - 1]}</span>
                  <span className={week.dayShort}>{DAY_SHORT[day - 1]}</span>
                </span>
                <small>{dayDate(weekView.weekStart, day)}</small>
              </h3>
              {items.length === 0 && <div className={week.empty}>{working ? "Libre" : "Repos"}</div>}
              {items.map((item) => (
                <ItemCard key={item.id} item={item} weekView={weekView} answers={answers} busy={mutation.pending} onCheck={(checked) => void patch(item, { checked })} onMove={(to) => void patch(item, { day: to })} onRemove={() => void remove(item)} onZoom={() => setZoom(item)} />
              ))}
              {working &&
                (adding === day ? (
                  <AddInDay weekId={weekView.id} memberId={child.memberId} day={day} onDone={() => { setAdding(null); onChanged(); }} onCancel={() => setAdding(null)} />
                ) : (
                  <button type="button" className={week.addBtn} onClick={() => setAdding(day)}>
                    + Ajouter une activité
                  </button>
                ))}
            </div>
          );
        })}
      </div>
      {mutation.error && <Notice tone="error">{mutation.error.kind === "server" ? "La modification n'a pas pu être enregistrée." : mutation.error.message}</Notice>}
      <p className={styles.hint}>Une case cochée compte comme « fait ». Envoyez une photo du travail pour que les progrès soient notés.</p>
      {/* Refaire la semaine de cet enfant seul (US-119 RF12) : ses devoirs à venir sont remplacés, ce qui est fait est gardé. Une semaine passée ne se refait plus. */}
      {weekView.weekEnd >= todayLocal() && (
        <Link
          href={`/assistant/devoirs/preparer?refaire=${weekView.id}&enfant=${child.memberId}`}
          style={{ display: "flex", justifyContent: "center", alignItems: "center", minHeight: 40, border: "1px solid var(--line)", borderRadius: 8, background: "var(--bg-raised)", fontSize: 13, fontWeight: 700, color: "var(--ink)", textDecoration: "none" }}
        >
          Refaire la semaine de {child.firstName}
        </Link>
      )}
      <PhotoPanel weekId={weekView.id} child={child} onDone={onChanged} />
      {zoom?.card && (
        <div className={week.lightbox} role="dialog" aria-modal="true" aria-label={`Carte : ${zoom.title}`} onClick={() => setZoom(null)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={zoom.card} alt={`Carte : ${zoom.title}`} />
          <button type="button" className={week.toggle} onClick={() => setZoom(null)}>
            Fermer
          </button>
        </div>
      )}
    </section>
  );
}

function ItemCard({ item, weekView, answers, busy, onCheck, onMove, onRemove, onZoom }: { item: WeekItemView; weekView: WeekView; answers: boolean; busy: boolean; onCheck: (checked: boolean) => void; onMove: (day: number) => void; onRemove: () => void; onZoom: () => void }) {
  const [open, setOpen] = useState(false);
  const hasDetails = Boolean(item.statement || item.materials || item.steps.length > 0);
  const meta = [item.kind === "exercise" ? item.source : item.kind === "activity" ? item.source.replace(" · avec un adulte", "") : null, item.needsAdult ? "avec un adulte" : null].filter(Boolean).join(" · ");
  return (
    <div className={`${week.item} ${item.checked ? week.done : ""}`}>
      <div className={week.itemTop}>
        <input type="checkbox" className={week.check} checked={item.checked} disabled={busy} onChange={(e) => onCheck(e.target.checked)} aria-label={`${item.checked ? "Décocher" : "Cocher"} : ${item.title}`} />
        {/* L'étiquette de catégorie fait partie du titre : elle coule avec le texte, comme dans la maquette. */}
        {hasDetails ? (
          <button type="button" className={week.titleBtn} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <Chip item={item} />
            {item.title}
          </button>
        ) : (
          <div className={`${week.titleBtn} ${week.titlePlain}`}>
            <Chip item={item} />
            {item.title}
          </div>
        )}
      </div>
      {meta && <div className={week.meta}>{meta}</div>}
      {open && (
        <div className={week.details}>
          {item.statement && <p>{item.statement}</p>}
          {item.materials && <p>Matériel : {item.materials}</p>}
          {item.steps.length > 0 && (
            <ol>
              {item.steps.map((step, i) => (
                <li key={i}>{step}</li>
              ))}
            </ol>
          )}
        </div>
      )}
      {item.card && (
        <button type="button" className={week.card} aria-label={`Agrandir la carte : ${item.title}`} onClick={onZoom}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={item.card} alt={`Carte illustrée : ${item.title}`} loading="lazy" />
        </button>
      )}
      {answers && item.answer && <div className={week.answer}>Corrigé : {item.answer}</div>}
      <div className={week.act}>
        <select aria-label={`Déplacer « ${item.title} » au jour`} value={item.day} disabled={busy} onChange={(e) => onMove(Number(e.target.value))}>
          {weekView.workDays.map((d) => (
            <option key={d} value={d}>
              {DAY_LONG[d - 1]}
            </option>
          ))}
        </select>
        <button type="button" className={week.small} disabled={busy} onClick={onRemove}>
          Retirer
        </button>
      </div>
    </div>
  );
}

function Chip({ item }: { item: WeekItemView }) {
  return (
    <span className={week.chip} style={{ ["--k" as string]: `var(--c-${item.domain})` }}>
      {DOMAIN_LABEL[item.domain]}
    </span>
  );
}

function AddInDay({ weekId, memberId, day, onDone, onCancel }: { weekId: string; memberId: string; day: number; onDone: () => void; onCancel: () => void }) {
  const mutation = useApiMutation();
  const [title, setTitle] = useState("");
  const invalid = !title.trim() || title.length > 100;
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (invalid) return;
    const done = await mutation.run(`/api/family/homework/weeks/${weekId}/items`, { method: "POST", body: { memberId, item: { kind: "custom", title: title.trim(), days: [day] } } });
    if (done !== undefined) onDone();
  }
  return (
    <form className={week.addForm} onSubmit={submit}>
      <input value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} placeholder="ex. Lecture 15 min" aria-label={`Titre de l'activité du ${DAY_LONG[day - 1].toLowerCase()}`} autoFocus />
      {mutation.error && <div className={week.meta}>{mutation.error.kind === "server" ? "L'activité n'a pas pu être ajoutée." : mutation.error.message}</div>}
      <div className={week.addRow}>
        <button type="submit" className={week.addOk} disabled={invalid || mutation.pending}>
          Ajouter
        </button>
        <button type="button" className={week.small} onClick={onCancel} disabled={mutation.pending}>
          Annuler
        </button>
      </div>
    </form>
  );
}
