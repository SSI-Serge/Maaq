"use client";

import { useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { Button, Notice, RetryNotice } from "@/components/ui";
import type { EventType } from "@/server/assistant/calendar";
import type { ConflictView, EventView, MemberChip } from "@/server/assistant/events";
import { clock, dayOf, EVENT_TYPE_OPTIONS, formTime, shortDate } from "./format";
import { FALLBACK_COLOR } from "./parts";
import styles from "./family.module.css";

type Frequency = "weekly" | "biweekly" | "monthly_day" | "monthly_weekday";
type Scope = "this" | "following" | "all";

const FREQUENCIES: { value: "none" | Frequency; label: string }[] = [
  { value: "none", label: "Ne se répète pas" },
  { value: "weekly", label: "Chaque semaine" },
  { value: "biweekly", label: "Toutes les deux semaines" },
  { value: "monthly_day", label: "Chaque mois, le même jour du mois" },
  { value: "monthly_weekday", label: "Chaque mois, le même jour de la semaine" },
];
const WEEKDAYS = [
  { value: 1, label: "L", name: "lundi" },
  { value: 2, label: "M", name: "mardi" },
  { value: 3, label: "M", name: "mercredi" },
  { value: 4, label: "J", name: "jeudi" },
  { value: 5, label: "V", name: "vendredi" },
  { value: 6, label: "S", name: "samedi" },
  { value: 7, label: "D", name: "dimanche" },
];
const SCOPES: { value: Scope; label: string }[] = [
  { value: "this", label: "Cette séance" },
  { value: "following", label: "Cette séance et les suivantes" },
  { value: "all", label: "Toute la série" },
];

const MAX_TITLE = 100;
const MAX_PLACE = 200;
const MAX_NOTES = 500;

/** Phrase de la bannière de conflit (US-74 RF5, RF10) : le titre n'est donné que si ce profil a le droit de voir ce rendez-vous. */
export function conflictSentence(conflict: ConflictView, day: string): string {
  if (!conflict.title) return "Ce créneau chevauche un autre rendez-vous de la famille.";
  return dayOf(conflict.start) === day
    ? `Ce créneau chevauche « ${conflict.title} », le même jour à ${clock(conflict.start)}.`
    : `Ce créneau chevauche « ${conflict.title} », le ${shortDate(dayOf(conflict.start))} à ${clock(conflict.start)}.`;
}

interface Props {
  event: EventView;
  members: MemberChip[];
  onSaved: (event: EventView) => void;
  onCancel: () => void;
  /** Version dépassée : l'écran se recharge avec la dernière version (US-76 RF8). */
  onStale: () => void;
}

/**
 * Formulaire de modification d'un rendez-vous provisoire (US-76) ou confirmé (US-80), prérempli. Les valeurs saisies sont conservées en
 * cas d'erreur. Pour un rendez-vous confirmé, un conflit propose « Enregistrer quand même ».
 */
export function EventForm({ event, members, onSaved, onCancel, onStale }: Props) {
  const [title, setTitle] = useState(event.title);
  const [type, setType] = useState<EventType>(event.type);
  const [allFamily, setAllFamily] = useState(event.allFamily);
  const [memberIds, setMemberIds] = useState<string[]>(event.members.map((m) => m.id));
  const [allDay, setAllDay] = useState(event.allDay);
  const [date, setDate] = useState(dayOf(event.start));
  const [startTime, setStartTime] = useState(event.allDay ? "09:00" : formTime(event.start));
  const [endTime, setEndTime] = useState(event.allDay ? "10:00" : formTime(event.end));
  const [endDate, setEndDate] = useState(dayOf(event.end));
  const [place, setPlace] = useState(event.place ?? "");
  const [notes, setNotes] = useState(event.notes ?? "");
  const save = useApiMutation();

  // Répétition (US-109 RF7) : un RDV provisoire peut devenir une série ; une série se modifie pour la portée choisie (RF8).
  const series = event.series;
  const confirmedSeries = series?.status === "confirmed";
  const [frequency, setFrequency] = useState<"none" | Frequency>(series?.repetition.frequency ?? "none");
  const [weekdays, setWeekdays] = useState<number[]>(series?.repetition.weekdays ?? []);
  const [endKind, setEndKind] = useState<"date" | "count" | "never">(series?.repetition.end.kind ?? "date");
  const [untilDate, setUntilDate] = useState(series?.repetition.end.kind === "date" ? series.repetition.end.date : "");
  const [count, setCount] = useState(series?.repetition.end.kind === "count" ? String(series.repetition.end.count) : "10");
  const [skipHolidays, setSkipHolidays] = useState(series?.repetition.skipSchoolHolidays ?? false);
  const [scope, setScope] = useState<Scope>("this");
  const zone = useApiQuery<{ setting: { zone: string | null } }>("/api/family/school-zone");
  const canRepeat = event.status === "provisional" || Boolean(series);
  const repeating = frequency !== "none";
  const endError = !repeating ? null : endKind === "date" ? (!untilDate ? "Indiquez la date de fin, ou choisissez « Sans fin »." : untilDate < date ? "La date de fin doit être après la première séance." : null) : endKind === "count" ? (!/^\d+$/.test(count) || Number(count) < 1 || Number(count) > 400 ? "Indiquez un nombre de séances entre 1 et 400." : null) : null;
  const scopeAll = !series || !confirmedSeries || scope !== "this";

  const multiDay = dayOf(event.start) !== dayOf(event.end);
  const lastDay = multiDay || allDay ? endDate : date;
  const rangeError = !allDay && endTime && lastDay === date && endTime <= startTime ? "L'heure de fin doit être après l'heure de début." : null;
  const dateError = allDay && endDate < date ? "La date de fin doit être après la date de début." : !date ? "La date est obligatoire." : null;
  const titleError = !title.trim() ? "Le titre est obligatoire." : title.length > MAX_TITLE ? `Le titre ne peut pas dépasser ${MAX_TITLE} caractères.` : null;
  const membersError = !allFamily && memberIds.length === 0 ? "Choisissez au moins un membre concerné." : null;
  const invalid = Boolean(titleError || rangeError || dateError || membersError || endError || place.length > MAX_PLACE || notes.length > MAX_NOTES);

  function toggleMember(id: string) {
    setMemberIds((current) => (current.includes(id) ? current.filter((m) => m !== id) : [...current, id]));
  }

  async function submit(allowConflict: boolean) {
    const result = await save.run<{ event: EventView }>(`/api/family/events/${event.id}`, {
      method: "PATCH",
      body: {
        version: event.version, allowConflict, title: title.trim(), type, allFamily, memberIds: allFamily ? [] : memberIds, allDay,
        start: allDay ? date : `${date}T${startTime}`,
        end: allDay ? endDate : multiDay ? `${endDate}T${endTime}` : endTime ? `${date}T${endTime}` : null,
        place: place.trim() || null, notes: notes.trim() || null,
        ...(confirmedSeries ? { scope } : {}),
        // Pas de nouvelle règle pour « cette séance » seule : elle reste une séance de la série.
        ...(repeating && scopeAll && canRepeat
          ? {
              repetition: {
                frequency,
                ...(frequency === "weekly" || frequency === "biweekly" ? { weekdays: weekdays.length ? weekdays : undefined } : {}),
                end: endKind === "date" ? { kind: "date", date: untilDate } : endKind === "count" ? { kind: "count", count: Number(count) } : { kind: "never" },
                skipSchoolHolidays: skipHolidays && Boolean(zone.data?.setting.zone),
              },
            }
          : {}),
      },
    });
    if (result) onSaved(result.event);
  }

  // Un conflit (rendez-vous confirmé) ou une version dépassée sont des réponses attendues, pas des pannes.
  const code = save.error?.body?.code;
  const conflicts = code === "conflict" ? ((save.error?.body?.details as { conflicts: ConflictView[] } | undefined)?.conflicts ?? []) : null;
  const stale = code === "stale_version";

  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid) void submit(false);
      }}
      aria-label="Modifier le rendez-vous"
    >
      <Field label="Titre" error={titleError}>
        <input className={`${styles.input} ${titleError ? styles.inputError : ""}`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={MAX_TITLE + 20} disabled={save.pending} />
      </Field>

      <Field label="Type de rendez-vous">
        <select className={styles.select} value={type} onChange={(e) => setType(e.target.value as EventType)} disabled={save.pending}>
          {EVENT_TYPE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </Field>

      <Field label="Membres concernés" error={membersError}>
        <div className={styles.members}>
          <button type="button" className={styles.chipToggle} aria-pressed={allFamily} onClick={() => setAllFamily(!allFamily)} disabled={save.pending}>
            Toute la famille
          </button>
          {!allFamily &&
            members.map((m) => (
              <button key={m.id} type="button" className={styles.chipToggle} aria-pressed={memberIds.includes(m.id)} onClick={() => toggleMember(m.id)} disabled={save.pending}>
                <span className={styles.dot} style={{ background: m.color || FALLBACK_COLOR }} aria-hidden />
                {m.firstName}
              </button>
            ))}
        </div>
      </Field>

      <label className={styles.check}>
        <input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} disabled={save.pending} />
        Toute la journée
      </label>

      <Field label={allDay ? "Date de début" : "Date"} error={allDay ? dateError : !date ? "La date est obligatoire." : null}>
        <input type="date" className={styles.input} value={date} onChange={(e) => setDate(e.target.value)} disabled={save.pending} />
      </Field>
      {(allDay || multiDay) && (
        <Field label="Date de fin">
          <input type="date" className={styles.input} value={endDate} min={date} onChange={(e) => setEndDate(e.target.value)} disabled={save.pending} />
        </Field>
      )}
      {!allDay && (
        <div className={styles.two}>
          <Field label="Début">
            <input type="time" className={styles.input} value={startTime} onChange={(e) => setStartTime(e.target.value)} disabled={save.pending} />
          </Field>
          <Field label="Fin" error={rangeError}>
            <input type="time" className={`${styles.input} ${rangeError ? styles.inputError : ""}`} value={endTime} onChange={(e) => setEndTime(e.target.value)} disabled={save.pending} />
          </Field>
        </div>
      )}

      {canRepeat && (
        <fieldset className={styles.field} disabled={save.pending}>
          <legend className={styles.label}>Répétition</legend>
          {confirmedSeries && (
            <div className={styles.members} role="radiogroup" aria-label="Portée de la modification">
              {SCOPES.map((s) => (
                <button key={s.value} type="button" role="radio" aria-checked={scope === s.value} className={styles.chipToggle} onClick={() => setScope(s.value)}>
                  {s.label}
                </button>
              ))}
            </div>
          )}
          {scopeAll ? (
            <>
              <select className={styles.select} value={frequency} onChange={(e) => setFrequency(e.target.value as "none" | Frequency)} aria-label="Répétition" disabled={Boolean(series)}>
                {FREQUENCIES.filter((o) => !series || o.value !== "none").map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
              {(frequency === "weekly" || frequency === "biweekly") && (
                <div className={styles.members} role="group" aria-label="Jours de la semaine">
                  {WEEKDAYS.map((w) => (
                    <button key={w.value} type="button" className={styles.chipToggle} aria-pressed={weekdays.includes(w.value)} aria-label={w.name} onClick={() => setWeekdays((cur) => (cur.includes(w.value) ? cur.filter((x) => x !== w.value) : [...cur, w.value]))}>
                      {w.label}
                    </button>
                  ))}
                  <span className={styles.hint}>Sans jour choisi, le jour de la première séance.</span>
                </div>
              )}
              {repeating && (
                <>
                  <select className={styles.select} value={endKind} onChange={(e) => setEndKind(e.target.value as "date" | "count" | "never")} aria-label="Fin de la répétition">
                    <option value="date">Jusqu&apos;à une date</option>
                    <option value="count">Après un nombre de séances</option>
                    <option value="never">Sans fin</option>
                  </select>
                  {endKind === "date" && <input type="date" className={styles.input} value={untilDate} min={date} onChange={(e) => setUntilDate(e.target.value)} aria-label="Date de fin" />}
                  {endKind === "count" && <input type="number" className={styles.input} value={count} min={1} max={400} onChange={(e) => setCount(e.target.value)} aria-label="Nombre de séances" />}
                  {endError && (
                    <span className={styles.fieldError} role="alert">
                      {endError}
                    </span>
                  )}
                  {zone.data?.setting.zone && (
                    <label className={styles.check}>
                      <input type="checkbox" checked={skipHolidays} onChange={(e) => setSkipHolidays(e.target.checked)} />
                      Sauf vacances scolaires (zone {zone.data.setting.zone})
                    </label>
                  )}
                </>
              )}
            </>
          ) : (
            <span className={styles.hint}>Cette séance seule est modifiée ; elle reste rattachée à la série avec la mention « Modifiée ».</span>
          )}
        </fieldset>
      )}

      <Field label="Lieu" error={place.length > MAX_PLACE ? `Le lieu ne peut pas dépasser ${MAX_PLACE} caractères.` : null}>
        <input className={styles.input} value={place} onChange={(e) => setPlace(e.target.value)} disabled={save.pending} />
      </Field>
      <Field label="Note" error={notes.length > MAX_NOTES ? `La note ne peut pas dépasser ${MAX_NOTES} caractères.` : null}>
        <textarea className={styles.textarea} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={save.pending} />
        <span className={styles.counter}>
          {notes.length}/{MAX_NOTES}
        </span>
      </Field>

      {conflicts && (
        <div className={styles.dialog} role="alert">
          {conflicts.map((c) => (
            <div key={c.id}>{conflictSentence(c, date)}</div>
          ))}
          <Button variant="secondary" onClick={() => void submit(true)} loading={save.pending}>
            Enregistrer quand même
          </Button>
          <span className={styles.source}>Ou modifiez l&apos;horaire ci-dessus.</span>
        </div>
      )}
      {stale && (
        <div className={styles.dialog} role="alert">
          <span>Ce rendez-vous a été modifié entre-temps.</span>
          <Button variant="secondary" onClick={onStale}>
            Afficher la dernière version
          </Button>
        </div>
      )}
      {save.error && !code && <RetryNotice message={save.error.kind === "server" ? "Le rendez-vous n'a pas pu être enregistré. Vos modifications sont conservées." : save.error.message} onRetry={() => void submit(false)} />}
      {save.error && code && !["conflict", "stale_version"].includes(code) && <Notice tone="error">{save.error.message}</Notice>}
      {save.slow && <Notice tone="info">Toujours en cours…</Notice>}

      <div className={styles.actionsRow}>
        <Button variant="ghost" type="button" onClick={onCancel} disabled={save.pending}>
          Annuler
        </Button>
        <Button type="submit" loading={save.pending} disabled={invalid}>
          {save.pending ? "Enregistrement…" : "Enregistrer"}
        </Button>
      </div>
    </form>
  );
}

export function Field({ label, error, children }: { label: string; error?: string | null; children: React.ReactNode }) {
  return (
    <div className={styles.field}>
      <span className={styles.label}>{label}</span>
      {children}
      {error && (
        <span className={styles.fieldError} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}
