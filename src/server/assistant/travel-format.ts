/** Textes et durées des trajets, sans dépendance serveur : partagés par les notifications et les écrans. */

/** « 17h20 » d'une heure locale « AAAA-MM-JJTHH:MM ». */
export const clockFr = (local: string) => `${Number(local.slice(11, 13))}h${local.slice(14, 16)}`;

/** « 40 min », « 1 h 20 », « 2 h ». */
export function durationLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${String(m).padStart(2, "0")}` : `${h} h`;
}
