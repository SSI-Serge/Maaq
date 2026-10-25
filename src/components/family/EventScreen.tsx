"use client";

import Link from "next/link";
import { useState } from "react";
import { ApiError } from "@/client/api";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import { useSessionUser } from "@/components/auth/AuthGate";
import { Button, Loading, Notice, RetryNotice } from "@/components/ui";
import type { ConflictView, EventView, MemberChip } from "@/server/assistant/events";
import { conflictSentence, EventForm } from "./EventForm";
import { clock, dayOf, longDate, reminderState, shortDate, stamp, TYPE_LABEL, whenLabel } from "./format";
import { MemberChips, StatusChip } from "./parts";
import styles from "./family.module.css";

type Action = "confirm" | "setAside" | "cancel";
type Mode = "view" | "edit" | "cancelConfirm";
type Done = "confirmed" | "setAside" | "canceled" | null;

const FAILURE: Record<Action, string> = {
  confirm: "Le rendez-vous n'a pas pu être confirmé.",
  setAside: "Le rendez-vous n'a pas pu être ignoré.",
  cancel: "Le rendez-vous n'a pas pu être annulé.",
};
const PATH: Record<Action, string> = { confirm: "confirm", setAside: "set-aside", cancel: "cancel" };

interface Slot {
  start: string;
  end: string;
}

/**
 * Écran d'un rendez-vous. Provisoire : confirmation (US-74, US-75, US-76, US-77) avec résumé Quoi / Qui / Quand / Où, bannière de conflit
 * et créneaux alternatifs, boutons « Confirmer », « Modifier », « Ignorer ». Écarté : « Confirmer quand même ». Confirmé : détail
 * (US-79) avec « Modifier » et « Annuler le RDV » (US-80). Le serveur dit ce que ce profil peut faire (`can`).
 */
export function EventScreen({ id }: { id: string }) {
  const user = useSessionUser();
  const detail = useApiQuery<{ event: EventView }>(`/api/family/events/${id}`);
  const members = useApiQuery<{ members: MemberChip[] }>("/api/family/members");
  const mutation = useApiMutation();
  const [override, setOverride] = useState<EventView | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [slot, setSlot] = useState<Slot | null>(null);
  const [done, setDone] = useState<Done>(null);
  const [lastAction, setLastAction] = useState<Action>("confirm");
  const [pendingLabel, setPendingLabel] = useState<Action | null>(null);
  /** « Garder le créneau demandé » : choix explicite, exigé quand un conflit est affiché (US-74 RF7, CA 9.1). */
  const [kept, setKept] = useState(false);

  const event = override ?? detail.data?.event;

  function reload() {
    setOverride(null);
    setSlot(null);
    setMode("view");
    setKept(false);
    mutation.reset();
    detail.reload();
  }

  // --- Chargement et erreurs (US-74 RF11, RF12, US-75 RF16, US-79 RF6, RF9 à RF11) ---
  if (!event) {
    const gone = detail.error?.body?.code === "gone" || detail.error?.body?.code === "not_found";
    return (
      <AppShell title="Rendez-vous" back={{ href: "/calendrier", label: "Calendrier" }}>
        {detail.loading && <Loading slow={detail.slow} label="Vérification du calendrier…" />}
        {detail.error && gone && (
          <div className={styles.success}>
            <Notice tone="info">Ce rendez-vous n&apos;existe plus ou ne vous est pas accessible.</Notice>
            <Link href="/calendrier" className={styles.link}>
              Retour au calendrier ›
            </Link>
          </div>
        )}
        {detail.error && !gone && <RetryNotice message={detail.error.kind === "server" ? "Le calendrier n'a pas pu être vérifié." : detail.error.message} onRetry={detail.reload} />}
      </AppShell>
    );
  }

  // Un conflit apparu entre-temps arrive avec la réponse refusée : la bannière est mise à jour avant toute confirmation (US-74 RF9).
  const error: ApiError | undefined = mutation.error;
  const code = error?.body?.code;
  const fresh = code === "conflict" ? (error?.body?.details as { conflicts?: ConflictView[]; alternatives?: Slot[] } | undefined) : undefined;
  const day = dayOf(event.start);
  const conflicts = fresh?.conflicts ?? event.conflicts;
  const alternatives = fresh?.alternatives ?? event.alternatives;
  const mustChoose = conflicts.length > 0 && !slot && !kept;
  const provisional = event.status === "provisional";
  const setAside = event.status === "set_aside";
  const busy = mutation.pending;
  const shownStart = slot ? slot.start : event.start;
  const shownEnd = slot ? slot.end : event.end;

  async function act(action: Action) {
    if (!event) return;
    setLastAction(action);
    setPendingLabel(action);
    let version = event.version;
    // Un créneau alternatif choisi remplace le créneau demandé avant la confirmation (US-74 RF7).
    if (action === "confirm" && slot) {
      const moved = await mutation.run<{ event: EventView }>(`/api/family/events/${event.id}`, {
        method: "PATCH",
        body: {
          version, title: event.title, type: event.type, allFamily: event.allFamily, memberIds: event.allFamily ? [] : event.members.map((m) => m.id),
          allDay: event.allDay, start: slot.start, end: slot.end, place: event.place, notes: event.notes,
        },
      });
      if (!moved) return;
      setOverride(moved.event);
      setSlot(null);
      version = moved.event.version;
    }
    const result = await mutation.run<{ event: EventView } | { id: string; status: "canceled" }>(`/api/family/events/${event.id}/${PATH[action]}`, {
      method: "POST",
      body: { version, ...(action === "confirm" && kept ? { allowConflict: true } : {}) },
    });
    if (!result) return;
    setKept(false);
    if (action === "cancel") {
      setDone("canceled");
      setMode("view");
      return;
    }
    setOverride((result as { event: EventView }).event);
    setDone(action === "confirm" ? "confirmed" : "setAside");
  }

  if (done === "canceled") {
    return (
      <AppShell title="Rendez-vous annulé" back={{ href: "/calendrier", label: "Calendrier" }}>
        <div className={styles.success}>
          <div className={`${styles.alert} ${styles.alertSuccess}`}>Rendez-vous annulé. Il a été retiré du calendrier familial.</div>
          <Link href="/calendrier" className={styles.link}>
            Retour au calendrier ›
          </Link>
        </div>
      </AppShell>
    );
  }

  const who = event.statusChange?.byFirstName;
  const when = event.statusChange ? stamp(event.statusChange.at) : "";
  const requestedByMe = event.requestedBy === user.firstName;
  const sourceLine = event.source === "mail" ? "Source : mail transféré" : requestedByMe || !event.requestedBy ? "Source : votre message" : `Source : message de ${event.requestedBy}`;

  return (
    <AppShell
      title={provisional || setAside ? "Confirmation" : "Rendez-vous"}
      back={{ href: "/calendrier", label: "Calendrier" }}
      subtitle={<span className={styles.source}>{sourceLine}</span>}
    >
      {mode === "edit" && members.data ? (
        <EventForm
          event={event}
          members={members.data.members}
          onSaved={(saved) => {
            setOverride(saved);
            setMode("view");
            setSlot(null);
            setKept(false);
            setDone(null);
          }}
          onCancel={() => setMode("view")}
          onStale={reload}
        />
      ) : (
        <>
          {done === "confirmed" && (
            <div className={styles.success}>
              <div className={`${styles.alert} ${styles.alertSuccess}`} role="status">
                ✓ Rendez-vous ajouté à votre calendrier familial
              </div>
              <div className={styles.actionsRow}>
                <button type="button" className={styles.link} onClick={() => setDone(null)}>
                  Voir le détail ›
                </button>
                <Link href="/calendrier" className={styles.link}>
                  Ouvrir le calendrier ›
                </Link>
              </div>
            </div>
          )}
          {done === "setAside" && (
            <div className={styles.success}>
              <div className={`${styles.alert} ${styles.alertInfo}`} role="status">
                Proposition ignorée. Elle reste visible en gris dans votre calendrier jusqu&apos;à une éventuelle relance, puis disparaît.
              </div>
              <Link href="/assistant" className={styles.link}>
                Retour à l&apos;assistant ›
              </Link>
            </div>
          )}

          {event.past && (provisional || setAside) && <Notice tone="warning">Ce rendez-vous est déjà passé.</Notice>}
          {event.past && event.status === "confirmed" && <Notice tone="info">Ce rendez-vous est passé : il n&apos;est plus modifiable.</Notice>}
          {!event.past && event.status === "confirmed" && who && (
            <Notice tone="success">
              Confirmé par {who} le {when}.
            </Notice>
          )}
          {provisional && event.nudge && (
            <Notice tone="info">Relance envoyée il y a {event.nudge.kind === "nudge48" ? "48h" : "24h"} — en attente de votre confirmation.</Notice>
          )}
          {setAside && (
            <Notice tone="info">
              Écarté{who ? ` par ${who}` : ""} le {when}. Il disparaîtra bientôt du calendrier ; vous pouvez encore le confirmer.
            </Notice>
          )}

          {/* Bannière de conflit et créneaux alternatifs (US-74 RF5 à RF8) */}
          {conflicts.length > 0 && (provisional || setAside || event.status === "confirmed") && (
            <div className={`${styles.alert} ${styles.alertWarning}`} role="alert" style={{ flexDirection: "column" }}>
              {conflicts.map((c) => (
                <div key={c.id}>{conflictSentence(c, day)}</div>
              ))}
              {(provisional || setAside) && (
                <>
                  {alternatives.length > 0 ? (
                    <>
                      <div>Choisissez un autre horaire :</div>
                      <div className={styles.slots}>
                        {alternatives.map((a) => (
                          <button key={a.start} type="button" className={styles.slot} aria-pressed={slot?.start === a.start} onClick={() => { setSlot(a); setKept(false); }} disabled={busy}>
                            {shortDate(dayOf(a.start))} · {clock(a.start)}
                          </button>
                        ))}
                        <button type="button" className={styles.slot} aria-pressed={kept} onClick={() => { setSlot(null); setKept(true); }} disabled={busy}>
                          Garder {clock(event.start)}
                        </button>
                      </div>
                    </>
                  ) : (
                    <div>Aucun autre créneau libre n&apos;a été trouvé.</div>
                  )}
                </>
              )}
            </div>
          )}

          <div className={`${styles.summary} ${provisional || setAside ? styles.summaryDashed : ""}`}>
            <div className={styles.row}>
              <span className={styles.rowLabel}>Quoi</span>
              <span className={styles.rowValue}>
                {event.title}
                <span className={styles.rowSub}>
                  {TYPE_LABEL[event.type]} <StatusChip status={event.status} />
                </span>
              </span>
            </div>
            <div className={styles.row}>
              <span className={styles.rowLabel}>Qui</span>
              <span className={styles.rowValue}>
                <MemberChips members={event.members} allFamily={event.allFamily} />
              </span>
            </div>
            <div className={styles.row}>
              <span className={styles.rowLabel}>Quand</span>
              <span className={styles.rowValue}>
                {longDate(dayOf(shownStart))}
                <span className={styles.rowSub}>{whenLabel({ start: shownStart, end: shownEnd, allDay: event.allDay })}</span>
              </span>
            </div>
            {event.place && (
              <div className={styles.row}>
                <span className={styles.rowLabel}>Où</span>
                <span className={styles.rowValue}>{event.place}</span>
              </div>
            )}
            {event.notes && (
              <div className={styles.row}>
                <span className={styles.rowLabel}>Note</span>
                <span className={styles.rowValue}>{event.notes}</span>
              </div>
            )}
            {event.status === "confirmed" && event.reminders.length > 0 && (
              <div className={styles.row}>
                <span className={styles.rowLabel}>Rappels</span>
                <span className={styles.rowValue}>
                  {event.reminders.map((r) => (
                    <span key={r.kind} className={styles.reminderLine}>
                      <span>{r.label}</span>
                      <span className={r.state === "sent" ? styles.reminderSent : styles.reminderOther}>{reminderState(r)}</span>
                    </span>
                  ))}
                </span>
              </div>
            )}
          </div>

          {mustChoose && event.can.confirm && <span className={styles.source}>Choisissez un horaire ci-dessus pour confirmer.</span>}
          {error && error.kind === "rejected" && code !== "conflict" && (
            <div className={styles.dialog} role="alert">
              <span>{error.message}</span>
              {["already_handled", "stale_version", "not_found", "gone"].includes(code ?? "") && (
                <Button variant="secondary" onClick={reload}>
                  Afficher la dernière version
                </Button>
              )}
            </div>
          )}
          {error && error.kind !== "rejected" && (
            <RetryNotice
              message={error.kind === "server" ? FAILURE[lastAction] : error.message}
              onRetry={() => void act(lastAction)}
            />
          )}
          {mutation.slow && <Notice tone="info">Toujours en cours…</Notice>}

          {/* Boutons selon les droits du profil et l'état du rendez-vous (US-75 RF6, RF9 à RF11, US-77 RF4, US-80) */}
          <div className={styles.actions}>
            {event.can.confirm && (
              <Button block onClick={() => void act("confirm")} loading={busy && pendingLabel === "confirm"} disabled={busy || mustChoose}>
                {busy && pendingLabel === "confirm" ? "Confirmation…" : setAside ? "Confirmer quand même" : "Confirmer le rendez-vous"}
              </Button>
            )}
            {(event.can.modify || event.can.setAside) && (
              <div className={styles.actionsRow}>
                {event.can.modify && (
                  <Button variant="secondary" onClick={() => setMode("edit")} disabled={busy || !members.data}>
                    Modifier
                  </Button>
                )}
                {event.can.setAside && (
                  <Button variant="secondary" onClick={() => void act("setAside")} loading={busy && pendingLabel === "setAside"} disabled={busy}>
                    Ignorer
                  </Button>
                )}
              </div>
            )}
            {event.can.cancel && mode !== "cancelConfirm" && (
              <Button variant="danger" block onClick={() => setMode("cancelConfirm")} disabled={busy}>
                Annuler le RDV
              </Button>
            )}
          </div>

          {mode === "cancelConfirm" && (
            <div className={styles.dialog} role="alertdialog" aria-label="Annuler ce rendez-vous ?">
              <div className={styles.dialogTitle}>Annuler ce rendez-vous ?</div>
              <div>Il sera retiré du calendrier familial.</div>
              <div className={styles.actionsRow}>
                <Button variant="secondary" onClick={() => setMode("view")} disabled={busy}>
                  Revenir
                </Button>
                <Button variant="danger" onClick={() => void act("cancel")} loading={busy && pendingLabel === "cancel"} disabled={busy}>
                  {busy && pendingLabel === "cancel" ? "Annulation…" : "Annuler le RDV"}
                </Button>
              </div>
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}
