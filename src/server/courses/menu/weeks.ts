const MONTHS = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

/** « 9 novembre », « 1er décembre » : la semaine commence ce lundi-là. */
export function weekLabel(week: string): string {
  const [, m, d] = week.split("-").map(Number);
  return `${d === 1 ? "1er" : d} ${MONTHS[m - 1]}`;
}
