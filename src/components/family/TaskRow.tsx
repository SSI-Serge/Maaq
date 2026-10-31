"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApiMutation } from "@/client/hooks";
import { Notice, RetryNotice } from "@/components/ui";
import type { MemberChip } from "@/server/assistant/member-chips";
import type { TaskView } from "@/server/assistant/tasks";
import { clock, shortDate } from "./format";
import { AssigneePicker } from "./TaskForm";
import { FALLBACK_COLOR } from "./parts";
import styles from "./family.module.css";

/** Le bouton « Annuler » du cochage reste 10 secondes (US-110 RF7). */
const UNDO_MS = 10_000;

/** « avant 8h15 » (US-110 RF2). */
export const dueTimeLabel = (time: string) => `avant ${clock(`0000-00-00T${time}`)}`;

interface Props {
  task: TaskView;
  assignable: MemberChip[];
  /** Montre l'échéance (jour) ; dans « Aujourd'hui » seule l'heure compte. */
  showDate?: boolean;
  /** La liste doit être relue (cochage, assignation). */
  onChanged: () => void;
}

/**
 * Une tâche dans une liste (US-110 RF7, US-96 RF2, RF7) : case à cocher (« Faite par [prénom] », « Annuler » pendant 10 secondes), couleur du membre assigné (gris sans
 * assigné), appui sur le nom pour réassigner. « En retard » est une mention grise, sans alerte (AT-9). En cas d'erreur, la case reprend son état (CC-2).
 */
export function TaskRow({ task, assignable, showDate = true, onChanged }: Props) {
  const mutation = useApiMutation();
  const [undoUntil, setUndoUntil] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const done = task.status === "done";

  // Passé les 10 secondes, la ligne se range d'elle-même dans « Faites ».
  useEffect(() => {
    if (undoUntil === null) return;
    const timer = setTimeout(() => {
      setUndoUntil(null);
      onChanged();
    }, Math.max(0, undoUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [undoUntil, onChanged]);

  async function toggle(next: boolean) {
    const result = await mutation.run<{ task: TaskView }>(`/api/family/tasks/${task.id}/check`, { method: "POST", body: { done: next, version: task.version } });
    if (!result) return;
    if (next) setUndoUntil(Date.now() + UNDO_MS);
    else {
      setUndoUntil(null);
      onChanged();
    }
  }

  async function assign(memberId: string | null) {
    const result = await mutation.run<{ task: TaskView }>(`/api/family/tasks/${task.id}/assign`, { method: "POST", body: { memberId, version: task.version } });
    if (!result) return;
    setPicking(false);
    onChanged();
  }

  const justDone = undoUntil !== null;
  const checked = justDone || done;
  const color = task.assignee?.color ?? FALLBACK_COLOR;
  const code = mutation.error?.body?.code;
  const canAssign = task.can.manage && task.status === "todo" && assignable.length > 0;
  return (
    <div className={`${styles.taskRow} ${checked ? styles.taskDone : ""}`} style={{ borderLeftColor: color }}>
      <input
        type="checkbox"
        className={styles.taskCheck}
        checked={checked}
        disabled={!task.can.check || mutation.pending || justDone}
        onChange={(e) => void toggle(e.target.checked)}
        aria-label={`${checked ? "Décocher" : "Cocher"} : ${task.title}`}
      />
      <div className={styles.taskBody}>
        <Link href={`/assistant/taches/${task.id}`} className={styles.taskTitle}>
          {task.assignee && task.assignee.role === "child" && !task.homeworkWeekId ? `${task.assignee.firstName} — ${task.title.charAt(0).toLowerCase()}${task.title.slice(1)}` : task.title}
        </Link>
        <div className={styles.taskMeta}>
          {task.overdue && !checked && <span className={styles.taskLate}>En retard</span>}
          {canAssign ? (
            <button type="button" className={styles.assignee} onClick={() => setPicking((v) => !v)} aria-expanded={picking} disabled={mutation.pending}>
              <span className={styles.dot} style={{ background: color }} aria-hidden />
              {task.assignee?.firstName ?? "Non assignée"}
            </button>
          ) : (
            <span>{task.assignee?.firstName ?? "Non assignée"}</span>
          )}
          {showDate && <span>{shortDate(task.due)}</span>}
          {task.dueTime && <span>{dueTimeLabel(task.dueTime)}</span>}
          {task.recurring && <span title={task.rule ?? "À chaque séance"}>↻ {task.rule ?? "À chaque séance"}</span>}
          {task.event && <Link href={`/calendrier/rdv/${task.event.id}`}>{task.event.title} ›</Link>}
          {task.homeworkWeekId && <Link href={`/assistant/devoirs/${task.homeworkWeekId}`}>Semaine de devoirs ›</Link>}
          {task.homeworkPrep &&
            (task.homeworkPrep.weekId ? (
              <Link href={`/assistant/devoirs/${task.homeworkPrep.weekId}`}>Voir la semaine de devoirs ›</Link>
            ) : (
              <Link href={`/assistant/devoirs/preparer?semaine=${task.homeworkPrep.weekStart}`}>Préparer les devoirs de la semaine ›</Link>
            ))}
          {checked && task.status === "done" && task.doneBy && <span>Faite par {task.doneBy}</span>}
          {justDone && (
            <>
              <span>Faite</span>
              <button type="button" className={styles.undo} onClick={() => void toggle(false)} disabled={mutation.pending}>
                Annuler
              </button>
            </>
          )}
        </div>
        {task.overdue && !checked && <p className={styles.taskHint}>Rien de grave : faites-la quand vous pouvez, confiez-la, ou abandonnez-la si elle n&apos;est plus utile.</p>}
        {picking && <AssigneePicker members={assignable} value={task.assignee?.id ?? null} onChange={(id) => void assign(id)} disabled={mutation.pending} />}
        {mutation.error && code === "stale_version" && (
          <Notice tone="info">
            Cette tâche a changé entre-temps.{" "}
            <button type="button" className={styles.undo} onClick={onChanged}>
              Actualiser
            </button>
          </Notice>
        )}
        {mutation.error && code !== "stale_version" && (mutation.error.kind === "rejected" ? <Notice tone="error">{mutation.error.message}</Notice> : <RetryNotice message={mutation.error.kind === "server" ? "L'opération n'a pas pu être enregistrée." : mutation.error.message} onRetry={mutation.reset} />)}
      </div>
    </div>
  );
}
