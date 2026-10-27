"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useApiQuery } from "@/client/hooks";
import { remindersSeen, usePush } from "@/client/push";
import { AppShell, Section } from "@/components/app/AppShell";
import { Loading, RetryNotice } from "@/components/ui";
import type { AnticipationView } from "@/server/assistant/anticipation";
import type { EventView } from "@/server/assistant/events";
import { clock, dayOf, shortDate } from "./format";
import { Dots } from "./parts";
import { AnticipationCards } from "./QuestionCards";
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
  // Réservé aux parents (US-102 RF8) : un profil sans ce droit n'a pas la section.
  const anticipation = useApiQuery<{ anticipation: AnticipationView }>("/api/family/anticipation");
  const toAnticipate = anticipation.data?.anticipation;
  const waiting = pending.data?.events ?? [];
  const router = useRouter();
  const { state: push } = usePush();

  // Première ouverture sur un appareil qui peut recevoir des notifications : l'écran d'activation s'ouvre (US-94 RF1). Il ne se représente pas
  // ensuite ; un bandeau prend le relais tant que les rappels ne sont pas activés (RF6).
  useEffect(() => {
    if ((push === "ready" || push === "ios_install" || push === "ios_too_old") && !remindersSeen()) router.replace("/assistant/rappels");
  }, [push, router]);
  const reminderBanner = (push === "ready" || push === "ios_install") && remindersSeen();

  return (
    <AppShell title="Assistant Famille" subtitle="Vous transmettez l'information, l'assistant range le rendez-vous et vous demande de confirmer.">
      <Link href="/assistant/demande" className={styles.cta}>
        + Nouvelle demande
      </Link>

      {reminderBanner && (
        <Link href="/assistant/rappels" className={styles.banner}>
          Activez vos rappels pour être prévenu à temps ›
        </Link>
      )}
      <div style={{ display: "flex", gap: 16 }}>
        <Link href="/assistant/taches/nouvelle" className={styles.link}>
          + Tâche
        </Link>
        <Link href="/assistant/taches" className={styles.link}>
          Tâches ›
        </Link>
        <Link href="/assistant/semaine" className={styles.link}>
          Point de la semaine ›
        </Link>
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

      {toAnticipate && toAnticipate.enabled && (toAnticipate.questions.length > 0 || toAnticipate.birthCards.length > 0) && (
        <div id="anticiper">
          <Section title="À anticiper">
            <AnticipationCards data={toAnticipate} onChanged={anticipation.reload} />
          </Section>
        </div>
      )}

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
