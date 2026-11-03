"use client";

import { useEffect, useRef, useState } from "react";
import { useApiMutation } from "@/client/hooks";
import type { TaskView } from "@/server/assistant/tasks";
import type { HandOverResult } from "@/server/emotions/handover";
import styles from "./emotions.module.css";

const UNDO_MS = 10_000;
/** Un peu après la fin du délai d'annulation, l'écran demande l'envoi de la notification retenue ; le planificateur le fait aussi au plus tard à son passage suivant. */
const RELEASE_MS = 16_000;

/**
 * « Confier à [prénom] » (US-146) : réassigne la tâche à l'autre parent d'un geste, avec « Annuler » pendant 10 secondes. La notification « vous a confié » est retenue côté serveur
 * pendant ce temps et disparaît si l'on annule (E-18).
 */
export function useHandOver(onChanged: () => void) {
  const mutation = useApiMutation();
  const [last, setLast] = useState<{ task: TaskView; to: string } | null>(null);
  const hide = useRef<ReturnType<typeof setTimeout> | null>(null);
  const release = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (hide.current) clearTimeout(hide.current);
      if (release.current) clearTimeout(release.current);
    },
    [],
  );

  async function handOver(task: TaskView) {
    const result = await mutation.run<HandOverResult>(`/api/family/tasks/${task.id}/hand-over`, { method: "POST", body: { version: task.version } });
    if (!result) return;
    setLast({ task: result.task, to: result.to });
    onChanged();
    if (hide.current) clearTimeout(hide.current);
    if (release.current) clearTimeout(release.current);
    hide.current = setTimeout(() => setLast(null), UNDO_MS);
    release.current = setTimeout(() => void fetch(`/api/family/tasks/${task.id}/hand-over/release`, { method: "POST", credentials: "same-origin" }).catch(() => undefined), RELEASE_MS);
  }

  async function undo() {
    if (!last) return;
    const done = await mutation.run(`/api/family/tasks/${last.task.id}/hand-over/undo`, { method: "POST", body: { version: last.task.version } });
    if (done === undefined) return;
    if (hide.current) clearTimeout(hide.current);
    if (release.current) clearTimeout(release.current);
    setLast(null);
    onChanged();
  }

  const toast = last && (
    <div className={styles.toast} role="status">
      <span>
        « {last.task.title} » est confiée à {last.to}
      </span>
      <button type="button" className={styles.toastBtn} disabled={mutation.pending} onClick={() => void undo()}>
        Annuler
      </button>
    </div>
  );
  return { handOver, pending: mutation.pending, error: mutation.error, toast };
}
