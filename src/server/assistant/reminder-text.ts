import type { OutgoingEmail } from "@/server/adapters/messaging";
import { localDay, utcToLocal } from "./local-time";
import type { EventType } from "./calendar";

/** Textes des rappels (US-81 RF4) et des relances (US-83 RF3) envoyés par email. Les heures sont dans le fuseau du foyer (AF-2). */

export type ReminderKind = "d7" | "d1" | "d0";
export type NudgeKind = "nudge24" | "nudge48";

export interface NotifiedEvent {
  id: string;
  title: string;
  type: EventType;
  place: string | null;
  startsAt: Date;
  allDay: boolean;
}

const clock = (local: string) => `${Number(local.slice(11, 13))}h${local.slice(14, 16)}`;

const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / 86_400_000);

/** « 17h00 », ou « toute la journée ». */
function timeOf(event: NotifiedEvent, timeZone: string): string {
  return event.allDay ? "toute la journée" : clock(utcToLocal(event.startsAt, timeZone));
}

/** « Aujourd'hui », « Demain » ou « Dans N jours » : calculé à l'envoi, car un rappel rattrapé après un incident part plus tard que prévu. */
function when(event: NotifiedEvent, timeZone: string, now: Date): string {
  const days = dayNumber(localDay(event.startsAt, timeZone)) - dayNumber(localDay(now, timeZone));
  return days <= 0 ? "Aujourd'hui" : days === 1 ? "Demain" : `Dans ${days} jours`;
}

/** « mardi », ou « mardi 3 novembre » au-delà d'une semaine. */
function weekdayOf(event: NotifiedEvent, timeZone: string, now: Date): string {
  const days = dayNumber(localDay(event.startsAt, timeZone)) - dayNumber(localDay(now, timeZone));
  const options: Intl.DateTimeFormatOptions = days > 6 ? { weekday: "long", day: "numeric", month: "long" } : { weekday: "long" };
  return new Intl.DateTimeFormat("fr-FR", { timeZone, ...options }).format(event.startsAt);
}

// Le lieu d'un RDV médical ne part jamais dans une notification ni dans un email : il s'afficherait sur l'écran verrouillé (D31).
const placeLine = (event: NotifiedEvent) => (event.place && event.type !== "medical" ? `Lieu : ${event.place}\n` : "");

const SIGNATURE = "\n\nL'équipe MAAQ";

/** « Demain 17h00 — RDV médical — Léo » (US-81 RF4). */
export function reminderHeadline(event: NotifiedEvent, timeZone: string, now: Date): string {
  return `${when(event, timeZone, now)} ${timeOf(event, timeZone)} — ${event.title}`;
}

/** « À confirmer : RDV médical — Léo, mardi 17h00 » (US-83 RF3). */
export function nudgeHeadline(event: NotifiedEvent, timeZone: string, now: Date): string {
  return `À confirmer : ${event.title}, ${weekdayOf(event, timeZone, now)} ${timeOf(event, timeZone)}`;
}

/** « Camille a ajouté : Réunion parents-professeurs — Léa, jeudi 18h00 » (US-113 RF2, RF10) : l'autre parent prévenu d'un RDV confirmé. */
export function eventAddedBody(event: NotifiedEvent, requester: string, timeZone: string, now: Date): string {
  return `${requester} a ajouté : ${event.title}, ${weekdayOf(event, timeZone, now)} ${timeOf(event, timeZone)}`;
}

/** « À confirmer — Camille a demandé : Réunion parents-professeurs — Léa, jeudi 18h00 » (US-113 RF3) : RDV encore provisoire 10 minutes après sa proposition. */
export function eventToConfirmBody(event: NotifiedEvent, requester: string, timeZone: string, now: Date): string {
  return `À confirmer — ${requester} a demandé : ${event.title}, ${weekdayOf(event, timeZone, now)} ${timeOf(event, timeZone)}`;
}

/** « jeudi 5 novembre à 18h00 » : jour entier et heure, pour un avis qui ne dit pas « demain » (AT-8). */
function dayAndTime(event: NotifiedEvent, timeZone: string): string {
  const day = new Intl.DateTimeFormat("fr-FR", { timeZone, weekday: "long", day: "numeric", month: "long" }).format(event.startsAt);
  return event.allDay ? `${day}, toute la journée` : `${day} à ${timeOf(event, timeZone)}`;
}

/** « RDV ajouté automatiquement : titre, jeudi 5 novembre à 18h00 » : avis aux parents d'un enregistrement sans réponse (AT-8, US-113 RF7). */
export function autoConfirmedHeadline(event: NotifiedEvent, timeZone: string): string {
  return `RDV ajouté automatiquement : ${event.title}, ${dayAndTime(event, timeZone)}`;
}

/** « RDV ajouté au calendrier : titre, jeudi à 18h00 » : un invité secondaire concerné par un RDV enregistré d'office (US-113 RF10). */
export function eventAddedAutoBody(event: NotifiedEvent, timeZone: string, now: Date): string {
  return `RDV ajouté au calendrier : ${event.title}, ${weekdayOf(event, timeZone, now)} ${event.allDay ? "toute la journée" : `à ${timeOf(event, timeZone)}`}`;
}

/** Ajoutée à la seconde relance quand l'enregistrement sans réponse est en service pour ce RDV (AT-8). */
export const AUTO_CONFIRM_WARNING = "Sans réponse de votre part, ce RDV sera ajouté à votre calendrier dans 24 h.";

export function autoConfirmedEmail(params: { firstName: string; to: string; event: NotifiedEvent; timeZone: string; appUrl: string }): OutgoingEmail {
  const headline = autoConfirmedHeadline(params.event, params.timeZone);
  return {
    to: params.to,
    subject: headline,
    text:
      `Bonjour ${params.firstName},\n\n${headline}\n\n` +
      `Personne n'a confirmé ni écarté ce RDV après deux relances. Vous pouvez encore le modifier ou l'annuler.\n` +
      `Ouvrir le rendez-vous : ${params.appUrl}/calendrier/rdv/${params.event.id}` +
      SIGNATURE,
  };
}

/** Texte d'une notification : même contenu que l'email, lieu des RDV médicaux exclu (D31). */
export function reminderPushBody(event: NotifiedEvent, timeZone: string, now: Date): string {
  return `${reminderHeadline(event, timeZone, now)}${event.place && event.type !== "medical" ? `\n${event.place}` : ""}`;
}

export function reminderEmail(params: { firstName: string; to: string; event: NotifiedEvent; timeZone: string; now: Date; appUrl: string }): OutgoingEmail {
  const { event, timeZone, now } = params;
  const headline = reminderHeadline(event, timeZone, now);
  return {
    to: params.to,
    subject: headline,
    text:
      `Bonjour ${params.firstName},\n\n${headline}\n${placeLine(event)}\n` +
      `Ouvrir le rendez-vous : ${params.appUrl}/calendrier/rdv/${event.id}\n\n` +
      `Vous recevez ce rappel de l'Assistant Famille. Les délais de rappel se règlent dans Assistant Famille, Réglages.` +
      SIGNATURE,
  };
}

export function nudgeEmail(params: { firstName: string; to: string; event: NotifiedEvent; timeZone: string; now: Date; appUrl: string; autoConfirmWarning?: boolean }): OutgoingEmail {
  const { event, timeZone, now } = params;
  const headline = nudgeHeadline(event, timeZone, now);
  return {
    to: params.to,
    subject: headline,
    text:
      `Bonjour ${params.firstName},\n\n${headline}\n\n` +
      `L'Assistant Famille a préparé ce rendez-vous : il attend votre confirmation pour entrer dans le calendrier.\n` +
      (params.autoConfirmWarning ? `${AUTO_CONFIRM_WARNING}\n` : "") +
      `Confirmer le rendez-vous : ${params.appUrl}/calendrier/rdv/${event.id}` +
      SIGNATURE,
  };
}
