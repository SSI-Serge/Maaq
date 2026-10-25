"use client";

import Link from "next/link";
import { useApiQuery } from "@/client/hooks";
import { useSessionUser } from "@/components/auth/AuthGate";
import { appStyles as s } from "@/components/app/AppShell";
import styles from "./family.module.css";

/**
 * Tuile de l'Assistant Famille dans le dashboard (US-84 RF6) : le nombre de confirmations en attente, comme sur l'accueil de l'Assistant.
 * L'Assistant n'est pas un agent du catalogue : sa tuile est fixe, en tête du dashboard, et réservée aux deux parents (D33).
 * Si le nombre ne peut pas être chargé, la tuile reste sans compteur et sans message d'erreur (US-84 RF8).
 */
export function FamilyTile() {
  const user = useSessionUser();
  const parent = user.role === "primary_user" || user.guestRank === "core";
  return parent ? <Tile /> : null;
}

function Tile() {
  const pending = useApiQuery<{ events: unknown[] }>("/api/family/events/pending");
  const count = pending.data?.events.length ?? 0;
  return (
    <article className={s.agentCard}>
      <div className={s.cardActions}>
        <div className={s.agentName}>Assistant Famille</div>
        {count > 0 && (
          <span className={styles.badge} aria-label={`${count} confirmation${count > 1 ? "s" : ""} en attente`}>
            {count}
          </span>
        )}
      </div>
      <p className={s.muted}>Les rendez-vous de la famille : vous transmettez l&apos;information, l&apos;assistant la range et vous demande de confirmer.</p>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Link href="/assistant" className={s.smallButton} style={{ background: "var(--primary)", color: "var(--primary-ink)", padding: "7px 12px", borderRadius: 8 }}>
          Ouvrir
        </Link>
        <Link href="/calendrier" className={s.smallButton}>
          Calendrier
        </Link>
      </div>
    </article>
  );
}
