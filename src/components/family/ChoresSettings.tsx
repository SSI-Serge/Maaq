"use client";

import Link from "next/link";
import { useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { Section } from "@/components/app/AppShell";
import { Loading, Notice, RetryNotice } from "@/components/ui";
import type { ChoresSetting, ChoreTaskInput, ChoreTaskSetting } from "@/server/assistant/chores";
import styles from "./family.module.css";

export const CHORE_DAYS = [
  { value: 1, label: "L", name: "lundi" },
  { value: 2, label: "M", name: "mardi" },
  { value: 3, label: "Me", name: "mercredi" },
  { value: 4, label: "J", name: "jeudi" },
  { value: 5, label: "V", name: "vendredi" },
  { value: 6, label: "S", name: "samedi" },
  { value: 7, label: "D", name: "dimanche" },
];

/** « environ 35 min », « environ 1 h », « environ 1 h 30 » */
export function aboutMinutes(minutes: number): string {
  if (minutes < 60) return `environ ${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `environ ${h} h${m ? ` ${String(m).padStart(2, "0")}` : ""}`;
}

/** « 19 h », « 20 h 30 » */
export const clockLabel = (time: string) => {
  const [h, m] = time.split(":");
  return `${Number(h)} h${m && m !== "00" ? ` ${m}` : ""}`;
};

const previousDay = (day: number) => (day === 1 ? 7 : day - 1);

/** La ligne d'une tâche : nom, temps proposé, interrupteur ; une fois activée, jours (ou bacs et heure), personne et lien vers le pas à pas. */
export function ChoreRow({ task, members, canEdit, busy, error, onSave }: { task: ChoreTaskSetting; members: ChoresSetting["members"]; canEdit: boolean; busy: boolean; error: string | null; onSave: (input: ChoreTaskInput) => void }) {
  const locked = !canEdit || busy;
  const [askingDay, setAskingDay] = useState(false);
  const collection = task.mode === "day_before_collection";
  const toggleDay = (day: number) => {
    const on = task.days.includes(day);
    if (on && task.days.length === 1) {
      setAskingDay(true);
      return;
    }
    setAskingDay(false);
    onSave({ enabled: task.enabled, days: on ? task.days.filter((d) => d !== day) : [...task.days, day].sort() });
  };
  return (
    <div className={styles.form} style={{ gap: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <div>
          <div style={{ fontWeight: 700 }}>{task.name}</div>
          <div className={styles.hint}>{aboutMinutes(task.minutes)}</div>
        </div>
        <div className={styles.switches}>
          <button
            type="button"
            role="switch"
            aria-checked={task.enabled}
            aria-label={task.name}
            className={styles.switch}
            disabled={locked || (task.withdrawn && !task.enabled)}
            onClick={() => onSave({ enabled: !task.enabled })}
          />
        </div>
      </div>
      {task.withdrawn && <span className={styles.hint}>Cette tâche n&apos;est plus proposée.</span>}
      {task.enabled && (
        <>
          {!collection && (
            <>
              <div className={styles.label}>Jours</div>
              <div className={styles.members} role="group" aria-label={`Jours : ${task.name}`}>
                {CHORE_DAYS.map((d) => (
                  <button key={d.value} type="button" aria-pressed={task.days.includes(d.value)} aria-label={d.name} className={styles.chipToggle} disabled={locked || task.withdrawn} onClick={() => toggleDay(d.value)}>
                    {d.label}
                  </button>
                ))}
              </div>
              {askingDay && (
                <span className={styles.fieldError} role="alert">
                  Choisissez au moins un jour.
                </span>
              )}
            </>
          )}
          {collection && (
            <>
              <div className={styles.label}>Jour de collecte de chaque bac</div>
              {task.bins.map((b) => (
                <div key={b.binId} style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 13 }}>
                    <span>{b.name}</span>
                    <select
                      className={styles.select}
                      aria-label={`Jour de collecte : ${b.name}`}
                      value={b.collectionDay === null ? "none" : String(b.collectionDay)}
                      disabled={locked || task.withdrawn}
                      onChange={(e) => onSave({ enabled: true, bins: [{ binId: b.binId, collectionDay: e.target.value === "none" ? null : Number(e.target.value) }] })}
                    >
                      <option value="none">Pas de collecte</option>
                      {CHORE_DAYS.map((d) => (
                        <option key={d.value} value={d.value}>
                          {d.name.charAt(0).toUpperCase() + d.name.slice(1)}
                        </option>
                      ))}
                    </select>
                  </label>
                  {b.collectionDay !== null && (
                    <span className={styles.hint}>
                      « {b.taskTitle} » le {CHORE_DAYS[previousDay(b.collectionDay) - 1].name} soir
                    </span>
                  )}
                </div>
              ))}
              <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 13 }}>
                <span>Heure de sortie des bacs</span>
                <input type="time" className={styles.input} style={{ width: 110 }} aria-label="Heure de sortie des bacs" value={task.binTime ?? "19:00"} disabled={locked || task.withdrawn} onChange={(e) => e.target.value && onSave({ enabled: true, binTime: e.target.value })} />
              </label>
              <span className={styles.hint}>La tâche apparaît la veille au soir de chaque collecte, avec le nom du bac : « Sortir le bac jaune ».</span>
            </>
          )}
          <label style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, fontSize: 13 }}>
            <span>Personne</span>
            <select className={styles.select} aria-label={`Personne : ${task.name}`} value={task.memberId ?? ""} disabled={locked || task.withdrawn} onChange={(e) => onSave({ enabled: true, memberId: e.target.value || null })}>
              <option value="">Personne</option>
              {members.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.firstName}
                </option>
              ))}
            </select>
          </label>
          <Link href={`/assistant/taches/menage/${task.taskId}`} className={styles.link}>
            Voir le pas à pas ›
          </Link>
        </>
      )}
      {!task.enabled && (
        <Link href={`/assistant/taches/menage/${task.taskId}`} className={styles.hint} style={{ alignSelf: "flex-start" }}>
          Voir le pas à pas ›
        </Link>
      )}
      {error && (
        <span className={styles.fieldError} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/**
 * Carte « Tâches ménagères guidées » des réglages de l'Assistant Famille (US-181) : les tâches du catalogue, chacune avec son interrupteur, désactivées au départ. Les deux
 * parents règlent, les autres profils lisent. Activer une tâche la met dans l'écran Tâches dès le lendemain.
 */
export function ChoresSettings() {
  const query = useApiQuery<{ setting: ChoresSetting }>("/api/family/chores");
  const save = useApiMutation();
  const [override, setOverride] = useState<ChoresSetting | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const [failed, setFailed] = useState<number | null>(null);
  const setting = override ?? query.data?.setting ?? null;

  async function onSave(task: ChoreTaskSetting, input: ChoreTaskInput) {
    setPending(task.taskId);
    setFailed(null);
    // Une première activation reprend les jours par défaut du catalogue (RF3).
    const body: ChoreTaskInput = { ...input, ...(input.enabled && !task.enabled && task.mode === "weekdays" && !input.days ? { days: task.days } : {}) };
    const result = await save.run<{ setting: ChoresSetting }>(`/api/family/chores/${task.taskId}`, { method: "PUT", body });
    setPending(null);
    if (result) setOverride(result.setting);
    else setFailed(task.taskId);
  }

  return (
    <Section title="Tâches ménagères guidées">
      <p className={styles.hint}>Réglage commun au foyer. Chaque tâche activée revient dans vos tâches les jours choisis, avec son pas à pas, ses conseils et le temps proposé.</p>
      {query.loading && !setting && <Loading slow={query.slow} />}
      {query.error && !setting && <RetryNotice message={query.error.message} onRetry={query.reload} />}
      {setting && !setting.canEdit && <Notice tone="info">Lecture seule — seuls les parents peuvent modifier ce réglage.</Notice>}
      {setting?.tasks.map((t) => (
        <ChoreRow key={t.taskId} task={t} members={setting.members} canEdit={setting.canEdit} busy={pending !== null} error={failed === t.taskId && save.error ? (save.error.kind === "server" ? "Le réglage n'a pas pu être enregistré." : save.error.message) : null} onSave={(input) => void onSave(t, input)} />
      ))}
    </Section>
  );
}
