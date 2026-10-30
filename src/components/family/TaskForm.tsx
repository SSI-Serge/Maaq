"use client";

import { useState } from "react";
import { useApiMutation } from "@/client/hooks";
import { Button, Notice, RetryNotice } from "@/components/ui";
import type { MemberChip } from "@/server/assistant/member-chips";
import type { TaskRepetition, TaskView } from "@/server/assistant/tasks";
import { Field } from "./EventForm";
import { todayLocal } from "./format";
import { FALLBACK_COLOR } from "./parts";
import styles from "./family.module.css";

const MAX_TITLE = 100;
const MAX_NOTE = 500;

type Frequency = TaskRepetition["frequency"];
type Scope = "this" | "following" | "all";

const FREQUENCIES: { value: "none" | Frequency; label: string }[] = [
  { value: "none", label: "Ne se répète pas" },
  { value: "daily", label: "Chaque jour" },
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
  { value: "this", label: "Cette fois" },
  { value: "following", label: "Cette fois et les suivantes" },
  { value: "all", label: "Toutes" },
];

/** Ce que le formulaire reprend d'une carte du tchat ou d'une tâche existante. */
export interface TaskFormInitial {
  title: string;
  note?: string | null;
  due: string;
  dueTime?: string | null;
  assigneeId?: string | null;
  repetition?: TaskRepetition | null;
}

/** Pastilles « Assignée à » : les membres que ce profil peut choisir, et « Personne » (US-96 RF2). */
export function AssigneePicker({ members, value, onChange, disabled }: { members: MemberChip[]; value: string | null; onChange: (id: string | null) => void; disabled?: boolean }) {
  return (
    <div className={styles.members} role="group" aria-label="Assignée à">
      <button type="button" className={styles.chipToggle} aria-pressed={value === null} onClick={() => onChange(null)} disabled={disabled}>
        <span className={styles.dot} style={{ background: FALLBACK_COLOR }} aria-hidden />
        Personne
      </button>
      {members.map((m) => (
        <button key={m.id} type="button" className={styles.chipToggle} aria-pressed={value === m.id} onClick={() => onChange(m.id)} disabled={disabled}>
          <span className={styles.dot} style={{ background: m.color || FALLBACK_COLOR }} aria-hidden />
          {m.firstName}
        </button>
      ))}
    </div>
  );
}

interface Props {
  /** Tâche à modifier ; sans elle, le formulaire crée une tâche. */
  task?: TaskView;
  initial?: TaskFormInitial;
  assignable: MemberChip[];
  /** Le second argument porte la proposition de l'aide Devoirs quand le titre de la tâche créée parle de devoirs (US-119 RF1). */
  onSaved: (task: TaskView, extras?: { homeworkOffer: { weekStart: string } | null }) => void;
  onCancel: () => void;
  /** La tâche a été annulée (« Annuler la tâche »). */
  onRemoved?: (cancelled: number) => void;
}

/**
 * Formulaire de tâche (US-110 RF2) : titre obligatoire (100 caractères), échéance et heure facultative, personne assignée, note (500) et, à la création, répétition.
 * Une tâche récurrente se modifie ou s'annule pour une portée choisie (RF5). Le serveur refuse une version périmée.
 */
export function TaskForm({ task, initial, assignable, onSaved, onCancel, onRemoved }: Props) {
  const start = task ? { title: task.title, note: task.note, due: task.due, dueTime: task.dueTime, assigneeId: task.assignee?.id ?? null, repetition: null } : (initial ?? { title: "", due: todayLocal() });
  const [title, setTitle] = useState(start.title);
  const [due, setDue] = useState(start.due);
  const [dueTime, setDueTime] = useState(start.dueTime ?? "");
  const [assigneeId, setAssigneeId] = useState<string | null>(start.assigneeId ?? null);
  const [note, setNote] = useState(start.note ?? "");
  const rep = start.repetition ?? null;
  const [frequency, setFrequency] = useState<"none" | Frequency>(rep?.frequency ?? "none");
  const [weekdays, setWeekdays] = useState<number[]>(rep?.weekdays ?? []);
  const [endKind, setEndKind] = useState<"date" | "count" | "never">(rep?.end.kind ?? "never");
  const [untilDate, setUntilDate] = useState(rep?.end.kind === "date" ? rep.end.date : "");
  const [count, setCount] = useState(rep?.end.kind === "count" ? String(rep.end.count) : "10");
  const [scope, setScope] = useState<Scope>("this");
  const [confirmCancel, setConfirmCancel] = useState(false);
  const save = useApiMutation();

  const recurringEdit = Boolean(task?.recurring && !task.followsEventSeries);
  const titleError = !title.trim() ? "Le titre est obligatoire." : title.length > MAX_TITLE ? `Le titre ne peut pas dépasser ${MAX_TITLE} caractères.` : null;
  const repeating = !task && frequency !== "none";
  const endError = !repeating ? null : endKind === "date" ? (!untilDate ? "Indiquez la date de fin, ou choisissez « Sans fin »." : untilDate < due ? "La date de fin doit être après la première échéance." : null) : endKind === "count" ? (!/^\d+$/.test(count) || Number(count) < 1 || Number(count) > 400 ? "Indiquez un nombre de fois entre 1 et 400." : null) : null;
  const invalid = Boolean(titleError || !due || endError || note.length > MAX_NOTE);

  async function submit() {
    if (invalid) return;
    const fields = { title: title.trim(), note: note.trim() || null, due, dueTime: dueTime || null, assigneeId };
    type Saved = { task: TaskView; homeworkOffer?: { weekStart: string } | null };
    const result = task
      ? await save.run<Saved>(`/api/family/tasks/${task.id}`, { method: "PATCH", body: { version: task.version, ...(recurringEdit ? { scope } : {}), ...fields } })
      : await save.run<Saved>("/api/family/tasks", {
          method: "POST",
          body: {
            ...fields,
            ...(repeating
              ? {
                  repetition: {
                    frequency,
                    ...(frequency === "weekly" || frequency === "biweekly" ? { weekdays: weekdays.length ? weekdays : undefined } : {}),
                    end: endKind === "date" ? { kind: "date", date: untilDate } : endKind === "count" ? { kind: "count", count: Number(count) } : { kind: "never" },
                  },
                }
              : {}),
          },
        });
    if (result) onSaved(result.task, { homeworkOffer: result.homeworkOffer ?? null });
  }

  async function cancelTask() {
    if (!task) return;
    const result = await save.run<{ result: { cancelled: number } }>(`/api/family/tasks/${task.id}/cancel`, { method: "POST", body: { version: task.version, ...(recurringEdit ? { scope } : {}) } });
    if (result) onRemoved?.(result.result.cancelled);
  }

  const code = save.error?.body?.code;
  return (
    <form
      className={styles.form}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Field label="Titre" error={title && titleError ? titleError : null}>
        <input className={`${styles.input} ${title && titleError ? styles.inputError : ""}`} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={MAX_TITLE + 20} disabled={save.pending} placeholder="Payer la cantine" />
      </Field>

      <div className={styles.two}>
        <Field label="Échéance" error={!due ? "L'échéance est obligatoire." : null}>
          <input type="date" className={styles.input} value={due} onChange={(e) => setDue(e.target.value)} disabled={save.pending} />
        </Field>
        <Field label="Avant (facultatif)">
          <input type="time" className={styles.input} value={dueTime} onChange={(e) => setDueTime(e.target.value)} disabled={save.pending} aria-label="Heure d'échéance" />
        </Field>
      </div>

      <Field label="Assignée à">
        <AssigneePicker members={assignable} value={assigneeId} onChange={setAssigneeId} disabled={save.pending} />
      </Field>

      {!task && (
        <fieldset className={styles.field} disabled={save.pending}>
          <legend className={styles.label}>Répétition</legend>
          <select className={styles.select} value={frequency} onChange={(e) => setFrequency(e.target.value as "none" | Frequency)} aria-label="Répétition">
            {FREQUENCIES.map((o) => (
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
              <span className={styles.hint}>Sans jour choisi, le jour de la première échéance.</span>
            </div>
          )}
          {repeating && (
            <>
              <select className={styles.select} value={endKind} onChange={(e) => setEndKind(e.target.value as "date" | "count" | "never")} aria-label="Fin de la répétition">
                <option value="never">Sans fin</option>
                <option value="date">Jusqu&apos;à une date</option>
                <option value="count">Après un nombre de fois</option>
              </select>
              {endKind === "date" && <input type="date" className={styles.input} value={untilDate} min={due} onChange={(e) => setUntilDate(e.target.value)} aria-label="Date de fin" />}
              {endKind === "count" && <input type="number" className={styles.input} value={count} min={1} max={400} onChange={(e) => setCount(e.target.value)} aria-label="Nombre de fois" />}
              {endError && (
                <span className={styles.fieldError} role="alert">
                  {endError}
                </span>
              )}
            </>
          )}
        </fieldset>
      )}

      {recurringEdit && (
        <fieldset className={styles.field} disabled={save.pending}>
          <legend className={styles.label}>Cette tâche revient : {task?.rule}</legend>
          <div className={styles.members} role="radiogroup" aria-label="Portée">
            {SCOPES.map((s) => (
              <button key={s.value} type="button" role="radio" aria-checked={scope === s.value} className={styles.chipToggle} aria-pressed={scope === s.value} onClick={() => setScope(s.value)}>
                {s.label}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      {task?.followsEventSeries && <span className={styles.hint}>Cette tâche suit une série de RDV : seule cette fois est modifiée. Pour toutes les séances, modifiez-la depuis le RDV.</span>}

      <Field label="Note" error={note.length > MAX_NOTE ? `La note ne peut pas dépasser ${MAX_NOTE} caractères.` : null}>
        <textarea className={styles.textarea} value={note} onChange={(e) => setNote(e.target.value)} disabled={save.pending} />
        <span className={styles.counter}>
          {note.length}/{MAX_NOTE}
        </span>
      </Field>

      {code === "stale_version" && (
        <div className={styles.dialog} role="alert">
          <span>Cette tâche a été modifiée entre-temps.</span>
          <Button variant="secondary" onClick={onCancel}>
            Afficher la dernière version
          </Button>
        </div>
      )}
      {save.error && !code && <RetryNotice message={save.error.kind === "server" ? "La tâche n'a pas pu être enregistrée. Vos modifications sont conservées." : save.error.message} onRetry={() => void (confirmCancel ? cancelTask() : submit())} />}
      {save.error && code && code !== "stale_version" && <Notice tone="error">{save.error.message}</Notice>}
      {save.slow && <Notice tone="info">Toujours en cours…</Notice>}

      <div className={styles.actionsRow}>
        <Button variant="ghost" type="button" onClick={onCancel} disabled={save.pending}>
          Fermer
        </Button>
        <Button type="submit" loading={save.pending && !confirmCancel} disabled={invalid || save.pending}>
          {save.pending && !confirmCancel ? "Enregistrement…" : "Enregistrer"}
        </Button>
      </div>

      {task?.can.manage && !confirmCancel && (
        <Button variant="danger" type="button" block onClick={() => setConfirmCancel(true)} disabled={save.pending}>
          Annuler la tâche
        </Button>
      )}
      {confirmCancel && (
        <div className={styles.dialog} role="alertdialog" aria-label="Annuler la tâche ?">
          <div className={styles.dialogTitle}>Annuler la tâche ?</div>
          <div>{recurringEdit ? `Choisissez la portée ci-dessus : « ${SCOPES.find((s) => s.value === scope)?.label.toLowerCase()} ».` : "Elle sera retirée de la liste. Rien de grave si elle n'est plus utile."}</div>
          <div className={styles.actionsRow}>
            <Button variant="secondary" type="button" onClick={() => setConfirmCancel(false)} disabled={save.pending}>
              Revenir
            </Button>
            <Button variant="danger" type="button" onClick={() => void cancelTask()} loading={save.pending} disabled={save.pending}>
              Annuler la tâche
            </Button>
          </div>
        </div>
      )}
    </form>
  );
}
