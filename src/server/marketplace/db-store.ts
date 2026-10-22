import { sql, type Kysely } from "kysely";
import type { DB } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { decrypt, encrypt } from "@/server/security/crypto";
import { groupFilled, touchedGroups, type FieldGroup, type Provenance, type ProvenanceEntry, type ServiceCategory, type Storefront, type StorefrontFields } from "./model";
import { GroupEmpty, StorefrontNotFound, type StateChange, type StorefrontStore } from "./store";

type Db = Kysely<DB>;

/** Chiffrement du contact révélé après mise en relation ; par défaut la clé ENCRYPTION_KEY de l'application. */
export interface Cipher {
  encrypt(plain: string): Buffer;
  decrypt(payload: Buffer): string;
}

export function appCipher(): Cipher {
  const key = () => Buffer.from(env().ENCRYPTION_KEY, "base64");
  return { encrypt: (plain) => encrypt(plain, key()), decrypt: (payload) => decrypt(payload, key()) };
}

function num(value: string | number | null): number | null {
  return value === null ? null : Number(value);
}

function iso(value: Date | string | null): string | null {
  return value ? new Date(value).toISOString() : null;
}

function day(value: Date | string | null): string | null {
  if (!value) return null;
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

type Row = {
  id: string;
  user_id: string;
  status: Storefront["status"];
  display_name: string | null;
  category_code: string | null;
  services: unknown;
  description: string | null;
  postcode: string | null;
  city: string | null;
  modes: unknown;
  travel_areas: unknown;
  travel_note: string | null;
  availability_mode: string | null;
  availability_text: string | null;
  price_mode: string | null;
  price_min: string | number | null;
  price_max: string | number | null;
  languages: unknown;
  notice_text: string | null;
  qualifications_text: string | null;
  contact_method: Storefront["contactMethod"];
  contact_value_encrypted: Buffer | null;
  paused_until: Date | string | null;
  searchable: boolean;
  provenance: unknown;
  last_confirmed_at: Date | null;
  published_at: Date | null;
  version: number;
  created_at: Date;
  updated_at: Date;
};

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);

/** Persistance en base de la vitrine (table storefronts). */
export class DbStorefrontStore implements StorefrontStore {
  constructor(
    private readonly db: Db,
    private readonly cipher: Cipher = appCipher(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  private toStorefront(row: Row): Storefront {
    return {
      id: row.id,
      userId: row.user_id,
      status: row.status,
      displayName: row.display_name,
      categoryCode: row.category_code,
      services: strings(row.services),
      description: row.description,
      postcode: row.postcode,
      city: row.city,
      modes: strings(row.modes) as Storefront["modes"],
      travelAreas: strings(row.travel_areas),
      travelNote: row.travel_note,
      availabilityMode: row.availability_mode as Storefront["availabilityMode"],
      availabilityText: row.availability_text,
      priceMode: row.price_mode as Storefront["priceMode"],
      priceMin: num(row.price_min),
      priceMax: num(row.price_max),
      languages: strings(row.languages),
      noticeText: row.notice_text,
      qualificationsText: row.qualifications_text,
      contactMethod: row.contact_method,
      contactValue: row.contact_value_encrypted ? this.cipher.decrypt(Buffer.from(row.contact_value_encrypted)) : null,
      pausedUntil: day(row.paused_until),
      searchable: row.searchable,
      provenance: (row.provenance ?? {}) as Partial<Record<FieldGroup, ProvenanceEntry>>,
      lastConfirmedAt: iso(row.last_confirmed_at),
      publishedAt: iso(row.published_at),
      version: row.version,
      createdAt: new Date(row.created_at).toISOString(),
      updatedAt: new Date(row.updated_at).toISOString(),
    };
  }

  private columns(patch: Partial<StorefrontFields>) {
    const json = (value: string[]) => sql<string[]>`${JSON.stringify(value)}::jsonb`;
    return {
      ...(patch.displayName !== undefined ? { display_name: patch.displayName?.trim() ?? null } : {}),
      ...(patch.categoryCode !== undefined ? { category_code: patch.categoryCode } : {}),
      ...(patch.services !== undefined ? { services: json(patch.services) } : {}),
      ...(patch.description !== undefined ? { description: patch.description?.trim() ?? null } : {}),
      ...(patch.postcode !== undefined ? { postcode: patch.postcode } : {}),
      ...(patch.city !== undefined ? { city: patch.city?.trim() ?? null } : {}),
      ...(patch.modes !== undefined ? { modes: json(patch.modes) } : {}),
      ...(patch.travelAreas !== undefined ? { travel_areas: json(patch.travelAreas) } : {}),
      ...(patch.travelNote !== undefined ? { travel_note: patch.travelNote } : {}),
      ...(patch.availabilityMode !== undefined ? { availability_mode: patch.availabilityMode } : {}),
      ...(patch.availabilityText !== undefined ? { availability_text: patch.availabilityText } : {}),
      ...(patch.priceMode !== undefined ? { price_mode: patch.priceMode } : {}),
      ...(patch.priceMin !== undefined ? { price_min: patch.priceMin } : {}),
      ...(patch.priceMax !== undefined ? { price_max: patch.priceMax } : {}),
      ...(patch.languages !== undefined ? { languages: json(patch.languages) } : {}),
      ...(patch.noticeText !== undefined ? { notice_text: patch.noticeText } : {}),
      ...(patch.qualificationsText !== undefined ? { qualifications_text: patch.qualificationsText } : {}),
      ...(patch.contactMethod !== undefined ? { contact_method: patch.contactMethod } : {}),
      ...(patch.contactValue !== undefined ? { contact_value_encrypted: patch.contactValue ? this.cipher.encrypt(patch.contactValue.trim()) : null } : {}),
    };
  }

  async get(userId: string): Promise<Storefront | null> {
    const row = await this.db.selectFrom("storefronts").selectAll().where("user_id", "=", userId).executeTakeFirst();
    return row ? this.toStorefront(row as Row) : null;
  }

  async getById(id: string): Promise<Storefront | null> {
    const row = await this.db.selectFrom("storefronts").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? this.toStorefront(row as Row) : null;
  }

  async save(userId: string, patch: Partial<StorefrontFields>, origin: Partial<Record<FieldGroup, Provenance>> = {}): Promise<Storefront> {
    const at = this.now();
    const current = await this.db.selectFrom("storefronts").select(["id", "version", "provenance"]).where("user_id", "=", userId).executeTakeFirst();
    const provenance = { ...((current?.provenance ?? {}) as Partial<Record<FieldGroup, ProvenanceEntry>>) };
    for (const group of touchedGroups(patch)) provenance[group] = { source: origin[group] ?? "stated", at: at.toISOString() };
    const columns = { ...this.columns(patch), provenance: sql<Record<string, string>>`${JSON.stringify(provenance)}::jsonb`, updated_at: at };

    const row = current
      ? await this.db.updateTable("storefronts").set({ ...columns, version: current.version + 1 }).where("id", "=", current.id).returningAll().executeTakeFirstOrThrow()
      : await this.db
          .insertInto("storefronts")
          .values({ user_id: userId, ...columns, created_at: at })
          .returningAll()
          .executeTakeFirstOrThrow();
    return this.toStorefront(row as Row);
  }

  async confirm(userId: string, groups: FieldGroup[]): Promise<Storefront> {
    const current = await this.get(userId);
    if (!current) throw new StorefrontNotFound();
    const at = this.now();
    const provenance = { ...current.provenance };
    for (const group of groups) {
      if (!groupFilled(current, group)) throw new GroupEmpty(group);
      provenance[group] = { source: "confirmed", at: at.toISOString() };
    }
    const row = await this.db
      .updateTable("storefronts")
      .set({ provenance: sql<Record<string, string>>`${JSON.stringify(provenance)}::jsonb`, last_confirmed_at: at, updated_at: at, version: current.version + 1 })
      .where("id", "=", current.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    return this.toStorefront(row as Row);
  }

  async setState(userId: string, change: StateChange): Promise<Storefront> {
    const at = this.now();
    const row = await this.db
      .updateTable("storefronts")
      .set({
        ...(change.status !== undefined ? { status: change.status } : {}),
        ...(change.pausedUntil !== undefined ? { paused_until: change.pausedUntil } : {}),
        ...(change.publishedAt !== undefined ? { published_at: change.publishedAt ? new Date(change.publishedAt) : null } : {}),
        ...(change.lastConfirmedAt !== undefined ? { last_confirmed_at: change.lastConfirmedAt ? new Date(change.lastConfirmedAt) : null } : {}),
        updated_at: at,
        version: sql`version + 1`,
      })
      .where("user_id", "=", userId)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new StorefrontNotFound();
    return this.toStorefront(row as Row);
  }

  async listCategories(): Promise<ServiceCategory[]> {
    return this.db.selectFrom("service_categories").select(["code", "label"]).where("is_active", "=", true).orderBy("sort_order").orderBy("code").execute();
  }

  async listEligible(today: string): Promise<Storefront[]> {
    const rows = await this.db
      .selectFrom("storefronts")
      .selectAll()
      .where("status", "=", "published")
      .where((eb) => eb.or([eb("paused_until", "is", null), eb("paused_until", "<", sql<Date>`${today}::date`)]))
      .orderBy("published_at")
      .execute();
    return rows.map((row) => this.toStorefront(row as Row));
  }
}
