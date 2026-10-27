"use client";

import { useEffect, useRef, useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { readPhonePosition } from "@/client/phone-position";
import { AppShell } from "@/components/app/AppShell";
import { Loading, Notice, RetryNotice } from "@/components/ui";
import type { EventView } from "@/server/assistant/events";
import type { LocationConsentView } from "@/server/assistant/location-consent";
import type { TravelScreenView } from "@/server/assistant/travel";
import { clockFr, durationLabel } from "@/server/assistant/travel-format";
import { LocationConsentExplainer } from "./LocationConsent";
import styles from "./family.module.css";

const REFRESH_MS = 3 * 60_000;

const ORIGIN_LABEL: Record<TravelScreenView["origin"], string> = {
  live_screen: "depuis votre position",
  last_position: "depuis votre dernière position",
  previous_event: "depuis le lieu de votre RDV précédent",
};

/**
 * Écran « Suivi du trajet » (US-107 RF6, RF9, RF13), ouvert par la notification « Ouvrez MAAQ pour suivre votre trajet ». Tant qu'il est ouvert, la position du téléphone est lue et le trajet
 * recalculé avec le trafic toutes les 3 minutes ; le suivi s'arrête si l'on quitte l'application et reprend à la réouverture. Avant la première lecture, l'écran qui explique l'usage de la
 * position s'affiche (CA 11.1) : la demande d'autorisation du téléphone ne vient qu'ensuite.
 */
export function TravelScreen({ id }: { id: string }) {
  const event = useApiQuery<{ event: EventView }>(`/api/family/events/${id}`);
  const consentQuery = useApiQuery<{ consent: LocationConsentView }>("/api/family/location-consent");
  const [granted, setGranted] = useState<LocationConsentView | null>(null);
  const [declined, setDeclined] = useState(false);
  const [view, setView] = useState<{ travel: TravelScreenView; receivedAt: number } | null>(null);
  const [positionIssue, setPositionIssue] = useState<"denied" | "unavailable" | "unsupported" | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const mutation = useApiMutation();
  const consent = granted ?? consentQuery.data?.consent ?? null;
  const active = consent?.status === "active";

  async function refresh() {
    const read = await readPhonePosition();
    setPositionIssue(read.ok ? null : read.reason);
    const result = await mutation.run<{ travel: TravelScreenView }>(`/api/family/events/${id}/travel`, { method: "POST", body: read.ok ? { position: read.position } : {} });
    if (result) setView({ travel: result.travel, receivedAt: Date.now() });
  }
  const latest = useRef(refresh);
  useEffect(() => {
    latest.current = refresh;
  });

  useEffect(() => {
    if (!active) return;
    void latest.current();
    const every = window.setInterval(() => void latest.current(), REFRESH_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    const visible = () => {
      if (document.visibilityState === "visible") void latest.current();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.clearInterval(every);
      window.clearInterval(tick);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [active, id]);

  const e = event.data?.event;
  const t = view?.travel;
  const remaining = t && view ? t.minutesBeforeDeparture - Math.floor((now - view.receivedAt) / 60_000) : null;
  const error = mutation.error;

  return (
    <AppShell title="Suivi du trajet" back={{ href: `/calendrier/rdv/${id}`, label: "Rendez-vous" }} subtitle={e ? <span className={styles.source}>{e.title}</span> : undefined}>
      {(event.loading || consentQuery.loading) && !e && <Loading slow={event.slow} />}
      {event.error && !e && <RetryNotice message={event.error.kind === "server" ? "Ce rendez-vous n'a pas pu être chargé." : event.error.message} onRetry={event.reload} />}
      {e && e.place && <div className={styles.hint}>Vers : {e.place}</div>}

      {consent && !active && !declined && <LocationConsentExplainer consent={consent} onGranted={setGranted} onCancel={() => setDeclined(true)} />}
      {consent && !active && declined && (
        <Notice tone="info">
          Sans l&apos;autorisation de la position, MAAQ ne peut pas suivre votre trajet.{" "}
          <button type="button" className={styles.link} onClick={() => setDeclined(false)}>
            Autoriser la position
          </button>
        </Notice>
      )}

      {active && !t && mutation.pending && <Loading slow={mutation.slow} />}
      {t && (
        <div className={styles.proposalCard} aria-live="polite">
          {t.arrived ? (
            <div className={styles.proposalTitle}>Vous êtes arrivé</div>
          ) : remaining !== null && remaining <= 0 ? (
            <div className={styles.proposalTitle}>Partez maintenant</div>
          ) : (
            <div className={styles.proposalTitle}>Départ conseillé à {clockFr(t.departure)}</div>
          )}
          {!t.arrived && (
            <>
              <div>
                {durationLabel(t.durationMinutes)} de trajet, trafic compris, {ORIGIN_LABEL[t.origin]}.
              </div>
              {remaining !== null && remaining > 0 && <div>Dans {durationLabel(remaining)}</div>}
            </>
          )}
          {t.stale && (
            <Notice tone="info">
              Le calcul du trajet ne répond pas pour le moment. Dernière estimation à {new Date(t.computedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}.
            </Notice>
          )}
        </div>
      )}

      {active && positionIssue === "denied" && <Notice tone="info">Votre téléphone n&apos;a pas donné accès à la position. Autorisez-la dans les réglages du téléphone pour un suivi depuis votre position.</Notice>}
      {active && positionIssue && positionIssue !== "denied" && <Notice tone="info">La position n&apos;a pas pu être lue pour le moment.</Notice>}
      {active && error && error.body?.code !== "no_origin" && <RetryNotice message={error.kind === "rejected" ? error.message : "Le trajet n'a pas pu être calculé."} onRetry={() => void refresh()} />}
      {active && error?.body?.code === "no_origin" && !t && <Notice tone="info">{error.message}</Notice>}

      <div className={styles.hint}>Le suivi s&apos;arrête si vous quittez l&apos;application. Il reprend à la réouverture.</div>
    </AppShell>
  );
}
