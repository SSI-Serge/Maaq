"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { useApiQuery } from "@/client/hooks";
import { remindersSeen, usePush } from "@/client/push";
import { AppShell, Section } from "@/components/app/AppShell";
import { Loading, RetryNotice } from "@/components/ui";
import type { AnticipationView } from "@/server/assistant/anticipation";
import type { DigestView } from "@/server/assistant/digest";
import type { EventView } from "@/server/assistant/events";
import type { EmotionsHome } from "@/server/emotions/home";
import type { TaskLists } from "@/server/assistant/tasks";
import { clock, dayOf, shortDate } from "./format";
import { OutingHomeCard } from "./OutingsScreens";
import { Dots } from "./parts";
import { AnticipationCards } from "./QuestionCards";
import emo from "./emotions.module.css";
import styles from "./family.module.css";

function Item({ event }: { event: EventView }) {
  const toConfirm = event.status === "provisional";
  return (
    <Link href={`/calendrier/rdv/${event.id}`} className={`${styles.listItem} ${toConfirm ? styles.listItemDashed : ""}`}>
      <span className={styles.listDate}>
        {shortDate(dayOf(event.start))}
        <br />
        {event.allDay ? "Journée" : clock(event.start)}
      </span>
      <Dots members={event.members} />
      <span className={styles.listBody}>{event.title}</span>
      {toConfirm && <span className={styles.statusBadge}>À confirmer</span>}
      <span className={styles.chevron} aria-hidden>
        ›
      </span>
    </Link>
  );
}

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/**
 * Accueil de l'Assistant Famille, allégé (D69) : « Nouvelle demande » et « + Tâche » côte à côte, deux tuiles « Tâches » et « Point de la semaine », Réglages et Carnet en icônes dans
 * l'en-tête, puis la carte privée des sorties, « À venir » (les RDV à confirmer en font partie, avec leur compteur dans l'en-tête) et « À anticiper ». Plus de lien Devoirs ni Membres ici.
 */
export function AssistantHome() {
  const pending = useApiQuery<{ events: EventView[] }>("/api/family/events/pending");
  const upcoming = useApiQuery<{ events: EventView[] }>("/api/assistant/upcoming");
  // Réservé aux parents (US-102 RF8) : un profil sans ce droit n'a pas la section.
  const anticipation = useApiQuery<{ anticipation: AnticipationView }>("/api/family/anticipation");
  const tasks = useApiQuery<{ lists: TaskLists }>("/api/family/tasks");
  const digest = useApiQuery<{ digest: DigestView }>("/api/family/digest");
  // Le couple (utilisateur principal et invité 1) a un bilan, un mot pour son partenaire et « Nos envies » ; les autres profils gardent le point actuel (E-03, E-21).
  const emotions = useApiQuery<EmotionsHome>("/api/family/emotions");
  const couple = emotions.data?.couple ?? null;
  const review = emotions.data?.review ?? null;
  const wishes = emotions.data?.wishes ?? null;
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

  // « À venir » : les RDV à confirmer d'abord retrouvés même au-delà des premiers, puis les prochains, par date.
  const merged = [...waiting, ...(upcoming.data?.events ?? [])].filter((e, i, all) => all.findIndex((x) => x.id === e.id) === i).sort((a, b) => a.start.localeCompare(b.start)).slice(0, 6);

  const lists = tasks.data?.lists;
  const open = lists ? lists.overdue.length + lists.today.length + lists.upcoming.length + lists.later.length : 0;
  const dueToday = lists ? lists.overdue.length + lists.today.length : 0;
  const tasksLine = !lists ? "…" : open === 0 ? "Rien à faire pour le moment" : `${dueToday} aujourd'hui · ${plural(open, "ouverte", "ouvertes")}`;
  const counts = digest.data?.digest.counts;
  const pointLine = !counts ? "…" : `${counts.events} RDV, ${plural(counts.tasks, "tâche", "tâches")}`;
  // Pour le couple, la tuile ouvre le bilan (jamais de chiffre) ; sans bilan encore, elle ouvre le point.
  const reviewLine = !emotions.data ? "…" : review ? (review.opened ? "Votre bilan de la semaine" : "Votre bilan vous attend") : "Pas encore de bilan";

  return (
    <AppShell
      title="Assistant Famille"
      subtitle="RDV & tâches"
      back={{ href: "/accueil", label: "Agents" }}
      action={
        <span className={styles.headerIcons}>
          {waiting.length > 0 && (
            <span className={styles.badge} aria-label={`${waiting.length} en attente de confirmation`}>
              {waiting.length}
            </span>
          )}
          <Link href="/assistant/reglages" aria-label="Réglages de l'Assistant Famille" className={styles.iconLink}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <circle cx="12" cy="12" r="3" />
              <path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
            </svg>
          </Link>
          <Link href="/reglages/carnet" aria-label="Voir le carnet de bord" className={styles.iconLink}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
              <path d="M4 6h16M4 12h16M4 18h10" />
            </svg>
          </Link>
        </span>
      }
    >
      <div className={styles.homeActions}>
        <Link href="/assistant/demande" className={styles.cta}>
          + Nouvelle demande
        </Link>
        <Link href="/assistant/taches/nouvelle" className={styles.cta}>
          + Tâche
        </Link>
      </div>

      {reminderBanner && (
        <Link href="/assistant/rappels" className={styles.banner}>
          Activez vos rappels pour être prévenu à temps ›
        </Link>
      )}

      <div className={styles.homeTiles}>
        <Link href="/assistant/taches" className={styles.homeTile}>
          <span className={styles.homeTileTitle}>Tâches ›</span>
          <span className={styles.hint}>{tasksLine}</span>
        </Link>
        <Link href={couple && review ? "/assistant/bilan" : "/assistant/semaine"} className={styles.homeTile}>
          <span className={styles.homeTileTitle}>{couple ? "Bilan de la semaine ›" : "Point de la semaine ›"}</span>
          <span className={styles.hint}>{couple ? reviewLine : pointLine}</span>
        </Link>
      </div>

      {couple && (
        <div className={emo.homeLinks}>
          <Link href="/assistant/mot" style={{ color: "var(--secondary-strong)" }}>
            ✎ Un mot pour {couple.partner}
          </Link>
          <Link href="/assistant/semaine" style={{ color: "var(--primary)" }}>
            La semaine qui vient ›
          </Link>
        </div>
      )}

      {couple && wishes && (
        <div className={emo.homeCard}>
          <div className={emo.homeCardHead}>
            <span className={emo.kick}>À deux · {couple.partner}</span>
            <Link href={wishes.full ? "/assistant/envies" : "/assistant/envies/nouvelle"} aria-label="Ajouter une envie" className={emo.addRound} style={{ width: 32, height: 32 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
                <path d="M12 5v14M5 12h14" />
              </svg>
            </Link>
          </div>
          <div className={emo.italic} style={{ fontSize: 18, marginTop: -4 }}>
            Nos envies
          </div>
          {wishes.latest.length === 0 && <div className={styles.hint}>Vos envies à deux : un week-end, un projet, une idée…</div>}
          {wishes.latest.map((w) => (
            <Link key={w.id} href={`/assistant/envies#${w.id}`} className={emo.homeWish}>
              <span>{w.title}</span>
              {w.horizonLabel && <span className={emo.horizon}>{w.horizonLabel}</span>}
            </Link>
          ))}
          {wishes.latest.length > 0 && (
            <Link href="/assistant/envies" style={{ fontSize: 12, fontWeight: 700, color: "var(--secondary-strong)", paddingTop: 4 }}>
              Voir toutes nos envies ›
            </Link>
          )}
        </div>
      )}

      <OutingHomeCard />

      <Section title="À venir" action={<Link href="/calendrier" className={styles.link}>Calendrier ›</Link>}>
        {(upcoming.loading || pending.loading) && merged.length === 0 && <Loading slow={upcoming.slow} />}
        {(upcoming.error || pending.error) && <RetryNotice message={(upcoming.error ?? pending.error)!.message} onRetry={() => { upcoming.reload(); pending.reload(); }} />}
        {upcoming.data && pending.data && merged.length === 0 && <div className={styles.nothing}>Aucun rendez-vous à venir.</div>}
        {merged.map((e) => (
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
    </AppShell>
  );
}
