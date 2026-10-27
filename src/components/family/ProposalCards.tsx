"use client";

import Link from "next/link";
import { useState } from "react";
import { pendingChanged } from "@/client/badge";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { Button, Loading, Notice } from "@/components/ui";
import type { EventView } from "@/server/assistant/events";
import type { TaskDraftView } from "@/server/assistant/service";
import type { MemberChip } from "@/server/assistant/member-chips";
import type { TaskView } from "@/server/assistant/tasks";
import { clock, dayOf, longDate, shortDate, whenLabel } from "./format";
import { MemberChips } from "./parts";
import { PrepareList } from "./PrepareList";
import { TaskForm, type TaskFormInitial } from "./TaskForm";
import styles from "./family.module.css";

/**
 * Carte de proposition d'un RDV dans le tchat (US-95 RF3, RF4) : résumé, liste « À préparer » ajustable, bouton « Confirmer le RDV et N tâches » et lien « Confirmer sans
 * les tâches ». Un conflit, ou toute autre décision à prendre, renvoie vers l'écran de confirmation. Si la liste a changé ailleurs, la confirmation est refusée et la carte
 * se recharge avec « Mis à jour » (RF5, D51).
 */
export function EventProposalCard({ eventId }: { eventId: string }) {
  const detail = useApiQuery<{ event: EventView }>(`/api/family/events/${eventId}`);
  const mutation = useApiMutation();
  const [override, setOverride] = useState<EventView | null>(null);
  const [updated, setUpdated] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const event = override ?? detail.data?.event;

  if (!event) {
    return (
      <div className={styles.proposalCard}>
        {detail.loading && <Loading slow={detail.slow} label="Chargement de la proposition…" />}
        {detail.error && (
          <Link href={`/calendrier/rdv/${eventId}`} className={styles.bubbleLink}>
            Voir la proposition de RDV ›
          </Link>
        )}
      </div>
    );
  }

  const provisional = event.status === "provisional";
  const proposed = event.tasks?.items.filter((t) => t.status === "proposed").length ?? 0;
  const code = mutation.error?.body?.code;
  const details = code === "conflict" ? (mutation.error?.body?.details as { sessions?: string[] } | undefined) : undefined;

  function reload() {
    setOverride(null);
    setUpdated(true);
    mutation.reset();
    detail.reload();
  }

  async function confirm(withoutTasks: boolean) {
    if (!event) return;
    const result = await mutation.run<{ event: EventView }>(`/api/family/events/${event.id}/confirm`, { method: "POST", body: { version: event.version, ...(withoutTasks ? { withoutTasks: true } : {}) } });
    if (!result) return;
    setOverride(result.event);
    setConfirmed(true);
    pendingChanged();
  }

  return (
    <div className={styles.proposalCard}>
      <div className={styles.proposalTitle}>{event.title}</div>
      <div className={styles.hint}>
        {longDate(dayOf(event.start))} · {whenLabel(event)}
        {event.series && ` · ↻ ${event.series.rule}`}
      </div>
      <MemberChips members={event.members} allFamily={event.allFamily} />

      {updated && <Notice tone="info">Mis à jour.</Notice>}
      {confirmed && (
        <div className={`${styles.alert} ${styles.alertSuccess}`} role="status">
          ✓ Rendez-vous ajouté à votre calendrier familial{proposed > 0 || (event.tasks?.items.length ?? 0) > 0 ? `, avec ${event.tasks?.items.length ?? 0} tâche${(event.tasks?.items.length ?? 0) > 1 ? "s" : ""}` : ""}
        </div>
      )}

      {provisional && event.tasks && <PrepareList event={event} onUpdated={(e) => { setOverride(e); setUpdated(false); }} onStale={reload} disabled={mutation.pending} />}

      {provisional && event.can.confirm && (
        <>
          <Button block onClick={() => void confirm(false)} loading={mutation.pending} disabled={mutation.pending}>
            {mutation.pending ? "Confirmation…" : proposed > 0 ? `Confirmer le RDV et ${proposed} tâche${proposed > 1 ? "s" : ""}` : "Confirmer le RDV"}
          </Button>
          {proposed > 0 && (
            <button type="button" className={styles.link} onClick={() => void confirm(true)} disabled={mutation.pending}>
              Confirmer sans les tâches
            </button>
          )}
          {/* Sous le bouton : le RDV sera-t-il ajouté sans réponse, ou jamais (AT-8, US-95 UX) */}
          {event.autoConfirm && (
            <span className={styles.source}>
              {"at" in event.autoConfirm
                ? `Sans réponse de votre part, ce RDV${proposed > 0 ? " et ses tâches" : ""} sera ajouté à votre calendrier le ${shortDate(dayOf(event.autoConfirm.at))} à ${clock(event.autoConfirm.at)}.`
                : "Ce RDV ne sera jamais ajouté sans votre confirmation."}
            </span>
          )}
        </>
      )}

      {mutation.error && code === "conflict" && (
        <Notice tone="warning">{details?.sessions?.length ? "Des séances chevauchent un autre rendez-vous." : "Ce créneau chevauche un autre rendez-vous."} Ouvrez le détail pour choisir un autre horaire ou le garder.</Notice>
      )}
      {mutation.error && code === "stale_version" && (
        <Notice tone="info">
          La liste a changé depuis l&apos;affichage de cette carte.{" "}
          <button type="button" className={styles.undo} onClick={reload}>
            Afficher la dernière version
          </button>
        </Notice>
      )}
      {mutation.error && code !== "conflict" && code !== "stale_version" && <Notice tone="error">{mutation.error.kind === "rejected" ? mutation.error.message : "Le rendez-vous n'a pas pu être confirmé. Vos ajustements sont conservés : réessayez."}</Notice>}

      <Link href={`/calendrier/rdv/${event.id}`} className={styles.bubbleLink}>
        {provisional ? "Voir la proposition de RDV ›" : "Voir le détail ›"}
      </Link>
    </div>
  );
}

/** Texte de la carte « Tâche proposée : Payer la cantine — avant le 5/11 » (US-110 CA 1.1). */
function draftLine(draft: TaskDraftView): string {
  const day = `${draft.due.slice(8, 10)}/${draft.due.slice(5, 7)}`;
  return `${draft.title} — ${draft.rule ? `${draft.rule.charAt(0).toLowerCase()}${draft.rule.slice(1)}, dès le ${day}` : `avant le ${day}`}${draft.dueTime ? ` à ${clock(`0000-00-00T${draft.dueTime}`)}` : ""}`;
}

/**
 * Carte « Tâche proposée » (US-110 RF1) : « Ajouter » enregistre la tâche, « Modifier » ouvre le formulaire avec les valeurs proposées. Rien n'est enregistré sans ce geste
 * (AF-4). La proposition n'est pas conservée par le serveur : elle disparaît quand la conversation est rechargée.
 */
export function TaskDraftCard({ draft, assignable }: { draft: TaskDraftView; assignable: MemberChip[] }) {
  const mutation = useApiMutation();
  const [added, setAdded] = useState<TaskView | null>(null);
  const [editing, setEditing] = useState(false);

  const initial: TaskFormInitial = { title: draft.title, due: draft.due, dueTime: draft.dueTime, assigneeId: draft.assignee?.id ?? null, repetition: draft.repetition };

  async function add() {
    const result = await mutation.run<{ task: TaskView }>("/api/family/tasks", {
      method: "POST",
      body: { title: draft.title, due: draft.due, dueTime: draft.dueTime, assigneeId: draft.assignee?.id ?? null, ...(draft.repetition ? { repetition: draft.repetition } : {}) },
    });
    if (result) setAdded(result.task);
  }

  if (added) {
    return (
      <div className={`${styles.alert} ${styles.alertSuccess}`} role="status">
        ✓ Tâche ajoutée.{" "}
        <Link href="/assistant/taches" className={styles.link}>
          Voir les tâches ›
        </Link>
      </div>
    );
  }
  if (editing) {
    return (
      <div className={styles.proposalCard}>
        <TaskForm initial={initial} assignable={assignable} onSaved={setAdded} onCancel={() => setEditing(false)} />
      </div>
    );
  }
  return (
    <div className={styles.proposalCard}>
      <div className={styles.proposalTitle}>Tâche proposée : {draftLine(draft)}</div>
      {draft.assignee && <div className={styles.hint}>Pour {draft.assignee.firstName}</div>}
      <div className={styles.actionsRow}>
        <Button variant="secondary" onClick={() => setEditing(true)} disabled={mutation.pending}>
          Modifier
        </Button>
        <Button onClick={() => void add()} loading={mutation.pending} disabled={mutation.pending}>
          Ajouter
        </Button>
      </div>
      {mutation.error && <Notice tone="error">{mutation.error.kind === "rejected" ? mutation.error.message : "La tâche n'a pas pu être ajoutée. Réessayez."}</Notice>}
    </div>
  );
}
