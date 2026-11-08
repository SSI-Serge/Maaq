import type { Dish } from "./types";

/** Durée estimée d'une séance quand aucune semaine type ne convient : le plat le plus long, plus 40 % des autres (US-156 RF6). */
export function estimateMinutes(dishes: Pick<Dish, "minutes">[]): number {
  const m = dishes.map((d) => d.minutes).sort((a, b) => b - a);
  return m.length ? m[0] + 0.4 * m.slice(1).reduce((s, x) => s + x, 0) : 0;
}

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Lundi qui suit `today` (le lundi suivant, jamais aujourd'hui). */
export function nextMonday(today: Date): string {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const weekday = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() + 7 - weekday);
  return isoDate(d);
}
