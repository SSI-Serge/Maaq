"use client";

import { useId, useState } from "react";
import { useApiQuery, useDebounced } from "@/client/hooks";
import type { AddressSuggestion } from "@/server/assistant/address";
import styles from "./family.module.css";

interface Props {
  value: string;
  maxLength: number;
  disabled?: boolean;
  /** Le texte du lieu a changé à la main : les coordonnées de l'ancienne adresse ne valent plus. */
  onTyped: (text: string) => void;
  /** Une adresse a été choisie dans les suggestions : son texte et ses coordonnées. */
  onPicked: (suggestion: AddressSuggestion) => void;
  /** Les coordonnées du lieu sont connues : le suivi du trajet est possible (US-107 RF4). */
  known: boolean;
}

/**
 * Champ « Adresse » d'un rendez-vous (US-107 RF2, RT2) : pendant la saisie, jusqu'à 5 adresses proposées par la recherche d'adresses de l'État. Choisir une suggestion garde ses coordonnées (chiffrées côté serveur) ;
 * garder le texte tel quel reste possible, mais sans coordonnées le suivi du trajet n'est pas proposé. Si le service ne répond pas, le texte saisi est conservé.
 */
export function AddressField({ value, maxLength, disabled, onTyped, onPicked, known }: Props) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const typed = useDebounced(value.trim(), 350);
  const wanted = open && typed.length >= 3 && typed === value.trim() ? typed : null;
  const query = useApiQuery<{ suggestions: AddressSuggestion[] }>(wanted ? `/api/family/address?q=${encodeURIComponent(wanted)}` : null);
  const suggestions = wanted ? (query.data?.suggestions ?? []) : [];

  return (
    <div>
      <input
        className={styles.input}
        value={value}
        maxLength={maxLength + 50}
        role="combobox"
        aria-expanded={suggestions.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        autoComplete="off"
        placeholder="Numéro, rue, ville"
        onChange={(e) => {
          onTyped(e.target.value);
          setOpen(true);
        }}
        disabled={disabled}
      />
      {suggestions.length > 0 && (
        <div id={listId} className={styles.slots} role="listbox" aria-label="Adresses proposées" style={{ flexDirection: "column", alignItems: "stretch", marginTop: 6 }}>
          {suggestions.map((s) => (
            <button
              key={`${s.label}|${s.lat}|${s.lon}`}
              type="button"
              role="option"
              aria-selected={false}
              className={styles.slot}
              style={{ textAlign: "left" }}
              onClick={() => {
                onPicked(s);
                setOpen(false);
              }}
            >
              {s.label}
            </button>
          ))}
        </div>
      )}
      <div className={styles.hint} style={{ marginTop: 6 }} aria-live="polite">
        {query.error && wanted
          ? "Les suggestions ne sont pas disponibles pour le moment. Le texte saisi est gardé, sans suivi du trajet."
          : wanted && !query.loading && query.data && suggestions.length === 0
            ? "Aucune adresse proposée : le texte saisi est gardé, mais sans adresse choisie le suivi du trajet n'est pas possible."
            : known
              ? "✓ Adresse choisie : le suivi du trajet est possible."
              : value.trim()
                ? "Choisissez une adresse proposée pour pouvoir suivre votre trajet."
                : "Facultatif. Une adresse choisie dans les suggestions permet de suivre votre trajet."}
      </div>
    </div>
  );
}
