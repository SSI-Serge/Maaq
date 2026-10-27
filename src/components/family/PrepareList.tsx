"use client";

import { useState } from "react";
import { useApiMutation } from "@/client/hooks";
import { Button, Notice } from "@/components/ui";
import type { EventTaskView } from "@/server/assistant/event-tasks";
import type { EventView } from "@/server/assistant/events";
import { addDays, dayOf, shortDate, todayLocal } from "./format";
import { AssigneePicker } from "./TaskForm";
import styles from "./family.module.css";

/** Échéances relatives proposées (validées par le PO, 26/10/2026) ; « Autre date… » est une date entre aujourd'hui et le jour du RDV (US-95 RF3). */
const RELATIVE = [
  { days: 0, label: "Le jour même" },
  { days: 1, label: "La veille" },
  { days: 2, label: "2 jours avant" },
  { days: 3, label: "3 jours avant" },
  { days: 7, label: "1 semaine avant" },
];
const OTHER = "other";
const MAX_TITLE = 100;

interface Draft {
  title: string;
  /** Écart en jours (chaîne du sélecteur) ou « other » pour une date choisie. */
  when: string;
  date: string;
  assigneeId: string | null;
}

interface Removed {
  title: string;
  daysBefore: number | null;
  due: string | null;
  assigneeId: string | null;
}

interface Props {
  event: EventView;
  /** Le RDV à jour après chaque changement de la liste (sa version a changé, US-95 RF5). */
  onUpdated: (event: EventView) => void;
  /** Rechargement complet quand la liste a été modifiée ailleurs. */
  onStale?: () => void;
  disabled?: boolean;
}

/**
 * Liste « À préparer » d'un RDV (US-95 RF3, RF8, RF11, RF14) : retirer une tâche avec la croix, la modifier (titre, échéance relative au RDV, personne) ou ajouter une
 * tâche avec « + Tâche ». Les échéances déjà passées sont grisées (RF3 bis). Pour une série, les tâches valent pour chaque séance (RF12). Le même composant sert dans la
 * carte du tchat et sur l'écran du RDV : les ajustements se retrouvent des deux côtés, puisqu'ils sont enregistrés tout de suite.
 */
export function PrepareList({ event, onUpdated, onStale, disabled }: Props) {
  const tasks = event.tasks;
  const mutation = useApiMutation();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>({ title: "", when: "1", date: "", assigneeId: null });
  const [removed, setRemoved] = useState<Removed[]>([]);
  if (!tasks) return null;

  const eventDay = dayOf(event.start);
  const today = todayLocal();
  const earliest = today > eventDay ? eventDay : today;
  const base = `/api/family/events/${event.id}/tasks`;
  const busy = mutation.pending || Boolean(disabled);
  const visible = tasks.items;

  const open = (item?: EventTaskView) => {
    setEditing(item ? item.id : "new");
    setDraft({
      title: item?.title ?? "",
      when: item ? (item.daysBefore !== null ? String(item.daysBefore) : OTHER) : "1",
      date: item?.due ?? "",
      assigneeId: item?.assignee?.id ?? null,
    });
    mutation.reset();
  };

  const payload = (): Record<string, unknown> => ({
    title: draft.title.trim(),
    assigneeId: draft.assigneeId,
    ...(draft.when === OTHER ? { due: draft.date } : { daysBefore: Number(draft.when) }),
  });

  async function save() {
    const result =
      editing === "new"
        ? await mutation.run<{ event: EventView }>(base, { method: "POST", body: payload() })
        : await mutation.run<{ event: EventView }>(`${base}/${editing}`, { method: "PATCH", body: payload() });
    if (!result) return;
    setEditing(null);
    onUpdated(result.event);
  }

  async function remove(item: EventTaskView) {
    const result = await mutation.run<{ event: EventView }>(`${base}/${item.id}`, { method: "DELETE" });
    if (!result) return;
    // Mémorisé pour « Rétablir les tâches retirées » (US-95 UX) : une tâche proposée supprimée n'existe plus côté serveur.
    if (item.status === "proposed") setRemoved((cur) => [...cur, { title: item.title, daysBefore: item.daysBefore, due: item.due, assigneeId: item.assignee?.id ?? null }]);
    onUpdated(result.event);
  }

  async function restore() {
    let latest: EventView | undefined;
    for (const r of removed) {
      const result = await mutation.run<{ event: EventView }>(base, { method: "POST", body: { title: r.title, assigneeId: r.assigneeId, ...(r.daysBefore !== null ? { daysBefore: r.daysBefore } : { due: r.due }) } });
      if (!result) break;
      latest = result.event;
    }
    setRemoved([]);
    if (latest) onUpdated(latest);
  }

  const valid = draft.title.trim().length > 0 && draft.title.length <= MAX_TITLE && (draft.when !== OTHER || (draft.date >= earliest && draft.date <= eventDay && draft.date !== ""));
  const calculated = draft.when === OTHER ? draft.date : addDays(eventDay, -Number(draft.when));
  const code = mutation.error?.body?.code;
  const heading = tasks.perSession ? "À préparer à chaque séance" : "À préparer";

  return (
    <section className={styles.prepare} aria-label={heading}>
      <div className={styles.label}>{heading}</div>
      {visible.length === 0 && editing !== "new" && <span className={styles.hint}>{event.status === "confirmed" ? "Aucune tâche pour ce rendez-vous." : "Aucune tâche proposée"}</span>}

      {visible.map((item) =>
        editing === item.id ? (
          renderEditor(item.id)
        ) : (
          <div key={item.id} className={styles.prepareItem}>
            <div className={styles.prepareBody}>
              <span>{item.title}</span>
              <span className={styles.hint}>
                {[item.relative, tasks.perSession ? "à chaque séance" : item.due ? shortDate(item.due) : null, item.assignee?.firstName ?? null, item.status === "done" ? "Faite" : null].filter(Boolean).join(" · ")}
              </span>
            </div>
            {tasks.editable && item.status !== "done" && (
              <>
                <button type="button" className={styles.iconText} onClick={() => open(item)} disabled={busy} aria-label={`Modifier : ${item.title}`}>
                  Modifier
                </button>
                <button type="button" className={styles.iconText} onClick={() => void remove(item)} disabled={busy} aria-label={`Retirer : ${item.title}`}>
                  ✕
                </button>
              </>
            )}
          </div>
        ),
      )}

      {editing === "new" && renderEditor("new")}

      {tasks.editable && editing === null && (
        <div className={styles.actionsRow}>
          <Button variant="secondary" onClick={() => open()} disabled={busy || tasks.reached}>
            + Tâche
          </Button>
          {removed.length > 0 && (
            <button type="button" className={styles.link} onClick={() => void restore()} disabled={busy || tasks.reached}>
              Rétablir les tâches retirées ›
            </button>
          )}
        </div>
      )}
      {tasks.reached && tasks.editable && <span className={styles.hint}>Nombre maximal de tâches pour ce RDV atteint ({tasks.limit}).</span>}

      {mutation.error && code === "stale_version" && (
        <Notice tone="info">
          Mis à jour.{" "}
          <button type="button" className={styles.undo} onClick={onStale}>
            Afficher la dernière version
          </button>
        </Notice>
      )}
      {mutation.error && code !== "stale_version" && <Notice tone="error">{mutation.error.kind === "rejected" ? mutation.error.message : "La liste n'a pas pu être enregistrée. Vos ajustements sont conservés : réessayez."}</Notice>}
    </section>
  );

  // Une fonction et non un composant : le champ garde le focus pendant la frappe.
  function renderEditor(key: string) {
    return (
      <div key={key} className={styles.prepareEditor}>
        <input className={styles.input} value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} maxLength={MAX_TITLE + 20} placeholder="Acheter un cadeau" aria-label="Titre de la tâche" disabled={busy} />
        <select className={styles.select} value={draft.when} onChange={(e) => setDraft({ ...draft, when: e.target.value })} aria-label="Échéance" disabled={busy}>
          {RELATIVE.map((r) => (
            <option key={r.days} value={String(r.days)} disabled={addDays(eventDay, -r.days) < today}>
              {r.label}
            </option>
          ))}
          {!tasks!.perSession && <option value={OTHER}>Autre date…</option>}
        </select>
        {draft.when === OTHER && <input type="date" className={styles.input} min={earliest} max={eventDay} value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })} aria-label="Date d'échéance" disabled={busy} />}
        {!tasks!.perSession && valid && <span className={styles.hint}>À faire au plus tard le {shortDate(calculated)}.</span>}
        <span className={styles.hint}>Les échéances déjà passées sont grisées. L&apos;échéance est comptée à partir du RDV : s&apos;il est déplacé, elle suit.</span>
        <AssigneePicker members={tasks!.assignable} value={draft.assigneeId} onChange={(id) => setDraft({ ...draft, assigneeId: id })} disabled={busy} />
        <div className={styles.actionsRow}>
          <Button variant="ghost" onClick={() => setEditing(null)} disabled={busy}>
            Annuler
          </Button>
          <Button onClick={() => void save()} loading={mutation.pending} disabled={!valid || busy}>
            Enregistrer
          </Button>
        </div>
      </div>
    );
  }
}
