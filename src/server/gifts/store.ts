import { randomUUID } from "node:crypto";
import type { GiftEvent, Idea, IdeaStatus, OccasionState, Person, PersonDetails } from "./model";

/**
 * Persistance des données de kdo_help pour un profil. Deux implémentations : la base (db-store.ts) et une
 * version en mémoire (tests unitaires, évaluations sans base).
 */

export interface PersonInput {
  name: string;
  relationship?: string | null;
  birthDay?: number | null;
  birthMonth?: number | null;
  birthYear?: number | null;
  budgetAmount?: number | null;
  details?: PersonDetails;
}

export interface EventInput {
  personId?: string | null;
  kind: string;
  title: string;
  eventDay: number;
  eventMonth: number;
  eventYear?: number | null;
  budgetAmount?: number | null;
}

export interface IdeaInput {
  personId: string | null;
  occasionKey: string | null;
  title: string;
  why: string;
  priceMin: number | null;
  priceMax: number | null;
}

export interface GiftStore {
  listPeople(userId: string, options?: { includeDeleted?: boolean }): Promise<Person[]>;
  createPerson(userId: string, input: PersonInput): Promise<Person>;
  updatePerson(userId: string, personId: string, patch: Partial<PersonInput>, expectedVersion?: number): Promise<Person>;
  /** Effacement doux ; `restore` annule. */
  deletePerson(userId: string, personId: string): Promise<void>;
  restorePerson(userId: string, personId: string): Promise<Person | null>;

  listEvents(userId: string, options?: { includeDeleted?: boolean }): Promise<GiftEvent[]>;
  createEvent(userId: string, input: EventInput): Promise<GiftEvent>;
  updateEvent(userId: string, eventId: string, patch: Partial<EventInput>, expectedVersion?: number): Promise<GiftEvent>;
  deleteEvent(userId: string, eventId: string): Promise<void>;
  restoreEvent(userId: string, eventId: string): Promise<GiftEvent | null>;

  listStates(userId: string): Promise<OccasionState[]>;
  setState(userId: string, occasionKey: string, patch: { sortedAt?: string | null; snoozedUntil?: string | null }): Promise<OccasionState>;

  listIdeas(userId: string, options?: { personId?: string | null; limit?: number }): Promise<Idea[]>;
  addIdeas(userId: string, ideas: IdeaInput[]): Promise<Idea[]>;
  setIdeaStatus(userId: string, ideaId: string, status: IdeaStatus): Promise<Idea | null>;

  /** Supprime définitivement les effacements doux plus vieux que la date donnée. */
  purgeDeleted(before: Date): Promise<number>;
}

export class VersionConflict extends Error {
  constructor() {
    super("La fiche a été modifiée entre-temps : relisez-la avant de la changer.");
    this.name = "VersionConflict";
  }
}

export class NotFound extends Error {
  constructor(what: string) {
    super(`${what} introuvable.`);
    this.name = "NotFound";
  }
}

/** Version en mémoire, par profil. */
export class MemoryGiftStore implements GiftStore {
  private readonly people = new Map<string, Person[]>();
  private readonly events = new Map<string, GiftEvent[]>();
  private readonly states = new Map<string, OccasionState[]>();
  private readonly ideas = new Map<string, Idea[]>();
  constructor(private readonly now: () => Date = () => new Date()) {}

  private of<T>(map: Map<string, T[]>, userId: string): T[] {
    const list = map.get(userId) ?? [];
    map.set(userId, list);
    return list;
  }

  async listPeople(userId: string, options: { includeDeleted?: boolean } = {}): Promise<Person[]> {
    return this.of(this.people, userId)
      .filter((p) => options.includeDeleted || !p.deletedAt)
      .map((p) => structuredClone(p));
  }

  async createPerson(userId: string, input: PersonInput): Promise<Person> {
    const person: Person = {
      id: randomUUID(),
      name: input.name.trim(),
      relationship: input.relationship ?? null,
      birthDay: input.birthDay ?? null,
      birthMonth: input.birthMonth ?? null,
      birthYear: input.birthYear ?? null,
      budgetAmount: input.budgetAmount ?? null,
      details: input.details ?? {},
      version: 1,
      deletedAt: null,
    };
    this.of(this.people, userId).push(person);
    return structuredClone(person);
  }

  async updatePerson(userId: string, personId: string, patch: Partial<PersonInput>, expectedVersion?: number): Promise<Person> {
    const person = this.of(this.people, userId).find((p) => p.id === personId && !p.deletedAt);
    if (!person) throw new NotFound("Ce proche");
    if (expectedVersion !== undefined && person.version !== expectedVersion) throw new VersionConflict();
    if (patch.name !== undefined) person.name = patch.name.trim();
    if (patch.relationship !== undefined) person.relationship = patch.relationship;
    if (patch.birthDay !== undefined) person.birthDay = patch.birthDay;
    if (patch.birthMonth !== undefined) person.birthMonth = patch.birthMonth;
    if (patch.birthYear !== undefined) person.birthYear = patch.birthYear;
    if (patch.budgetAmount !== undefined) person.budgetAmount = patch.budgetAmount;
    if (patch.details !== undefined) person.details = { ...person.details, ...patch.details };
    person.version += 1;
    return structuredClone(person);
  }

  async deletePerson(userId: string, personId: string): Promise<void> {
    const person = this.of(this.people, userId).find((p) => p.id === personId && !p.deletedAt);
    if (!person) throw new NotFound("Ce proche");
    const at = this.now().toISOString();
    person.deletedAt = at;
    for (const event of this.of(this.events, userId)) if (event.personId === personId && !event.deletedAt) event.deletedAt = at;
  }

  async restorePerson(userId: string, personId: string): Promise<Person | null> {
    const person = this.of(this.people, userId).find((p) => p.id === personId && p.deletedAt);
    if (!person) return null;
    const at = person.deletedAt;
    person.deletedAt = null;
    for (const event of this.of(this.events, userId)) if (event.personId === personId && event.deletedAt === at) event.deletedAt = null;
    return structuredClone(person);
  }

  async listEvents(userId: string, options: { includeDeleted?: boolean } = {}): Promise<GiftEvent[]> {
    return this.of(this.events, userId)
      .filter((e) => options.includeDeleted || !e.deletedAt)
      .map((e) => structuredClone(e));
  }

  async createEvent(userId: string, input: EventInput): Promise<GiftEvent> {
    const event: GiftEvent = {
      id: randomUUID(),
      personId: input.personId ?? null,
      kind: input.kind,
      title: input.title.trim(),
      eventDay: input.eventDay,
      eventMonth: input.eventMonth,
      eventYear: input.eventYear ?? null,
      budgetAmount: input.budgetAmount ?? null,
      version: 1,
      deletedAt: null,
    };
    this.of(this.events, userId).push(event);
    return structuredClone(event);
  }

  async updateEvent(userId: string, eventId: string, patch: Partial<EventInput>, expectedVersion?: number): Promise<GiftEvent> {
    const event = this.of(this.events, userId).find((e) => e.id === eventId && !e.deletedAt);
    if (!event) throw new NotFound("Cette occasion");
    if (expectedVersion !== undefined && event.version !== expectedVersion) throw new VersionConflict();
    if (patch.personId !== undefined) event.personId = patch.personId;
    if (patch.kind !== undefined) event.kind = patch.kind;
    if (patch.title !== undefined) event.title = patch.title.trim();
    if (patch.eventDay !== undefined) event.eventDay = patch.eventDay;
    if (patch.eventMonth !== undefined) event.eventMonth = patch.eventMonth;
    if (patch.eventYear !== undefined) event.eventYear = patch.eventYear;
    if (patch.budgetAmount !== undefined) event.budgetAmount = patch.budgetAmount;
    event.version += 1;
    return structuredClone(event);
  }

  async deleteEvent(userId: string, eventId: string): Promise<void> {
    const event = this.of(this.events, userId).find((e) => e.id === eventId && !e.deletedAt);
    if (!event) throw new NotFound("Cette occasion");
    event.deletedAt = this.now().toISOString();
  }

  async restoreEvent(userId: string, eventId: string): Promise<GiftEvent | null> {
    const event = this.of(this.events, userId).find((e) => e.id === eventId && e.deletedAt);
    if (!event) return null;
    event.deletedAt = null;
    return structuredClone(event);
  }

  async listStates(userId: string): Promise<OccasionState[]> {
    return this.of(this.states, userId).map((s) => ({ ...s }));
  }

  async setState(userId: string, occasionKey: string, patch: { sortedAt?: string | null; snoozedUntil?: string | null }): Promise<OccasionState> {
    const list = this.of(this.states, userId);
    let state = list.find((s) => s.occasionKey === occasionKey);
    if (!state) {
      state = { occasionKey, sortedAt: null, snoozedUntil: null };
      list.push(state);
    }
    if (patch.sortedAt !== undefined) state.sortedAt = patch.sortedAt;
    if (patch.snoozedUntil !== undefined) state.snoozedUntil = patch.snoozedUntil;
    return { ...state };
  }

  async listIdeas(userId: string, options: { personId?: string | null; limit?: number } = {}): Promise<Idea[]> {
    return this.of(this.ideas, userId)
      .filter((i) => options.personId === undefined || i.personId === options.personId)
      .slice()
      .reverse()
      .slice(0, options.limit ?? 50)
      .map((i) => ({ ...i }));
  }

  async addIdeas(userId: string, ideas: IdeaInput[]): Promise<Idea[]> {
    const at = this.now().toISOString();
    const created = ideas.map<Idea>((input) => ({ id: randomUUID(), status: "suggested", suggestedAt: at, ...input }));
    this.of(this.ideas, userId).push(...created);
    return created.map((i) => ({ ...i }));
  }

  async setIdeaStatus(userId: string, ideaId: string, status: IdeaStatus): Promise<Idea | null> {
    const idea = this.of(this.ideas, userId).find((i) => i.id === ideaId);
    if (!idea) return null;
    idea.status = status;
    return { ...idea };
  }

  async purgeDeleted(before: Date): Promise<number> {
    let count = 0;
    for (const [userId, list] of this.people) {
      const kept = list.filter((p) => !p.deletedAt || new Date(p.deletedAt) >= before);
      count += list.length - kept.length;
      this.people.set(userId, kept);
    }
    for (const [userId, list] of this.events) {
      const kept = list.filter((e) => !e.deletedAt || new Date(e.deletedAt) >= before);
      count += list.length - kept.length;
      this.events.set(userId, kept);
    }
    return count;
  }
}
