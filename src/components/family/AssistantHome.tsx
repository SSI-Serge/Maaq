"use client";

import Link from "next/link";
import { useApiQuery } from "@/client/hooks";
import { AppShell, Section } from "@/components/app/AppShell";
import { Loading, RetryNotice } from "@/components/ui";
import type { EventView } from "@/server/assistant/events";
import { clock, dayOf, shortDate } from "./format";
import { Dots } from "./parts";
import styles from "./family.module.css";

function Item({ event }: { event: EventView }) {
  return (
    <Link href={`/calendrier/rdv/${event.id}`} className={`${styles.listItem} ${event.status === "provisional" ? styles.listItemDashed : ""}`}>
      <span className={styles.listDate}>
        {shortDate(dayOf(event.start))}
        <br />
        {event.allDay ? "Journée" : clock(event.start)}
      </span>
      <Dots members={event.members} />
      <span className={styles.listBody}>{event.title}</span>
      <span className={styles.chevron} aria-hidden>
        ›
      </span>
    </Link>
  );
}

/**
 * Accueil de l'Assistant Famille : confirmations en attente (avec leur compteur), prochains rendez-vous, bouton « Nouvelle demande ».
 * Un RDV déjà traité par l'autre parent n'est plus dans les confirmations en attente (D28).
 */
export function AssistantHome() {
  const pending = useApiQuery<{ events: EventView[] }>("/api/family/events/pending");
  const upcoming = useApiQuery<{ events: EventView[] }>("/api/assistant/upcoming");
  const waiting = pending.data?.events ?? [];

  return (
    <AppShell title="Assistant Famille" subtitle="Vous transmettez l'information, l'assistant range le rendez-vous et vous demande de confirmer.">
      <Link href="/assistant/demande" className={styles.cta}>
        + Nouvelle demande
      </Link>

      <div style={{ display: "flex", gap: 16 }}>
        <Link href="/assistant/membres" className={styles.link}>
          Membres de la famille ›
        </Link>
        <Link href="/assistant/reglages" className={styles.link}>
          Réglages ›
        </Link>
      </div>

      <Section
        title="Confirmations en attente"
        action={waiting.length > 0 ? <span className={styles.badge} aria-label={`${waiting.length} en attente`}>{waiting.length}</span> : undefined}
      >
        {pending.loading && !pending.data && <Loading slow={pending.slow} />}
        {pending.error && <RetryNotice message={pending.error.message} onRetry={pending.reload} />}
        {pending.data && waiting.length === 0 && <div className={styles.nothing}>Rien à confirmer pour le moment.</div>}
        {waiting.map((e) => (
          <Item key={e.id} event={e} />
        ))}
      </Section>

      <Section title="Prochains rendez-vous" action={<Link href="/calendrier" className={styles.link}>Calendrier ›</Link>}>
        {upcoming.loading && !upcoming.data && <Loading slow={upcoming.slow} />}
        {upcoming.error && <RetryNotice message={upcoming.error.message} onRetry={upcoming.reload} />}
        {upcoming.data && upcoming.data.events.length === 0 && <div className={styles.nothing}>Aucun rendez-vous à venir.</div>}
        {upcoming.data?.events.slice(0, 5).map((e) => (
          <Item key={e.id} event={e} />
        ))}
      </Section>
    </AppShell>
  );
}
