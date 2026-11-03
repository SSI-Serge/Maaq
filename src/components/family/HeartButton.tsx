"use client";

import { useApiMutation } from "@/client/hooks";
import type { HeartView } from "@/server/emotions/hearts";
import styles from "./emotions.module.css";

/**
 * Le cœur de remerciement (US-141), sur une tâche faite ou un RDV passé : vide quand on peut le poser, plein une fois posé, un second appui le retire. Pour la personne remerciée,
 * une mention « Julien vous remercie ». Aucune notification n'est envoyée ; rien n'est affiché hors du couple (le serveur ne renvoie pas de cœur). `onChanged` relit l'élément.
 */
export function HeartButton({ target, heart, partner, onChanged }: { target: { kind: "task" | "event"; id: string }; heart: HeartView; partner?: string; onChanged: () => void }) {
  const mutation = useApiMutation();
  const name = partner ?? "votre partenaire";

  async function toggle() {
    const result = await mutation.run<{ heart: HeartView }>("/api/family/hearts", { method: "POST", body: { kind: target.kind, id: target.id, on: !heart.given } });
    if (result) onChanged();
  }

  if (heart.thanksFrom) return <span className={styles.thanks}>♥ {heart.thanksFrom} vous remercie</span>;
  if (!heart.canGive) return null;
  return (
    <button type="button" className={styles.heartBtn} aria-pressed={heart.given} aria-label={heart.given ? "Retirer le cœur" : `Remercier ${name} d'un cœur`} disabled={mutation.pending} onClick={() => void toggle()}>
      {heart.given ? "♥" : "♡"}
    </button>
  );
}

/** Le cœur sur le détail d'un RDV passé (US-141 RF2, RF3) : le texte dit où le cœur sera vu, sans notification. */
export function EventHeart({ eventId, heart, creator, onChanged }: { eventId: string; heart: HeartView; creator: string | null; onChanged: () => void }) {
  if (!heart.canGive && !heart.thanksFrom) return null;
  const text = heart.thanksFrom
    ? `RDV passé · ♥ ${heart.thanksFrom} vous remercie`
    : heart.given
      ? `Merci posé. ${creator ?? "Votre partenaire"} le verra ici et dans son bilan, sans notification.`
      : `RDV passé, créé par ${creator ?? "votre partenaire"}. Le remercier ?`;
  return (
    <div className={styles.heartLine}>
      <span>{text}</span>
      <HeartButton target={{ kind: "event", id: eventId }} heart={{ ...heart, thanksFrom: null }} partner={creator ?? undefined} onChanged={onChanged} />
    </div>
  );
}
