"use client";

import Link from "next/link";
import { useState } from "react";
import { useApiMutation } from "@/client/hooks";
import { readPhonePosition } from "@/client/phone-position";
import { Notice, RetryNotice } from "@/components/ui";
import type { EventView } from "@/server/assistant/events";
import type { LocationConsentView } from "@/server/assistant/location-consent";
import { durationLabel } from "@/server/assistant/travel-format";
import styles from "./family.module.css";

interface Props {
  event: EventView;
  /** Le profil connecté a autorisé la position sur cet appareil : alors la position est lue à l'activation, pour estimer la durée du trajet (US-107 RF5). */
  consent: LocationConsentView["status"] | null;
  onChanged: () => void;
  onEditAddress: () => void;
}

/**
 * « Suivre mon trajet » (US-107 RF4, CA 4.1 à 4.3) : un interrupteur propre à ce profil, sur ce RDV ou sur toute sa série. Désactivé avec l'invitation à choisir l'adresse quand les
 * coordonnées du lieu ne sont pas connues ; absent pour un RDV médical et quand le suivi du trajet n'est pas ouvert.
 */
export function TravelSection({ event, consent, onChanged, onEditAddress }: Props) {
  const mutation = useApiMutation();
  const [scope, setScope] = useState<"event" | "series">("event");
  const travel = event.travel;
  if (!travel || event.past || travel.unavailable === "medical" || travel.unavailable === "not_concerned" || travel.unavailable === "past") return null;
  const series = event.recurring;

  async function change(enable: boolean) {
    const target = scope;
    const url = `/api/family/events/${event.id}/tracking${!enable && target === "series" ? "?scope=series" : ""}`;
    if (enable) {
      // Position lue à l'activation seulement si l'appareil l'a autorisée : le téléphone peut alors demander son propre accord (RF11).
      const read = consent === "active" ? await readPhonePosition() : null;
      const result = await mutation.run(url, { method: "PUT", body: { scope: target, ...(read?.ok ? { position: read.position } : {}) } });
      if (result !== undefined) onChanged();
    } else {
      const result = await mutation.run(url, { method: "DELETE" });
      if (result !== undefined) onChanged();
    }
  }

  const label = "Suivre mon trajet";
  const disabled = !travel.available || mutation.pending;
  return (
    <div className={styles.settingRow} role="group" aria-label={label}>
      <div className={styles.settingType}>{label}</div>
      <div className={styles.switches}>
        <button type="button" role="switch" aria-checked={travel.tracking} aria-busy={mutation.pending} aria-label={label} className={styles.switch} disabled={disabled} onClick={() => void change(!travel.tracking)}>
          {mutation.pending ? "Enregistrement…" : travel.tracking ? "Oui" : "Non"}
        </button>
      </div>
      {series && travel.available && (
        <label className={styles.hint}>
          Pour{" "}
          <select className={styles.select} value={scope} onChange={(e) => setScope(e.target.value as "event" | "series")} disabled={mutation.pending} aria-label="Portée du suivi">
            <option value="event">cette séance</option>
            <option value="series">toutes les séances</option>
          </select>
        </label>
      )}
      {travel.unavailable === "no_address" && (
        <span className={styles.hint}>
          Choisissez l&apos;adresse du RDV pour suivre votre trajet.{" "}
          <button type="button" className={styles.link} onClick={onEditAddress}>
            {event.place ? "Choisir l'adresse" : "Ajouter l'adresse"}
          </button>
        </span>
      )}
      {travel.tracking && (
        <span className={styles.hint}>
          {travel.estimatedMinutes ? `Environ ${durationLabel(travel.estimatedMinutes)} de route. ` : ""}
          {consent !== "active" ? "Sans autorisation de la position, vous recevrez seulement l'appel à ouvrir MAAQ. " : ""}
          <Link href={`/calendrier/rdv/${event.id}/trajet`} className={styles.link}>
            Ouvrir le suivi du trajet
          </Link>
        </span>
      )}
      {mutation.error &&
        (mutation.error.kind === "rejected" ? (
          <Notice tone="error">{mutation.error.message}</Notice>
        ) : (
          <RetryNotice message={mutation.error.kind === "server" ? "Le suivi du trajet n'a pas pu être enregistré." : mutation.error.message} onRetry={() => void change(!travel.tracking)} />
        ))}
    </div>
  );
}
