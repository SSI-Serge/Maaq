"use client";

import { detectPlatform } from "@/client/auth";
import { mapsUrl } from "@/client/maps";

/** « Ouvrir dans Plans/Maps » : ouvre l'itinéraire vers ce lieu dans l'application de cartes du téléphone (Plans sur iPhone, Google Maps ailleurs). Rien n'est envoyé par MAAQ. */
export function MapsButton({ destination, label = "Ouvrir dans Plans/Maps" }: { destination: string; label?: string }) {
  return (
    <a
      href={mapsUrl(destination, detectPlatform())}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${label} : ${destination}`}
      style={{ display: "inline-flex", alignItems: "center", minHeight: 36, marginTop: 6, padding: "0 12px", border: "1px solid var(--line)", borderRadius: 8, background: "transparent", color: "var(--primary)", fontSize: 13, fontWeight: 700, textDecoration: "none" }}
    >
      {label}
    </a>
  );
}
