import type { EventType } from "@/server/assistant/calendar";

/**
 * Dates et heures du calendrier familial. L'API donne des heures locales du foyer (« AAAA-MM-JJTHH:MM ») : on les lit telles quelles,
 * sans conversion de fuseau (AF-2). Les jours sont manipulés comme des chaînes « AAAA-MM-JJ ».
 */

const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const WEEKDAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
const pad = (n: number) => String(n).padStart(2, "0");

export const TYPE_LABEL: Record<EventType, string> = {
  school: "École", medical: "Médical", work: "Professionnel", family: "Familial", personal: "Personnel", admin: "Administratif",
};
export const EVENT_TYPE_OPTIONS = Object.entries(TYPE_LABEL).map(([value, label]) => ({ value: value as EventType, label }));

const utc = (day: string) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const toDay = (date: Date) => date.toISOString().slice(0, 10);

export const dayOf = (local: string) => local.slice(0, 10);
export const timeOf = (local: string) => local.slice(11, 16);

/** « 17h00 » */
export const clock = (local: string) => `${Number(local.slice(11, 13))}h${local.slice(14, 16)}`;

/** « mardi 3 novembre 2026 » */
export function longDate(day: string): string {
  const d = utc(day);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** « mar. 3 nov. » */
export function shortDate(day: string): string {
  const d = utc(day);
  return `${WEEKDAYS[d.getUTCDay()].slice(0, 3)}. ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()].slice(0, 3)}.`;
}

/** « novembre 2026 » */
export function monthLabel(day: string): string {
  const d = utc(day);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export const weekdayShort = (index: number) => ["lun.", "mar.", "mer.", "jeu.", "ven.", "sam.", "dim."][index];

export const addDays = (day: string, n: number) => toDay(new Date(utc(day).getTime() + n * 86_400_000));

/** Lundi de la semaine du jour donné. */
export function weekStart(day: string): string {
  const d = utc(day);
  return addDays(day, -((d.getUTCDay() + 6) % 7));
}

export const monthStart = (day: string) => `${day.slice(0, 7)}-01`;

export function addMonths(day: string, n: number): string {
  const d = utc(monthStart(day));
  return toDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1)));
}

/** Jours affichés pour un mois : de lundi à dimanche, semaines entières. */
export function monthGrid(day: string): string[] {
  const first = monthStart(day);
  const last = addDays(addMonths(first, 1), -1);
  const start = weekStart(first);
  const end = addDays(weekStart(last), 6);
  const days: string[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  return days;
}

/** Aujourd'hui, d'après l'horloge de l'appareil. */
export function todayLocal(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** « Toute la journée » ou « 17h00 – 18h00 » ; sur plusieurs jours, la date de fin est précisée. */
export function whenLabel(event: { start: string; end: string; allDay: boolean }): string {
  if (event.allDay) return dayOf(event.start) === dayOf(event.end) ? "Toute la journée" : `Du ${shortDate(dayOf(event.start))} au ${shortDate(dayOf(event.end))}`;
  const sameDay = dayOf(event.start) === dayOf(event.end);
  return sameDay ? `${clock(event.start)} – ${clock(event.end)}` : `${clock(event.start)} – ${shortDate(dayOf(event.end))} ${clock(event.end)}`;
}

/** « 24/10 à 9 h 12 » (US-75 RF9) à partir d'un instant ISO affiché dans le fuseau de l'appareil. */
export function stamp(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} à ${d.getHours()} h ${pad(d.getMinutes())}`;
}

/** Période du jour d'un rendez-vous (US-78 RF9). */
export function period(local: string): "Matin" | "Midi" | "Après-midi" | "Soir" {
  const hour = Number(local.slice(11, 13));
  if (hour < 12) return "Matin";
  if (hour < 14) return "Midi";
  if (hour < 18) return "Après-midi";
  return "Soir";
}

export const PERIODS = ["Matin", "Midi", "Après-midi", "Soir"] as const;

/** Heure « HH:MM » du champ de formulaire à partir d'une heure locale complète. */
export const formTime = (local: string) => local.slice(11, 16);

/** « 12/03/2018 » */
export const birthLabel = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`;
