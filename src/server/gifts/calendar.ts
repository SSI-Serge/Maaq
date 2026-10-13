import { z } from "zod";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { Rejection } from "@/server/http";
import { localDate, occurrencesInMonth, type CalendarItem, type GiftEvent, type Person } from "./model";
import { giftStore } from "./service";
import { NotFound, VersionConflict, type GiftStore } from "./store";

/**
 * Calendrier des occasions de kdo_help, sur la fiche de l'agent : lecture par mois, ajout, modification et
 * suppression d'anniversaires (proches) et d'occasions, par la personne elle-même. Mêmes données que le tchat.
 */

export interface MonthView {
  year: number;
  month: number;
  /** Jour civil de la personne, AAAA-MM-JJ. */
  today: string;
  items: CalendarItem[];
  /** Proches, pour rattacher une occasion à l'un d'eux. */
  people: { id: string; name: string; relationship: string | null }[];
}

const dayMonth = { day: z.number().int().min(1).max(31), month: z.number().int().min(1).max(12) };

export const personInputSchema = z.object({
  name: z.string().trim().min(1, "Le prénom est obligatoire.").max(100),
  relationship: z.string().trim().max(100).nullable().optional(),
  birthDay: dayMonth.day.nullable().optional(),
  birthMonth: dayMonth.month.nullable().optional(),
  birthYear: z.number().int().min(1900).max(2100).nullable().optional(),
  budgetAmount: z.number().min(0).max(1_000_000).nullable().optional(),
  interests: z.array(z.string().trim().min(1).max(100)).max(30).optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export const eventInputSchema = z.object({
  title: z.string().trim().min(1, "Le titre est obligatoire.").max(150),
  kind: z.enum(["christmas", "anniversary", "namesday", "other"]).default("other"),
  eventDay: dayMonth.day,
  eventMonth: dayMonth.month,
  /** Année : absente = chaque année. */
  eventYear: z.number().int().min(1900).max(2100).nullable().optional(),
  personId: z.string().uuid().nullable().optional(),
  budgetAmount: z.number().min(0).max(1_000_000).nullable().optional(),
});

export type PersonInput = z.infer<typeof personInputSchema>;
export type EventInput = z.infer<typeof eventInputSchema>;

function requireProfile(session: SessionContext): string {
  if (session.user.role === "admin") throw new Rejection("forbidden", "Un administrateur n'a pas de calendrier d'occasions.", 403);
  return session.user.id;
}

function checkDay(day: number, month: number, year: number | null | undefined): void {
  const daysInMonth = new Date(Date.UTC(year ?? 2024, month, 0)).getUTCDate(); // 2024 : bissextile, accepte le 29/02 sans année
  if (day > daysInMonth) throw new Rejection("invalid_date", "Ce jour n'existe pas dans ce mois.");
}

function translate(error: unknown): never {
  if (error instanceof NotFound) throw new Rejection("not_found", error.message, 404);
  if (error instanceof VersionConflict) throw new Rejection("conflict", error.message, 409);
  throw error;
}

export async function monthView(ctx: Ctx, session: SessionContext, year: number, month: number, store: GiftStore = giftStore(ctx.db)): Promise<MonthView> {
  const userId = requireProfile(session);
  if (!Number.isInteger(year) || year < 1900 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) throw new Rejection("invalid_month", "Mois invalide.");
  const [people, events, states] = await Promise.all([store.listPeople(userId), store.listEvents(userId), store.listStates(userId)]);
  return {
    year,
    month,
    today: localDate(ctx.now, session.device.timezone),
    items: occurrencesInMonth({ people, events, states }, year, month),
    people: people.map((p) => ({ id: p.id, name: p.name, relationship: p.relationship })).sort((a, b) => a.name.localeCompare(b.name, "fr")),
  };
}

export async function createPerson(ctx: Ctx, session: SessionContext, input: PersonInput, store: GiftStore = giftStore(ctx.db)): Promise<Person> {
  const userId = requireProfile(session);
  if ((input.birthDay == null) !== (input.birthMonth == null)) throw new Rejection("invalid_date", "Indiquez le jour et le mois de l'anniversaire.");
  if (input.birthDay != null && input.birthMonth != null) checkDay(input.birthDay, input.birthMonth, input.birthYear);
  return store.createPerson(userId, {
    name: input.name,
    relationship: input.relationship ?? null,
    birthDay: input.birthDay ?? null,
    birthMonth: input.birthMonth ?? null,
    birthYear: input.birthYear ?? null,
    budgetAmount: input.budgetAmount ?? null,
    details: { ...(input.interests ? { interests: input.interests } : {}), ...(input.notes ? { notes: input.notes } : {}) },
  });
}

export async function updatePerson(ctx: Ctx, session: SessionContext, personId: string, input: Partial<PersonInput>, store: GiftStore = giftStore(ctx.db)): Promise<Person> {
  const userId = requireProfile(session);
  if (input.birthDay != null && input.birthMonth != null) checkDay(input.birthDay, input.birthMonth, input.birthYear);
  try {
    return await store.updatePerson(userId, personId, {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.relationship !== undefined ? { relationship: input.relationship } : {}),
      ...(input.birthDay !== undefined ? { birthDay: input.birthDay } : {}),
      ...(input.birthMonth !== undefined ? { birthMonth: input.birthMonth } : {}),
      ...(input.birthYear !== undefined ? { birthYear: input.birthYear } : {}),
      ...(input.budgetAmount !== undefined ? { budgetAmount: input.budgetAmount } : {}),
      ...(input.interests !== undefined || input.notes !== undefined ? { details: { ...(input.interests !== undefined ? { interests: input.interests } : {}), ...(input.notes !== undefined ? { notes: input.notes ?? undefined } : {}) } } : {}),
    });
  } catch (error) {
    translate(error);
  }
}

/** Effacement doux : annulable 30 jours depuis le tchat (« annule la suppression »). */
export async function deletePerson(ctx: Ctx, session: SessionContext, personId: string, store: GiftStore = giftStore(ctx.db)): Promise<void> {
  const userId = requireProfile(session);
  try {
    await store.deletePerson(userId, personId);
  } catch (error) {
    translate(error);
  }
}

export async function createEvent(ctx: Ctx, session: SessionContext, input: EventInput, store: GiftStore = giftStore(ctx.db)): Promise<GiftEvent> {
  const userId = requireProfile(session);
  checkDay(input.eventDay, input.eventMonth, input.eventYear);
  if (input.personId && !(await store.listPeople(userId)).some((p) => p.id === input.personId)) throw new Rejection("not_found", "Ce proche est introuvable.", 404);
  return store.createEvent(userId, { title: input.title, kind: input.kind, eventDay: input.eventDay, eventMonth: input.eventMonth, eventYear: input.eventYear ?? null, personId: input.personId ?? null, budgetAmount: input.budgetAmount ?? null });
}

export async function updateEvent(ctx: Ctx, session: SessionContext, eventId: string, input: Partial<EventInput>, store: GiftStore = giftStore(ctx.db)): Promise<GiftEvent> {
  const userId = requireProfile(session);
  if (input.eventDay !== undefined && input.eventMonth !== undefined) checkDay(input.eventDay, input.eventMonth, input.eventYear);
  try {
    return await store.updateEvent(userId, eventId, {
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.eventDay !== undefined ? { eventDay: input.eventDay } : {}),
      ...(input.eventMonth !== undefined ? { eventMonth: input.eventMonth } : {}),
      ...(input.eventYear !== undefined ? { eventYear: input.eventYear } : {}),
      ...(input.personId !== undefined ? { personId: input.personId } : {}),
      ...(input.budgetAmount !== undefined ? { budgetAmount: input.budgetAmount } : {}),
    });
  } catch (error) {
    translate(error);
  }
}

export async function deleteEvent(ctx: Ctx, session: SessionContext, eventId: string, store: GiftStore = giftStore(ctx.db)): Promise<void> {
  const userId = requireProfile(session);
  try {
    await store.deleteEvent(userId, eventId);
  } catch (error) {
    translate(error);
  }
}
