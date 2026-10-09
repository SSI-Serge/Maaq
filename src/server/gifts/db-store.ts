import { sql, type Kysely } from "kysely";
import type { DB } from "@/server/db/schema.generated";
import type { GiftEvent, Idea, IdeaStatus, OccasionState, Person, PersonDetails } from "./model";
import { NotFound, VersionConflict, type EventInput, type GiftStore, type IdeaInput, type PersonInput } from "./store";

type Db = Kysely<DB>;

function num(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function iso(value: Date | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

type PersonRow = { id: string; name: string; relationship: string | null; birth_day: number | null; birth_month: number | null; birth_year: number | null; budget_amount: string | number | null; details: unknown; version: number; deleted_at: Date | null };
type EventRow = { id: string; person_id: string | null; kind: string; title: string; event_day: number; event_month: number; event_year: number | null; budget_amount: string | number | null; version: number; deleted_at: Date | null };
type IdeaRow = { id: string; person_id: string | null; occasion_key: string | null; title: string; why: string; price_min: string | number | null; price_max: string | number | null; status: IdeaStatus; suggested_at: Date };

function toPerson(row: PersonRow): Person {
  return {
    id: row.id,
    name: row.name,
    relationship: row.relationship,
    birthDay: row.birth_day,
    birthMonth: row.birth_month,
    birthYear: row.birth_year,
    budgetAmount: num(row.budget_amount),
    details: (row.details ?? {}) as PersonDetails,
    version: row.version,
    deletedAt: iso(row.deleted_at),
  };
}

function toEvent(row: EventRow): GiftEvent {
  return {
    id: row.id,
    personId: row.person_id,
    kind: row.kind,
    title: row.title,
    eventDay: row.event_day,
    eventMonth: row.event_month,
    eventYear: row.event_year,
    budgetAmount: num(row.budget_amount),
    version: row.version,
    deletedAt: iso(row.deleted_at),
  };
}

function toIdea(row: IdeaRow): Idea {
  return {
    id: row.id,
    personId: row.person_id,
    occasionKey: row.occasion_key,
    title: row.title,
    why: row.why,
    priceMin: num(row.price_min),
    priceMax: num(row.price_max),
    status: row.status,
    suggestedAt: new Date(row.suggested_at).toISOString(),
  };
}

/** Persistance en base des données de kdo_help (tables gift_*). */
export class DbGiftStore implements GiftStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listPeople(userId: string, options: { includeDeleted?: boolean } = {}): Promise<Person[]> {
    let query = this.db.selectFrom("gift_people").selectAll().where("user_id", "=", userId);
    if (!options.includeDeleted) query = query.where("deleted_at", "is", null);
    return (await query.orderBy("created_at").execute()).map(toPerson);
  }

  async createPerson(userId: string, input: PersonInput): Promise<Person> {
    const row = await this.db
      .insertInto("gift_people")
      .values({
        user_id: userId,
        name: input.name.trim(),
        relationship: input.relationship ?? null,
        birth_day: input.birthDay ?? null,
        birth_month: input.birthMonth ?? null,
        birth_year: input.birthYear ?? null,
        budget_amount: input.budgetAmount ?? null,
        details: sql`${JSON.stringify(input.details ?? {})}::jsonb`,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toPerson(row);
  }

  async updatePerson(userId: string, personId: string, patch: Partial<PersonInput>, expectedVersion?: number): Promise<Person> {
    const current = await this.db.selectFrom("gift_people").selectAll().where("id", "=", personId).where("user_id", "=", userId).where("deleted_at", "is", null).executeTakeFirst();
    if (!current) throw new NotFound("Ce proche");
    if (expectedVersion !== undefined && current.version !== expectedVersion) throw new VersionConflict();
    const details = patch.details === undefined ? undefined : { ...((current.details ?? {}) as PersonDetails), ...patch.details };
    const row = await this.db
      .updateTable("gift_people")
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() } : {}),
        ...(patch.relationship !== undefined ? { relationship: patch.relationship } : {}),
        ...(patch.birthDay !== undefined ? { birth_day: patch.birthDay } : {}),
        ...(patch.birthMonth !== undefined ? { birth_month: patch.birthMonth } : {}),
        ...(patch.birthYear !== undefined ? { birth_year: patch.birthYear } : {}),
        ...(patch.budgetAmount !== undefined ? { budget_amount: patch.budgetAmount } : {}),
        ...(details !== undefined ? { details: sql`${JSON.stringify(details)}::jsonb` } : {}),
        version: current.version + 1,
        updated_at: this.now(),
      })
      .where("id", "=", personId)
      .where("version", "=", current.version)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new VersionConflict();
    return toPerson(row);
  }

  async deletePerson(userId: string, personId: string): Promise<void> {
    const at = this.now();
    const deleted = await this.db.updateTable("gift_people").set({ deleted_at: at, updated_at: at }).where("id", "=", personId).where("user_id", "=", userId).where("deleted_at", "is", null).returning("id").executeTakeFirst();
    if (!deleted) throw new NotFound("Ce proche");
    await this.db.updateTable("gift_events").set({ deleted_at: at, updated_at: at }).where("person_id", "=", personId).where("deleted_at", "is", null).execute();
  }

  async restorePerson(userId: string, personId: string): Promise<Person | null> {
    const current = await this.db.selectFrom("gift_people").selectAll().where("id", "=", personId).where("user_id", "=", userId).where("deleted_at", "is not", null).executeTakeFirst();
    if (!current) return null;
    const at = this.now();
    const row = await this.db.updateTable("gift_people").set({ deleted_at: null, updated_at: at }).where("id", "=", personId).returningAll().executeTakeFirstOrThrow();
    await this.db.updateTable("gift_events").set({ deleted_at: null, updated_at: at }).where("person_id", "=", personId).where("deleted_at", "=", current.deleted_at!).execute();
    return toPerson(row);
  }

  async listEvents(userId: string, options: { includeDeleted?: boolean } = {}): Promise<GiftEvent[]> {
    let query = this.db.selectFrom("gift_events").selectAll().where("user_id", "=", userId);
    if (!options.includeDeleted) query = query.where("deleted_at", "is", null);
    return (await query.orderBy("created_at").execute()).map(toEvent);
  }

  async createEvent(userId: string, input: EventInput): Promise<GiftEvent> {
    const row = await this.db
      .insertInto("gift_events")
      .values({
        user_id: userId,
        person_id: input.personId ?? null,
        kind: input.kind,
        title: input.title.trim(),
        event_day: input.eventDay,
        event_month: input.eventMonth,
        event_year: input.eventYear ?? null,
        budget_amount: input.budgetAmount ?? null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toEvent(row);
  }

  async updateEvent(userId: string, eventId: string, patch: Partial<EventInput>, expectedVersion?: number): Promise<GiftEvent> {
    const current = await this.db.selectFrom("gift_events").select(["version"]).where("id", "=", eventId).where("user_id", "=", userId).where("deleted_at", "is", null).executeTakeFirst();
    if (!current) throw new NotFound("Cette occasion");
    if (expectedVersion !== undefined && current.version !== expectedVersion) throw new VersionConflict();
    const row = await this.db
      .updateTable("gift_events")
      .set({
        ...(patch.personId !== undefined ? { person_id: patch.personId } : {}),
        ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
        ...(patch.title !== undefined ? { title: patch.title.trim() } : {}),
        ...(patch.eventDay !== undefined ? { event_day: patch.eventDay } : {}),
        ...(patch.eventMonth !== undefined ? { event_month: patch.eventMonth } : {}),
        ...(patch.eventYear !== undefined ? { event_year: patch.eventYear } : {}),
        ...(patch.budgetAmount !== undefined ? { budget_amount: patch.budgetAmount } : {}),
        version: current.version + 1,
        updated_at: this.now(),
      })
      .where("id", "=", eventId)
      .where("version", "=", current.version)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new VersionConflict();
    return toEvent(row);
  }

  async deleteEvent(userId: string, eventId: string): Promise<void> {
    const at = this.now();
    const deleted = await this.db.updateTable("gift_events").set({ deleted_at: at, updated_at: at }).where("id", "=", eventId).where("user_id", "=", userId).where("deleted_at", "is", null).returning("id").executeTakeFirst();
    if (!deleted) throw new NotFound("Cette occasion");
  }

  async restoreEvent(userId: string, eventId: string): Promise<GiftEvent | null> {
    const row = await this.db.updateTable("gift_events").set({ deleted_at: null, updated_at: this.now() }).where("id", "=", eventId).where("user_id", "=", userId).where("deleted_at", "is not", null).returningAll().executeTakeFirst();
    return row ? toEvent(row) : null;
  }

  async listStates(userId: string): Promise<OccasionState[]> {
    const rows = await this.db.selectFrom("gift_occasion_states").selectAll().where("user_id", "=", userId).execute();
    return rows.map((r) => ({ occasionKey: r.occasion_key, sortedAt: iso(r.sorted_at), snoozedUntil: r.snoozed_until ? new Date(r.snoozed_until).toISOString().slice(0, 10) : null }));
  }

  async setState(userId: string, occasionKey: string, patch: { sortedAt?: string | null; snoozedUntil?: string | null }): Promise<OccasionState> {
    const at = this.now();
    const row = await this.db
      .insertInto("gift_occasion_states")
      .values({ user_id: userId, occasion_key: occasionKey, sorted_at: patch.sortedAt ?? null, snoozed_until: patch.snoozedUntil ?? null, updated_at: at })
      .onConflict((oc) =>
        oc.columns(["user_id", "occasion_key"]).doUpdateSet({
          ...(patch.sortedAt !== undefined ? { sorted_at: patch.sortedAt } : {}),
          ...(patch.snoozedUntil !== undefined ? { snoozed_until: patch.snoozedUntil } : {}),
          updated_at: at,
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return { occasionKey: row.occasion_key, sortedAt: iso(row.sorted_at), snoozedUntil: row.snoozed_until ? new Date(row.snoozed_until).toISOString().slice(0, 10) : null };
  }

  async listIdeas(userId: string, options: { personId?: string | null; limit?: number } = {}): Promise<Idea[]> {
    let query = this.db.selectFrom("gift_ideas").selectAll().where("user_id", "=", userId);
    if (options.personId !== undefined) query = options.personId === null ? query.where("person_id", "is", null) : query.where("person_id", "=", options.personId);
    return (await query.orderBy("suggested_at", "desc").limit(options.limit ?? 50).execute()).map(toIdea);
  }

  async addIdeas(userId: string, ideas: IdeaInput[]): Promise<Idea[]> {
    if (ideas.length === 0) return [];
    const rows = await this.db
      .insertInto("gift_ideas")
      .values(ideas.map((i) => ({ user_id: userId, person_id: i.personId, occasion_key: i.occasionKey, title: i.title, why: i.why, price_min: i.priceMin, price_max: i.priceMax, suggested_at: this.now() })))
      .returningAll()
      .execute();
    return rows.map(toIdea);
  }

  async setIdeaStatus(userId: string, ideaId: string, status: IdeaStatus): Promise<Idea | null> {
    const row = await this.db.updateTable("gift_ideas").set({ status, updated_at: this.now() }).where("id", "=", ideaId).where("user_id", "=", userId).returningAll().executeTakeFirst();
    return row ? toIdea(row) : null;
  }

  async purgeDeleted(before: Date): Promise<number> {
    const events = await this.db.deleteFrom("gift_events").where("deleted_at", "<", before).executeTakeFirst();
    const people = await this.db.deleteFrom("gift_people").where("deleted_at", "<", before).executeTakeFirst();
    return Number(events.numDeletedRows) + Number(people.numDeletedRows);
  }
}
