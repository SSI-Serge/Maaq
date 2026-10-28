"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useApiQuery } from "@/client/hooks";
import { AppShell, appStyles as s, Section } from "@/components/app/AppShell";
import { Loading, Notice, RetryNotice } from "@/components/ui";
import type { TaskLists, TaskView } from "@/server/assistant/tasks";
import { TaskForm } from "./TaskForm";
import { TaskRow } from "./TaskRow";
import styles from "./family.module.css";

/**
 * Écran « Tâches » (US-110 RF6 à RF10) : à faire en retard, aujourd'hui, à venir sur 14 jours, « Plus tard » (tâches seules au-delà), et « Faites » sur 30 jours, repliée. Les parents choisissent « Mes tâches » ou
 * « Toutes ». Le serveur ne rend que les tâches que ce profil a le droit de voir (AT-2).
 */
export function TasksScreen() {
  const [mine, setMine] = useState(false);
  const lists = useApiQuery<{ lists: TaskLists }>(`/api/family/tasks${mine ? "?mine=1" : ""}`);
  const data = lists.data?.lists;
  const open = data ? data.overdue.length + data.today.length + data.upcoming.length + data.later.length : 0;

  // Le toucher du rappel quotidien ouvre l'écran sur la section « Aujourd'hui » (US-97 RF5).
  useEffect(() => {
    if (data && window.location.hash === "#aujourdhui") document.getElementById("aujourdhui")?.scrollIntoView({ block: "start" });
  }, [data]);

  return (
    <AppShell title="Tâches" back={{ href: "/assistant", label: "Assistant Famille" }}>
      <Link href="/assistant/taches/nouvelle" className={styles.cta}>
        + Tâche
      </Link>

      {data?.viewer.parent && (
        <div className={s.segments} role="tablist" aria-label="Filtre">
          {[
            { value: false, label: "Toutes" },
            { value: true, label: "Mes tâches" },
          ].map((o) => (
            <button key={o.label} role="tab" aria-selected={mine === o.value} className={`${s.segment} ${mine === o.value ? s.segmentOn : ""}`} onClick={() => setMine(o.value)}>
              {o.label}
            </button>
          ))}
        </div>
      )}

      {lists.error && <RetryNotice message={lists.error.kind === "server" ? "Les tâches n'ont pas pu être chargées." : lists.error.message} onRetry={lists.reload} />}
      {lists.loading && !data && <Loading slow={lists.slow} label="Chargement des tâches…" />}

      {data && open === 0 && (
        <div className={s.empty}>
          <p className={s.text}>Rien à faire pour le moment.</p>
          <Link href="/assistant/taches/nouvelle" className={styles.link}>
            + Tâche ›
          </Link>
        </div>
      )}

      {data && (
        <>
          <Group title="En retard" tasks={data.overdue} data={data} onChanged={lists.reload} />
          <div id="aujourdhui">
            <Group title="Aujourd'hui" tasks={data.today} data={data} showDate={false} onChanged={lists.reload} />
          </div>
          <Group title="À venir" tasks={data.upcoming} data={data} onChanged={lists.reload} />
          <Group title="Plus tard" tasks={data.later} data={data} onChanged={lists.reload} />
          {data.done.length > 0 && (
            <details className={styles.removedBox}>
              <summary>Faites ({data.done.length})</summary>
              <div className={styles.taskList}>
                {data.done.map((t) => (
                  <TaskRow key={t.id} task={t} assignable={data.assignable} onChanged={lists.reload} />
                ))}
              </div>
            </details>
          )}
        </>
      )}
    </AppShell>
  );
}

function Group({ title, tasks, data, showDate = true, onChanged }: { title: string; tasks: TaskView[]; data: TaskLists; showDate?: boolean; onChanged: () => void }) {
  if (!tasks.length) return null;
  return (
    <Section title={title}>
      <div className={styles.taskList}>
        {tasks.map((t) => (
          <TaskRow key={t.id} task={t} assignable={data.assignable} showDate={showDate} onChanged={onChanged} />
        ))}
      </div>
    </Section>
  );
}

/** Nouvelle tâche (US-110 RF1, bouton « + Tâche »). Les valeurs d'une carte du tchat peuvent être reprises par l'adresse. */
export function NewTaskScreen() {
  const router = useRouter();
  const lists = useApiQuery<{ lists: TaskLists }>("/api/family/tasks");
  return (
    <AppShell title="Nouvelle tâche" back={{ href: "/assistant/taches", label: "Tâches" }}>
      {lists.error && <RetryNotice message={lists.error.message} onRetry={lists.reload} />}
      {lists.loading && !lists.data && <Loading slow={lists.slow} />}
      {lists.data && <TaskForm assignable={lists.data.lists.assignable} onSaved={() => router.push("/assistant/taches")} onCancel={() => router.push("/assistant/taches")} />}
    </AppShell>
  );
}

/** Détail et modification d'une tâche (US-110 RF5, US-96). */
export function EditTaskScreen({ id }: { id: string }) {
  const router = useRouter();
  const task = useApiQuery<{ task: TaskView }>(`/api/family/tasks/${id}`);
  const lists = useApiQuery<{ lists: TaskLists }>("/api/family/tasks");
  const gone = task.error?.body?.code === "not_found";
  return (
    <AppShell title="Tâche" back={{ href: "/assistant/taches", label: "Tâches" }}>
      {task.loading && !task.data && <Loading slow={task.slow} />}
      {gone && <Notice tone="info">Cette tâche n&apos;existe plus ou ne vous est pas accessible.</Notice>}
      {task.error && !gone && <RetryNotice message={task.error.message} onRetry={task.reload} />}
      {task.data && lists.data && task.data.task.status === "todo" && (
        <TaskForm task={task.data.task} assignable={lists.data.lists.assignable} onSaved={() => router.push("/assistant/taches")} onCancel={() => router.push("/assistant/taches")} onRemoved={() => router.push("/assistant/taches")} />
      )}
      {task.data && task.data.task.status !== "todo" && <Notice tone="info">Cette tâche est {task.data.task.status === "done" ? "déjà faite" : "terminée"}. Décochez-la depuis la liste pour la modifier.</Notice>}
    </AppShell>
  );
}
