import Link from "next/link";
import type { CalendarListItem, EventView, MemberChip } from "@/server/assistant/events";
import { clock } from "./format";
import styles from "./family.module.css";

export const FALLBACK_COLOR = "#6b7280";

/** Une pastille par membre concerné ; un rendez-vous provisoire garde sa pastille de membre, la bordure pointillée porte l'état. */
export function Dots({ members }: { members: MemberChip[] }) {
  return (
    <span className={styles.dots} aria-hidden>
      {members.map((m) => (
        <span key={m.id} className={styles.dot} style={{ background: m.color || FALLBACK_COLOR }} />
      ))}
    </span>
  );
}

export function MemberChips({ members, allFamily }: { members: MemberChip[]; allFamily: boolean }) {
  if (allFamily) {
    return (
      <div className={styles.members}>
        <span className={styles.member}>
          <Dots members={members} />
          Toute la famille
        </span>
      </div>
    );
  }
  return (
    <div className={styles.members}>
      {members.map((m) => (
        <span key={m.id} className={styles.member}>
          <span className={styles.dot} style={{ background: m.color || FALLBACK_COLOR }} aria-hidden />
          {m.firstName}
        </span>
      ))}
    </div>
  );
}

export function StatusChip({ status }: { status: EventView["status"] }) {
  if (status === "provisional") return <span className={`${styles.statusChip} ${styles.statusProvisional}`}>À confirmer</span>;
  if (status === "set_aside") return <span className={`${styles.statusChip} ${styles.statusSetAside}`}>Écarté</span>;
  if (status === "confirmed") return <span className={`${styles.statusChip} ${styles.statusConfirmed}`}>Confirmé</span>;
  return null;
}

/** Ligne de rendez-vous du calendrier : confirmé à la couleur de ses membres, provisoire en gris pointillé, écarté gris et barré (AF-1, AF-5). */
export function EventLine({ event, showConflict = false }: { event: CalendarListItem; showConflict?: boolean }) {
  const variant = event.status === "provisional" ? styles.eventProvisional : event.status === "set_aside" ? styles.eventSetAside : "";
  return (
    <Link href={`/calendrier/rdv/${event.id}`} className={`${styles.eventLine} ${variant}`}>
      <span className={styles.eventTime}>{event.allDay ? "Journée" : clock(event.start)}</span>
      <Dots members={event.members} />
      <span className={styles.eventTitle}>{event.title}</span>
      {event.recurring && (
        <span className={styles.tag} title="Séance d'une série" aria-label="Séance d'une série">
          ↻
        </span>
      )}
      {showConflict && event.conflictsWith.length > 0 && (
        <span className={styles.conflictMark} title="Conflit avec un autre rendez-vous" aria-label="Conflit avec un autre rendez-vous">
          !
        </span>
      )}
      {event.status === "provisional" && <span className={styles.tag}>À confirmer</span>}
      {event.status === "set_aside" && event.statusChange?.byFirstName && <span className={styles.tag}>Écarté par {event.statusChange.byFirstName}</span>}
    </Link>
  );
}
