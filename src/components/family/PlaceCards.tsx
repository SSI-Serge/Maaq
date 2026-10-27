"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { Button, Notice, RetryNotice } from "@/components/ui";
import type { PlaceMessageView, PlaceSearchDetail } from "@/server/assistant/places";
import { PlaceBlocks } from "./PlaceSection";
import styles from "./family.module.css";

const POLL_MS = 3_000;

/**
 * « Voulez-vous que je cherche où se garer et où manger près de [lieu] ? » (US-112 RF3) : « Oui » lance la recherche, « Non, merci » est mémorisé et la suggestion n'est jamais répétée.
 * Le bouton « Où se garer, où manger ? » du détail du RDV reste disponible dans les deux cas.
 */
export function PlaceSuggestionCard({ place, onAnswered }: { place: PlaceMessageView; onAnswered: () => void }) {
  const mutation = useApiMutation();
  const [chosen, setChosen] = useState<"accepted" | "declined" | null>(null);
  const answer = chosen ?? (place.suggestion && place.suggestion !== "pending" ? place.suggestion : null);

  async function reply(next: "accepted" | "declined") {
    const result = await mutation.run("/api/assistant/place-suggestion", { method: "POST", body: { eventId: place.eventId, answer: next } });
    if (result !== undefined) {
      setChosen(next);
      onAnswered();
    }
  }

  if (!place.eventId) return null;
  return (
    <div className={styles.proposalCard}>
      <div className={styles.proposalTitle}>Voulez-vous que je cherche où se garer et où manger près de {place.place ?? "ce lieu"} ?</div>
      {answer ? (
        <div className={styles.hint}>{answer === "accepted" ? "Oui : la recherche est lancée." : "Non, merci : vous pourrez la lancer depuis le détail du RDV."}</div>
      ) : (
        <div className={styles.actions}>
          <Button onClick={() => void reply("accepted")} loading={mutation.pending} disabled={mutation.pending}>
            Oui
          </Button>
          <Button variant="ghost" onClick={() => void reply("declined")} disabled={mutation.pending}>
            Non, merci
          </Button>
        </div>
      )}
      {mutation.error &&
        (mutation.error.kind === "rejected" ? (
          <Notice tone="info">{mutation.error.message}</Notice>
        ) : (
          <RetryNotice message={mutation.error.kind === "server" ? "La réponse n'a pas pu être enregistrée." : mutation.error.message} onRetry={() => void reply("accepted")} />
        ))}
    </div>
  );
}

/**
 * Message « Sur place » du tchat (US-112 RF4 à RF7, RF10, RF11) : « Je cherche… » pendant la recherche (mise à jour automatique), puis les trois blocs avec la date de vérification
 * et « MAAQ ne réserve rien », ou le message d'absence d'information, ou « La recherche n'a pas abouti » avec « Réessayer ».
 */
export function PlaceResultsCard({ place, onRetried }: { place: PlaceMessageView; onRetried: () => void }) {
  const first = place.search;
  const running = first?.status === "queued" || first?.status === "running";
  const poll = useApiQuery<{ search: PlaceSearchDetail }>(running && first ? `/api/family/place-searches/${first.id}` : null);
  const { reload } = poll;
  const search = poll.data?.search ?? first;
  const live = search?.status === "queued" || search?.status === "running";
  const retry = useApiMutation();

  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(reload, POLL_MS);
    return () => window.clearInterval(timer);
  }, [live, reload]);

  async function again() {
    if (!place.eventId) return;
    const result = await retry.run(`/api/family/events/${place.eventId}/place`, { method: "POST" });
    if (result !== undefined) onRetried();
  }

  const where = place.place ?? search?.place ?? "ce lieu";
  return (
    <div className={styles.proposalCard} role="status">
      {!search && <div className={styles.hint}>Ce résultat n&apos;est plus disponible.</div>}
      {live && <div>Je cherche où se garer et où manger près de {where}…</div>}
      {search?.status === "done" && (
        <>
          <div className={styles.proposalTitle}>Sur place — {where}</div>
          <PlaceBlocks blocks={search.blocks} checkedOn={search.checkedOn ?? ""} />
        </>
      )}
      {search?.status === "no_result" && <div>Je n&apos;ai pas trouvé d&apos;informations fiables près de {where}.</div>}
      {search?.status === "obsolete" && <div className={styles.hint}>L&apos;adresse du RDV a changé : ce résultat n&apos;est plus valable.</div>}
      {search?.status === "failed" && (
        <>
          <div>La recherche n&apos;a pas abouti. Réessayez plus tard.</div>
          {place.eventId && (
            <Button variant="secondary" onClick={() => void again()} loading={retry.pending} disabled={retry.pending}>
              Réessayer
            </Button>
          )}
        </>
      )}
      {retry.error && <Notice tone="info">{retry.error.message}</Notice>}
      {place.eventId && search && !live && (
        <Link href={`/calendrier/rdv/${place.eventId}#sur-place`} className={styles.bubbleLink}>
          Voir le rendez-vous ›
        </Link>
      )}
    </div>
  );
}
