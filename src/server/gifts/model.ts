/**
 * kdo_help — proches, occasions et idées : règles indépendantes du stockage (dates, recherche par nom,
 * échéances de rappel). Les enregistrements sont de simples objets ; voir store.ts pour la persistance.
 */

export interface PersonDetails {
  interests?: string[];
  lifeEvents?: string[];
  dislikes?: string[];
  notes?: string;
  sizes?: Record<string, string>;
}

export interface Person {
  id: string;
  name: string;
  relationship: string | null;
  /** Jour et mois ensemble ; année facultative. */
  birthDay: number | null;
  birthMonth: number | null;
  birthYear: number | null;
  budgetAmount: number | null;
  details: PersonDetails;
  version: number;
  deletedAt: string | null;
}

export interface GiftEvent {
  id: string;
  personId: string | null;
  kind: string;
  title: string;
  eventDay: number;
  eventMonth: number;
  /** NULL = chaque année. */
  eventYear: number | null;
  budgetAmount: number | null;
  version: number;
  deletedAt: string | null;
}

export interface OccasionState {
  occasionKey: string;
  sortedAt: string | null;
  snoozedUntil: string | null;
}

export type IdeaStatus = "suggested" | "saved" | "purchased" | "dismissed";

export interface Idea {
  id: string;
  personId: string | null;
  occasionKey: string | null;
  title: string;
  why: string;
  priceMin: number | null;
  priceMax: number | null;
  status: IdeaStatus;
  suggestedAt: string;
}

/** Occasion à venir, calculée à partir des proches et des événements. */
export interface Occasion {
  /** « person:<id>:<année> » pour un anniversaire, « event:<id>:<année> » sinon. */
  key: string;
  kind: "birthday" | string;
  title: string;
  personId: string | null;
  personName: string | null;
  /** AAAA-MM-JJ. */
  date: string;
  daysRemaining: number;
  /** Âge atteint, pour un anniversaire dont l'année de naissance est connue. */
  age: number | null;
  budgetAmount: number | null;
  sorted: boolean;
  snoozedUntil: string | null;
}

export function normalizeName(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

/** Proches dont le nom correspond : exact d'abord, sinon ceux qui contiennent le texte. */
export function matchPeople(people: Person[], ref: string): Person[] {
  const wanted = normalizeName(ref);
  if (!wanted) return [];
  const alive = people.filter((p) => !p.deletedAt);
  const exact = alive.filter((p) => normalizeName(p.name) === wanted);
  if (exact.length) return exact;
  return alive.filter((p) => normalizeName(p.name).includes(wanted));
}

/** Jour civil (AAAA-MM-JJ) dans un fuseau donné. */
export function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

function dayNumber(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

/** Prochaine occurrence d'un jour/mois à partir d'un jour civil ; null si l'année fixée est passée. */
export function nextOccurrence(day: number, month: number, year: number | null, today: string): { date: string; year: number } | null {
  const start = dayNumber(today);
  const thisYear = Number(today.slice(0, 4));
  if (year !== null) {
    const fixed = Date.UTC(year, month - 1, day);
    return fixed < start ? null : { date: new Date(fixed).toISOString().slice(0, 10), year };
  }
  let candidate = Date.UTC(thisYear, month - 1, day);
  let candidateYear = thisYear;
  if (candidate < start) {
    candidateYear += 1;
    candidate = Date.UTC(candidateYear, month - 1, day);
  }
  return { date: new Date(candidate).toISOString().slice(0, 10), year: candidateYear };
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((dayNumber(toIso) - dayNumber(fromIso)) / 86_400_000);
}

export const KINDS_LABEL: Record<string, string> = {
  birthday: "anniversaire",
  christmas: "Noël",
  anniversary: "anniversaire de mariage",
  namesday: "fête",
  other: "occasion",
};

/**
 * Occasions dans la fenêtre, triées par proximité : anniversaires des proches (déduits) et événements
 * enregistrés. `today` est le jour civil de la personne.
 */
export function upcomingOccasions(
  input: { people: Person[]; events: GiftEvent[]; states: OccasionState[] },
  today: string,
  windowDays: number,
): Occasion[] {
  const states = new Map(input.states.map((s) => [s.occasionKey, s]));
  const people = new Map(input.people.filter((p) => !p.deletedAt).map((p) => [p.id, p]));
  const found: Occasion[] = [];

  const push = (base: Omit<Occasion, "daysRemaining" | "sorted" | "snoozedUntil" | "key"> & { keyPrefix: string; year: number }) => {
    const daysRemaining = daysBetween(today, base.date);
    if (daysRemaining < 0 || daysRemaining > windowDays) return;
    const key = `${base.keyPrefix}:${base.year}`;
    const state = states.get(key);
    found.push({
      key,
      kind: base.kind,
      title: base.title,
      personId: base.personId,
      personName: base.personName,
      date: base.date,
      daysRemaining,
      age: base.age,
      budgetAmount: base.budgetAmount,
      sorted: Boolean(state?.sortedAt),
      snoozedUntil: state?.snoozedUntil ?? null,
    });
  };

  for (const person of people.values()) {
    if (person.birthDay === null || person.birthMonth === null) continue;
    const next = nextOccurrence(person.birthDay, person.birthMonth, null, today);
    if (!next) continue;
    push({
      keyPrefix: `person:${person.id}`,
      year: next.year,
      kind: "birthday",
      title: `Anniversaire de ${person.name}`,
      personId: person.id,
      personName: person.name,
      date: next.date,
      age: person.birthYear ? next.year - person.birthYear : null,
      budgetAmount: person.budgetAmount,
    });
  }

  for (const event of input.events) {
    if (event.deletedAt) continue;
    const next = nextOccurrence(event.eventDay, event.eventMonth, event.eventYear, today);
    if (!next) continue;
    const person = event.personId ? (people.get(event.personId) ?? null) : null;
    push({
      keyPrefix: `event:${event.id}`,
      year: next.year,
      kind: event.kind,
      title: event.title,
      personId: person?.id ?? null,
      personName: person?.name ?? null,
      date: next.date,
      age: null,
      budgetAmount: event.budgetAmount ?? person?.budgetAmount ?? null,
    });
  }

  return found.sort((a, b) => a.daysRemaining - b.daysRemaining || a.title.localeCompare(b.title, "fr"));
}

/** Échéances de rappel (jours avant l'occasion). La plus proche atteinte est envoyée, une seule fois chacune. */
export const REMINDER_POINTS = [21, 7, 2] as const;

export function reminderPointLabel(days: number): string {
  return `T-${days}`;
}

/** Échéance due pour une occasion : la plus lointaine non encore passée… sinon la plus proche atteinte. */
export function dueReminderPoint(daysRemaining: number, alreadySent: Set<string>): string | null {
  // On envoie l'échéance la plus proche déjà atteinte qui n'a pas été envoyée ; les plus lointaines ratées sont ignorées.
  const reached = REMINDER_POINTS.filter((p) => daysRemaining <= p);
  const nearest = reached.length ? Math.min(...reached) : null;
  if (nearest === null) return null;
  const label = reminderPointLabel(nearest);
  return alreadySent.has(label) ? null : label;
}

export function frenchDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${day}/${month}/${year}`;
}

export function frenchLongDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Les heures calmes couvrent-elles l'instant donné, dans le fuseau de la personne ? */
export function inQuietHours(now: Date, timeZone: string, start: string, end: string): boolean {
  const hm = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  const minutes = (value: string) => {
    const [h, m] = value.split(":").map(Number);
    return h * 60 + m;
  };
  const current = minutes(hm);
  const from = minutes(start);
  const to = minutes(end);
  if (from === to) return false;
  return from < to ? current >= from && current < to : current >= from || current < to;
}
