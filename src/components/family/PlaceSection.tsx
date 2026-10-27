"use client";

import { useEffect } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { Button, Notice, RetryNotice } from "@/components/ui";
import type { PlaceBlock, PlaceSearchView } from "@/server/assistant/places";
import { shortDate } from "./format";
import styles from "./family.module.css";

const POLL_MS = 3_000;

/** Les trois blocs du résultat (Se garer, Petite faim, Grande faim) avec la date de vérification et l'avertissement : dans le détail du RDV comme dans le tchat (US-112 RF5 à RF7). */
export function PlaceBlocks({ blocks, checkedOn }: { blocks: PlaceBlock[]; checkedOn: string }) {
  return (
    <div>
      {blocks.map((block) => (
        <div key={block.category}>
          <div className={styles.proposalTitle}>{block.label}</div>
          {block.items.map((item) => (
            <div key={`${item.name}|${item.city}`} className={styles.rowValue}>
              {item.name}
              <span className={styles.rowSub}>
                {item.type} · environ {item.walkMinutes} min à pied · {item.city} ·{" "}
                <a href={item.reviewsUrl} target="_blank" rel="noopener noreferrer" className={styles.link}>
                  Voir les avis
                </a>
              </span>
            </div>
          ))}
          {block.note && <div className={styles.hint}>{block.note}</div>}
        </div>
      ))}
      <div className={styles.hint}>Informations trouvées sur internet le {shortDate(checkedOn)} : vérifiez-les avant de partir. MAAQ ne réserve rien.</div>
    </div>
  );
}

/**
 * Section « Sur place » du détail d'un RDV (US-112 RF1, RF4 à RF12) : le bouton « Où se garer, où manger ? », l'état de la recherche, le résultat jusqu'à la fin du RDV, « Actualiser »
 * et le compteur « Recherches : N sur 3 ». Absente pour un RDV médical, sans lieu, terminé, ou quand le service de recherche n'est pas ouvert. Aucune note ni avis : « Voir les avis »
 * mène à la fiche de l'établissement, où l'on consulte soi-même les notes. MAAQ ne réserve rien et n'agit jamais sur le RDV.
 */
export function PlaceSection({ eventId }: { eventId: string }) {
  const query = useApiQuery<{ place: PlaceSearchView | null }>(`/api/family/events/${eventId}/place`);
  const launch = useApiMutation();
  const view = query.data?.place ?? null;
  const running = view?.latest?.status === "queued" || view?.latest?.status === "running";
  const { reload } = query;

  // Tant que la recherche est en cours, l'écran se met à jour tout seul (en général moins d'une minute).
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(reload, POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, reload]);

  async function start() {
    const result = await launch.run(`/api/family/events/${eventId}/place`, { method: "POST" });
    if (result !== undefined) reload();
  }
  const started = launch.pending === false && launch.error === undefined && Boolean(running);

  if (!view || !view.available) return null;
  const atLimit = view.searches >= view.max;
  const latest = view.latest;
  const results = view.results;
  const error = launch.error;
  const label = running || launch.pending ? "Recherche en cours…" : latest?.status === "failed" ? "Réessayer" : results ? "Actualiser" : "Où se garer, où manger ?";

  return (
    <div className={styles.settingRow} id="sur-place" role="group" aria-label="Sur place">
      <div className={styles.settingType}>Sur place</div>

      {running && <div className={styles.hint}>Je cherche où se garer et où manger près de {results?.place ?? "ce lieu"}…</div>}
      {latest?.status === "failed" && <Notice tone="error">La recherche n&apos;a pas abouti. Réessayez plus tard.</Notice>}
      {latest?.status === "no_result" && <Notice tone="info">Je n&apos;ai pas trouvé d&apos;informations fiables près de {results?.place ?? "ce lieu"}.</Notice>}

      {results && results.blocks.length > 0 && (
        <div>
          <PlaceBlocks blocks={results.blocks} checkedOn={results.checkedOn} />
          <div className={styles.hint}>Affiché jusqu&apos;à la fin du RDV.</div>
        </div>
      )}

      <Button variant="secondary" onClick={() => void start()} loading={launch.pending || running} disabled={launch.pending || running || atLimit}>
        {label}
      </Button>
      {started && <div className={styles.hint}>✓ Recherche lancée : le résultat arrivera dans le tchat et dans le détail du RDV.</div>}
      <div className={styles.hint}>Recherches : {view.searches} sur {view.max}</div>
      {atLimit && <Notice tone="info">Nombre maximal de recherches pour ce RDV atteint ({view.max}).</Notice>}
      {launch.error && launch.error.kind !== "rejected" && <RetryNotice message={error?.kind === "server" ? "La recherche n'a pas pu être lancée." : (error?.message ?? "")} onRetry={() => void start()} />}
      {launch.error && launch.error.kind === "rejected" && <Notice tone="error">{launch.error.message}</Notice>}
      {launch.slow && <Notice tone="info">Toujours en cours…</Notice>}
    </div>
  );
}
