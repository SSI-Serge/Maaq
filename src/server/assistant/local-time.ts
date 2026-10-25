/**
 * Heure locale du foyer. L'assistant raisonne en heure locale (AAAA-MM-JJTHH:MM) ; la base stocke des instants UTC.
 * Les fuseaux sont gérés avec Intl, sans dépendance.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

function parts(date: Date, timeZone: string) {
  const p = Object.fromEntries(formatter(timeZone).formatToParts(date).map((x) => [x.type, x.value]));
  return { y: Number(p.year), mo: Number(p.month), d: Number(p.day), h: Number(p.hour) % 24, mi: Number(p.minute), s: Number(p.second) };
}

/** Décalage du fuseau par rapport à UTC à cet instant, en millisecondes. */
function offsetMs(date: Date, timeZone: string): number {
  const p = parts(date, timeZone);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::\d{2})?)?$/;

export function isLocalDateTime(value: string): boolean {
  return LOCAL.test(value.trim());
}

/** « AAAA-MM-JJTHH:MM » (ou « AAAA-MM-JJ », minuit) en heure locale → instant UTC. Lance une erreur si la date n'existe pas. */
export function localToUtc(local: string, timeZone: string): Date {
  const m = LOCAL.exec(local.trim());
  if (!m) throw new Error(`date illisible : « ${local} » (attendu AAAA-MM-JJTHH:MM ou AAAA-MM-JJ)`);
  const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0)];
  const naive = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(naive);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || h > 23 || mi > 59) {
    throw new Error(`date inexistante : « ${local} »`);
  }
  let guess = naive - offsetMs(new Date(naive), timeZone);
  guess = naive - offsetMs(new Date(guess), timeZone); // deuxième passage : autour des changements d'heure
  return new Date(guess);
}

/** Instant UTC → « AAAA-MM-JJTHH:MM » en heure locale. */
export function utcToLocal(date: Date, timeZone: string): string {
  const p = parts(date, timeZone);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${p.y}-${two(p.mo)}-${two(p.d)}T${two(p.h)}:${two(p.mi)}`;
}

/** Heure locale « naïve » en millisecondes (comme si le fuseau était UTC) : sert à comparer des horaires locaux entre eux. */
export function localMs(date: Date, timeZone: string): number {
  return Date.parse(`${utcToLocal(date, timeZone)}:00Z`);
}

export function localDay(date: Date, timeZone: string): string {
  return utcToLocal(date, timeZone).slice(0, 10);
}

/** « lundi 2 novembre 2026, 09:00 » : jour de la semaine en toutes lettres, dont l'assistant dépend pour « demain » et « jeudi ». */
export function describeNow(date: Date, timeZone: string): string {
  const day = new Intl.DateTimeFormat("fr-FR", { timeZone, weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(date);
  return `${day}, ${utcToLocal(date, timeZone).slice(11)} (${timeZone})`;
}
