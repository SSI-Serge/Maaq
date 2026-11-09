import { courseError } from "../household/settings";
import { isoDate, nextMonday } from "../engine";

const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

/** « 9 novembre », « 1er décembre » : la semaine commence ce lundi-là. */
export function weekLabel(week: string): string {
  const [, m, d] = week.split("-").map(Number);
  return `${d === 1 ? "1er" : d} ${MONTHS[m - 1]}`;
}

function mondayOf(date: Date): string {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return isoDate(d);
}

/** Semaine préparée : le lundi qui vient par défaut ; le lundi de cette semaine et les quatre suivants sont acceptés (CR-56). */
export function resolveWeek(requested: string | undefined, now: Date): string {
  if (!requested) return nextMonday(now);
  const first = mondayOf(now);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(requested) && requested >= first && requested <= isoDate(new Date(Number(first.slice(0, 4)), Number(first.slice(5, 7)) - 1, Number(first.slice(8)) + 28));
  const isMonday = valid && new Date(`${requested}T12:00:00`).getDay() === 1;
  if (!isMonday) throw courseError("invalid_week", "Choisissez un lundi de cette semaine ou des quatre suivantes.", 422);
  return requested;
}
