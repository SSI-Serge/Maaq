"use client";

import Link from "next/link";
import { useState } from "react";
import { ApiError } from "@/client/api";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import { useSessionUser } from "@/components/auth/AuthGate";
import { Button, Loading, Notice, RetryNotice } from "@/components/ui";
import type { ConflictView, EventView, MemberChip } from "@/server/assistant/events";
import type { LocationConsentView } from "@/server/assistant/location-consent";
import { conflictSentence, EventForm, nearbySentence } from "./EventForm";
import { pendingChanged } from "@/client/badge";
import { clock, dayOf, longDate, reminderState, shortDate, stamp, TYPE_LABEL, whenLabel } from "./format";
import { MemberChips, StatusChip } from "./parts";
import { PrepareList } from "./PrepareList";
import { PlaceSection } from "./PlaceSection";
import { TravelSection } from "./TravelSection";
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
  const location = useApiQuery<{ consent: LocationConsentView }>("/api/family/location-consent");
  const mutation = useApiMutation();
  const [override, setOverride] = useState<EventView | null>(null);
  const [mode, setMode] = useState<Mode>("view");
  const [slot, setSlot] = useState<Slot | null>(null);
  const [done, setDone] = useState<Done>(null);
  const [lastAction, setLastAction] = useState<Action>("confirm");
  const [pendingLabel, setPendingLabel] = useState<Action | null>(null);
  /** « Garder le créneau demandé » : choix explicite, exigé quand un conflit est affiché (US-74 RF7, CA 9.1). */
  const [kept, setKept] = useState(false);
  /** Portée de l'annulation d'une séance de série (US-109 RF8). */
  const [cancelScope, setCancelScope] = useState<"this" | "following" | "all">("this");
  /** Tâches de préparation retirées avec le RDV annulé : « 2 tâches de préparation ont été retirées » (US-95 RF10). */
  const [retiredTasks, setRetiredTasks] = useState(0);

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
  const fresh = code === "conflict" ? (error?.body?.details as { conflicts?: ConflictView[]; alternatives?: Slot[]; sessions?: string[] } | undefined) : undefined;
  const clashSessions = fresh?.sessions ?? event.series?.conflicts.sessions.map((s) => s.start) ?? [];
  const day = dayOf(event.start);
  const conflicts = fresh?.conflicts ?? event.conflicts;
  const alternatives = fresh?.alternatives ?? event.alternatives;
  const mustChoose = (conflicts.length > 0 || clashSessions.length > 0) && !slot && !kept;
  const provisional = event.status === "provisional";
  const setAside = event.status === "set_aside";
  const busy = mutation.pending;
  const proposedTasks = event.tasks?.items.filter((t) => t.status === "proposed").length ?? 0;
  const shownStart = slot ? slot.start : event.start;
  const shownEnd = slot ? slot.end : event.end;

  async function act(action: Action, options: { withoutTasks?: boolean } = {}) {
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
      body: { version, ...(action === "confirm" && kept ? { allowConflict: true } : {}), ...(action === "confirm" && options.withoutTasks ? { withoutTasks: true } : {}), ...(action === "cancel" && event.series ? { scope: cancelScope } : {}) },
    });
    if (!result) return;
    setKept(false);
    pendingChanged(); // le badge de l'icône suit le nombre de confirmations en attente (US-84 RF2)
    if (action === "cancel") {
      setRetiredTasks((result as unknown as { event: { retiredTasks?: number } }).event.retiredTasks ?? 0);
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
          <div className={`${styles.alert} ${styles.alertSuccess}`}>Rendez-vous annulé. Il a été retiré du calendrier familial.
            {retiredTasks > 0 && ` ${retiredTasks} tâche${retiredTasks > 1 ? "s" : ""} de préparation ${retiredTasks > 1 ? "ont été retirées" : "a été retirée"}.`}
          </div>
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
          {!event.past && event.status === "confirmed" && event.statusChange?.auto && (
            <Notice tone="info">
              Confirmé par MAAQ (sans réponse) le {when}. Personne n&apos;a confirmé ni écarté ce RDV après deux relances. Vous pouvez encore le modifier ou l&apos;annuler.
            </Notice>
          )}
          {!event.past && event.status === "confirmed" && who && !event.statusChange?.auto && (
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

          {/* Séances d'une série en conflit : « 3 séances sur 24 sont en conflit » (US-109 RF5) */}
          {event.series && clashSessions.length > 0 && (provisional || setAside) && (
            <div className={`${styles.alert} ${styles.alertWarning}`} role="alert" style={{ flexDirection: "column" }}>
              <div>
                {clashSessions.length} séance{clashSessions.length > 1 ? "s" : ""} sur {event.series.sessions} {clashSessions.length > 1 ? "sont" : "est"} en conflit avec un autre rendez-vous :
              </div>
              <div>{clashSessions.slice(0, 8).map((s) => `${shortDate(dayOf(s))} à ${clock(s)}`).join(" · ")}{clashSessions.length > 8 ? " …" : ""}</div>
              {conflicts.length === 0 && (
                <div className={styles.slots}>
                  <button type="button" className={styles.slot} aria-pressed={kept} onClick={() => setKept(!kept)} disabled={busy}>
                    Garder ces séances quand même
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Proposition d'ajouter l'adresse pour suivre le trajet : jamais pour un RDV médical ou administratif ; une simple proposition, qu'on peut ignorer (US-107 RF2) */}
          {!event.placeKnown && !event.past && event.can.modify && ["school", "work", "family", "personal"].includes(event.type) && (provisional || event.status === "confirmed") && (
            <Notice tone="info">
              {event.place ? "Choisissez l'adresse dans les suggestions pour suivre votre trajet avant ce RDV." : "Ajoutez l'adresse pour suivre votre trajet avant ce RDV."}{" "}
              <button type="button" className={styles.link} onClick={() => setMode("edit")}>
                {event.place ? "Choisir l'adresse" : "Ajouter l'adresse"}
              </button>
            </Notice>
          )}

          {/* RDV rapproché, sans chevauchement : une information, qui n'empêche pas de confirmer (US-107 RF1) */}
          {event.nearby.length > 0 && (provisional || setAside || event.status === "confirmed") && (
            <Notice tone="info">
              {event.nearby.map((n) => (
                <div key={n.id}>{nearbySentence(n)}</div>
              ))}
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
            {event.series && (
              <div className={styles.row}>
                <span className={styles.rowLabel}>Répétition</span>
                <span className={styles.rowValue}>
                  {event.series.rule}
                  <span className={styles.rowSub}>
                    <span className={styles.tag}>↻ Série</span> {event.series.modified && <span className={styles.tag}>Modifiée</span>}
                  </span>
                </span>
              </div>
            )}
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

          {/* Suivi du trajet, propre à ce profil (US-107 RF4) */}
          {event.travel && <TravelSection event={event} consent={location.data?.consent.status ?? null} onChanged={reload} onEditAddress={() => setMode("edit")} />}

          {/* « Sur place » : où se garer et où manger près du lieu (US-112) ; jamais pour un RDV médical */}
          {event.place && event.type !== "medical" && !event.past && (provisional || event.status === "confirmed") && <PlaceSection eventId={event.id} />}

          {/* Liste « À préparer » : se retire, se modifie, s'ajoute ici comme dans la carte du tchat (US-95 RF3, RF5) */}
          {event.tasks && (event.tasks.items.length > 0 || event.tasks.editable) && <PrepareList event={event} onUpdated={setOverride} onStale={reload} disabled={busy} />}

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
                {busy && pendingLabel === "confirm" ? "Confirmation…" : setAside ? "Confirmer quand même" : proposedTasks > 0 ? `Confirmer le RDV et ${proposedTasks} tâche${proposedTasks > 1 ? "s" : ""}` : "Confirmer le rendez-vous"}
              </Button>
            )}
            {event.can.confirm && proposedTasks > 0 && (
              <button type="button" className={styles.link} onClick={() => void act("confirm", { withoutTasks: true })} disabled={busy || mustChoose}>
                Confirmer sans les tâches
              </button>
            )}
            {/* Mention sous le bouton : le RDV sera-t-il ajouté sans réponse, ou jamais (AT-8, US-95 UX) */}
            {provisional && event.can.confirm && event.autoConfirm && (
              <span className={styles.source}>
                {"at" in event.autoConfirm
                  ? `Sans réponse de votre part, ce RDV sera ajouté à votre calendrier le ${shortDate(dayOf(event.autoConfirm.at))} à ${clock(event.autoConfirm.at)}.`
                  : "Ce RDV ne sera jamais ajouté sans votre confirmation."}
              </span>
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
              {event.series ? (
                <div className={styles.members} role="radiogroup" aria-label="Portée de l'annulation">
                  {[
                    { value: "this" as const, label: "Cette séance" },
                    { value: "following" as const, label: "Cette séance et les suivantes" },
                    { value: "all" as const, label: "Toute la série" },
                  ].map((s) => (
                    <button key={s.value} type="button" role="radio" aria-checked={cancelScope === s.value} className={styles.chipToggle} onClick={() => setCancelScope(s.value)}>
                      {s.label}
                    </button>
                  ))}
                </div>
              ) : (
                <div>Il sera retiré du calendrier familial.</div>
              )}
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
