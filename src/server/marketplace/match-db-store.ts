import { sql, type Kysely } from "kysely";
import type { DB } from "@/server/db/schema.generated";
import type { ServiceCategory } from "./model";
import {
  ACTIVE_SUGGESTION,
  DEFAULT_PREFS,
  IntroductionNotFound,
  IntroductionOpen,
  ReportNotFound,
  OPEN_INTRODUCTION,
  RequestNotFound,
  SuggestionNotFound,
  type BlockedStorefronts,
  type BuyerProfile,
  type EligibleFilter,
  type EligibleStorefront,
  type Introduction,
  type IntroductionInput,
  type IntroductionPatch,
  type ListingReport,
  type MarketplacePrefs,
  type ReportInput,
  type ReportStatus,
  type MatchLogEntry,
  type MatchStore,
  type PrefsPatch,
  type RequestInput,
  type RequestPatch,
  type RequestStatus,
  type ServiceRequest,
  type Suggestion,
  type SuggestionInput,
  type SuggestionStatus,
} from "./match-store";

type Db = Kysely<DB>;

const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
const iso = (value: Date | string | null): string | null => (value ? new Date(value).toISOString() : null);
const num = (value: string | number | null): number | null => (value === null ? null : Number(value));

type EligibleRow = {
  id: string | null;
  user_id: string | null;
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
  contact_method: EligibleStorefront["contactMethod"];
  last_confirmed_at: Date | null;
  published_at: Date | null;
};

function toEligible(row: EligibleRow): EligibleStorefront {
  return {
    id: row.id!,
    userId: row.user_id!,
    displayName: row.display_name,
    categoryCode: row.category_code,
    services: strings(row.services),
    description: row.description,
    postcode: row.postcode,
    city: row.city,
    modes: strings(row.modes) as EligibleStorefront["modes"],
    travelAreas: strings(row.travel_areas),
    travelNote: row.travel_note,
    availabilityMode: row.availability_mode as EligibleStorefront["availabilityMode"],
    availabilityText: row.availability_text,
    priceMode: row.price_mode as EligibleStorefront["priceMode"],
    priceMin: num(row.price_min),
    priceMax: num(row.price_max),
    languages: strings(row.languages),
    noticeText: row.notice_text,
    qualificationsText: row.qualifications_text,
    contactMethod: row.contact_method,
    lastConfirmedAt: iso(row.last_confirmed_at),
    publishedAt: iso(row.published_at),
  };
}

type RequestRow = {
  id: string;
  user_id: string;
  text: string;
  category_code: string | null;
  postcode: string | null;
  remote_ok: boolean;
  timing_text: string | null;
  source: string;
  agenda_event_key: string | null;
  agenda_event_date: Date | string | null;
  status: RequestStatus;
  notify_later: boolean;
  last_matched_at: Date | null;
  match_log: unknown;
  closed_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

function toRequest(row: RequestRow): ServiceRequest {
  return {
    id: row.id,
    userId: row.user_id,
    text: row.text,
    categoryCode: row.category_code,
    postcode: row.postcode,
    remoteOk: row.remote_ok,
    timingText: row.timing_text,
    source: row.source as ServiceRequest["source"],
    agendaEventKey: row.agenda_event_key,
    agendaEventDate: row.agenda_event_date ? (typeof row.agenda_event_date === "string" ? row.agenda_event_date.slice(0, 10) : row.agenda_event_date.toISOString().slice(0, 10)) : null,
    status: row.status,
    notifyLater: row.notify_later,
    lastMatchedAt: iso(row.last_matched_at),
    matchLog: (Array.isArray(row.match_log) ? row.match_log : []) as MatchLogEntry[],
    closedAt: iso(row.closed_at),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

type SuggestionRow = {
  id: string;
  request_id: string | null;
  buyer_user_id: string;
  storefront_id: string;
  reason: string;
  internal_reason: string;
  score: string | number | null;
  fit: string;
  status: SuggestionStatus;
  shown_at: Date;
  decided_at: Date | null;
};

function toSuggestion(row: SuggestionRow): Suggestion {
  return {
    id: row.id,
    requestId: row.request_id,
    buyerUserId: row.buyer_user_id,
    storefrontId: row.storefront_id,
    reason: row.reason,
    internalReason: row.internal_reason,
    score: num(row.score),
    fit: row.fit as Suggestion["fit"],
    status: row.status,
    shownAt: new Date(row.shown_at).toISOString(),
    decidedAt: iso(row.decided_at),
  };
}

type IntroductionRow = {
  id: string;
  suggestion_id: string | null;
  buyer_user_id: string;
  storefront_id: string;
  shared_text: string;
  channel: string;
  status: Introduction["status"];
  supplier_message: string | null;
  requested_at: Date;
  answered_at: Date | null;
  connected_at: Date | null;
};

function toIntroduction(row: IntroductionRow): Introduction {
  return {
    id: row.id,
    suggestionId: row.suggestion_id,
    buyerUserId: row.buyer_user_id,
    storefrontId: row.storefront_id,
    sharedText: row.shared_text,
    channel: row.channel as Introduction["channel"],
    status: row.status,
    supplierMessage: row.supplier_message,
    requestedAt: new Date(row.requested_at).toISOString(),
    answeredAt: iso(row.answered_at),
    connectedAt: iso(row.connected_at),
  };
}

type ReportRow = {
  id: string;
  reporter_user_id: string | null;
  storefront_id: string;
  suggestion_id: string | null;
  reason: string;
  comment: string | null;
  status: ReportStatus;
  admin_decision: string | null;
  admin_user_id: string | null;
  reviewed_at: Date | null;
  created_at: Date;
};

function toReport(row: ReportRow): ListingReport {
  return {
    id: row.id,
    reporterUserId: row.reporter_user_id,
    storefrontId: row.storefront_id,
    suggestionId: row.suggestion_id,
    reason: row.reason as ListingReport["reason"],
    comment: row.comment,
    status: row.status,
    adminDecision: row.admin_decision,
    adminUserId: row.admin_user_id,
    reviewedAt: iso(row.reviewed_at),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

type PrefsRow = { suggestions_opt_in: boolean; agenda_opt_in: boolean; agenda_opt_in_at: Date | null; agenda_consent_version: string | null; muted_categories: unknown; opt_in_at: Date | null; consent_version: string | null };

function toPrefs(row: PrefsRow | undefined): MarketplacePrefs {
  if (!row) return { ...DEFAULT_PREFS };
  return {
    suggestionsOptIn: row.suggestions_opt_in,
    agendaOptIn: row.agenda_opt_in,
    agendaOptInAt: iso(row.agenda_opt_in_at),
    agendaConsentVersion: row.agenda_consent_version,
    mutedCategories: strings(row.muted_categories),
    optInAt: iso(row.opt_in_at),
    consentVersion: row.consent_version,
  };
}

const json = (value: unknown) => sql<string>`${JSON.stringify(value)}::jsonb`;

/** Persistance en base : besoins, suggestions, mises en relation, préférences (tables de la migration 0009 et marketplace_prefs). */
export class DbMatchStore implements MatchStore {
  constructor(
    private readonly db: Db,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listEligible(today: string, filter: EligibleFilter): Promise<EligibleStorefront[]> {
    // La vue exclut déjà les vitrines non publiées ou en pause temporaire (au jour courant du serveur) ;
    // on renforce avec le jour civil de l'acheteur pour la pause temporaire.
    let query = this.db
      .selectFrom("v_eligible_storefronts as v")
      .innerJoin("storefronts as s", "s.id", "v.id")
      .selectAll("v")
      .where("v.user_id", "!=", filter.excludeUserId)
      .where((eb) => eb.or([eb("s.paused_until", "is", null), eb("s.paused_until", "<", sql<Date>`${today}::date`)]));
    if (filter.categoryCode !== null) query = query.where("v.category_code", "=", filter.categoryCode);
    if (filter.changedSince) {
      const since = new Date(filter.changedSince);
      query = query.where((eb) => eb.or([eb("v.published_at", ">", since), eb("v.last_confirmed_at", ">", since)]));
    }
    const rows = await query.orderBy("v.published_at").execute();
    return rows.map((row) => toEligible(row as EligibleRow));
  }

  async getEligible(storefrontId: string, today: string): Promise<EligibleStorefront | null> {
    const row = await this.db
      .selectFrom("v_eligible_storefronts as v")
      .innerJoin("storefronts as s", "s.id", "v.id")
      .selectAll("v")
      .where("v.id", "=", storefrontId)
      .where((eb) => eb.or([eb("s.paused_until", "is", null), eb("s.paused_until", "<", sql<Date>`${today}::date`)]))
      .executeTakeFirst();
    return row ? toEligible(row as EligibleRow) : null;
  }

  async listCategories(): Promise<ServiceCategory[]> {
    return this.db.selectFrom("service_categories").select(["code", "label"]).where("is_active", "=", true).orderBy("sort_order").orderBy("code").execute();
  }

  async createRequest(userId: string, input: RequestInput): Promise<ServiceRequest> {
    const at = this.now();
    const row = await this.db
      .insertInto("service_requests")
      .values({
        user_id: userId,
        text: input.text.trim(),
        category_code: input.categoryCode ?? null,
        postcode: input.postcode ?? null,
        remote_ok: input.remoteOk ?? false,
        timing_text: input.timingText ?? null,
        source: input.source ?? "chat",
        agenda_event_key: input.agendaEventKey ?? null,
        agenda_event_date: input.agendaEventDate ?? null,
        status: input.status ?? "open",
        created_at: at,
        updated_at: at,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRequest(row as RequestRow);
  }

  async getRequest(userId: string, id: string): Promise<ServiceRequest | null> {
    const row = await this.db.selectFrom("service_requests").selectAll().where("user_id", "=", userId).where("id", "=", id).executeTakeFirst();
    return row ? toRequest(row as RequestRow) : null;
  }

  async listRequests(userId: string, options: { status?: RequestStatus } = {}): Promise<ServiceRequest[]> {
    let query = this.db.selectFrom("service_requests").selectAll().where("user_id", "=", userId);
    if (options.status) query = query.where("status", "=", options.status);
    const rows = await query.orderBy("created_at", "desc").execute();
    return rows.map((row) => toRequest(row as RequestRow));
  }

  async updateRequest(userId: string, id: string, patch: RequestPatch): Promise<ServiceRequest> {
    const row = await this.db
      .updateTable("service_requests")
      .set({
        ...(patch.text !== undefined ? { text: patch.text.trim() } : {}),
        ...(patch.categoryCode !== undefined ? { category_code: patch.categoryCode } : {}),
        ...(patch.postcode !== undefined ? { postcode: patch.postcode } : {}),
        ...(patch.remoteOk !== undefined ? { remote_ok: patch.remoteOk } : {}),
        ...(patch.timingText !== undefined ? { timing_text: patch.timingText } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.notifyLater !== undefined ? { notify_later: patch.notifyLater } : {}),
        ...(patch.lastMatchedAt !== undefined ? { last_matched_at: patch.lastMatchedAt ? new Date(patch.lastMatchedAt) : null } : {}),
        ...(patch.matchLog !== undefined ? { match_log: json(patch.matchLog) } : {}),
        ...(patch.closedAt !== undefined ? { closed_at: patch.closedAt ? new Date(patch.closedAt) : null } : {}),
        updated_at: this.now(),
      })
      .where("user_id", "=", userId)
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new RequestNotFound();
    return toRequest(row as RequestRow);
  }

  async listNotifyLaterRequests(): Promise<{ request: ServiceRequest; prefs: MarketplacePrefs }[]> {
    const rows = await this.db
      .selectFrom("service_requests as r")
      .innerJoin("users as u", "u.id", "r.user_id")
      .leftJoin("marketplace_prefs as p", "p.user_id", "r.user_id")
      .selectAll("r")
      .select(["p.suggestions_opt_in", "p.agenda_opt_in", "p.agenda_opt_in_at", "p.agenda_consent_version", "p.muted_categories", "p.opt_in_at", "p.consent_version"])
      .where("r.status", "=", "open")
      .where("r.notify_later", "=", true)
      .where("u.status", "=", "active")
      .orderBy("r.created_at")
      .execute();
    return rows.map((row) => ({
      request: toRequest(row as unknown as RequestRow),
      prefs: toPrefs(
        row.suggestions_opt_in === null
          ? undefined
          : { suggestions_opt_in: row.suggestions_opt_in!, agenda_opt_in: row.agenda_opt_in!, agenda_opt_in_at: row.agenda_opt_in_at, agenda_consent_version: row.agenda_consent_version, muted_categories: row.muted_categories, opt_in_at: row.opt_in_at, consent_version: row.consent_version },
      ),
    }));
  }

  async listAgendaProfiles(): Promise<BuyerProfile[]> {
    const rows = await this.db
      .selectFrom("marketplace_prefs as p")
      .innerJoin("users as u", "u.id", "p.user_id")
      .select(["u.id", "u.first_name", "u.postcode"])
      .where("p.agenda_opt_in", "=", true)
      .where("p.suggestions_opt_in", "=", true)
      .where("u.status", "=", "active")
      .orderBy("u.id")
      .execute();
    return rows.map((row) => ({ userId: row.id, firstName: row.first_name, postcode: row.postcode }));
  }

  async unseenAgendaKeys(userId: string, keys: string[]): Promise<string[]> {
    if (keys.length === 0) return [];
    const seen = await this.db.selectFrom("agenda_events_seen").select("event_key").where("user_id", "=", userId).where("event_key", "in", keys).execute();
    const set = new Set(seen.map((r) => r.event_key));
    return keys.filter((key) => !set.has(key));
  }

  async markAgendaSeen(userId: string, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.db
      .insertInto("agenda_events_seen")
      .values(keys.map((key) => ({ user_id: userId, event_key: key, seen_at: this.now() })))
      .onConflict((oc) => oc.columns(["user_id", "event_key"]).doNothing())
      .execute();
  }

  async addSuggestions(inputs: SuggestionInput[]): Promise<Suggestion[]> {
    if (inputs.length === 0) return [];
    const at = this.now();
    const rows = await this.db
      .insertInto("suggestions")
      .values(
        inputs.map((input) => ({
          request_id: input.requestId,
          buyer_user_id: input.buyerUserId,
          storefront_id: input.storefrontId,
          reason: input.reason,
          internal_reason: input.internalReason,
          score: input.score,
          fit: input.fit,
          shown_at: at,
          created_at: at,
        })),
      )
      .returningAll()
      .execute();
    return rows.map((row) => toSuggestion(row as SuggestionRow));
  }

  async getSuggestion(buyerUserId: string, id: string): Promise<Suggestion | null> {
    const row = await this.db.selectFrom("suggestions").selectAll().where("buyer_user_id", "=", buyerUserId).where("id", "=", id).executeTakeFirst();
    return row ? toSuggestion(row as SuggestionRow) : null;
  }

  async listSuggestions(buyerUserId: string, options: { status?: SuggestionStatus[]; requestId?: string } = {}): Promise<Suggestion[]> {
    let query = this.db.selectFrom("suggestions").selectAll().where("buyer_user_id", "=", buyerUserId);
    if (options.status) query = query.where("status", "in", options.status);
    if (options.requestId) query = query.where("request_id", "=", options.requestId);
    const rows = await query.orderBy("shown_at", "desc").execute();
    return rows.map((row) => toSuggestion(row as SuggestionRow));
  }

  async setSuggestionStatus(buyerUserId: string, id: string, status: SuggestionStatus): Promise<Suggestion> {
    const row = await this.db.updateTable("suggestions").set({ status, decided_at: this.now() }).where("buyer_user_id", "=", buyerUserId).where("id", "=", id).returningAll().executeTakeFirst();
    if (!row) throw new SuggestionNotFound();
    return toSuggestion(row as SuggestionRow);
  }

  async blockedStorefronts(buyerUserId: string, cooldownDays: number): Promise<BlockedStorefronts> {
    const since = new Date(this.now().getTime() - cooldownDays * 86_400_000);
    const blocked: BlockedStorefronts = new Map();
    const suggestions = await this.db
      .selectFrom("suggestions")
      .select(["storefront_id", "status", "decided_at"])
      .where("buyer_user_id", "=", buyerUserId)
      .where((eb) => eb.or([eb("status", "in", ACTIVE_SUGGESTION), eb.and([eb("status", "=", "dismissed"), eb("decided_at", ">", since)])]))
      .execute();
    for (const s of suggestions) {
      if (ACTIVE_SUGGESTION.includes(s.status)) blocked.set(s.storefront_id, "déjà suggérée, en attente de votre réponse");
      else blocked.set(s.storefront_id, `écartée le ${iso(s.decided_at)!.slice(0, 10)}, pas avant ${cooldownDays} jours`);
    }
    const introductions = await this.db
      .selectFrom("introductions")
      .select(["storefront_id", "status", "requested_at", "answered_at", "connected_at"])
      .where("buyer_user_id", "=", buyerUserId)
      .where((eb) => eb.or([eb("status", "in", OPEN_INTRODUCTION), eb("requested_at", ">", since), eb("answered_at", ">", since), eb("connected_at", ">", since)]))
      .execute();
    for (const i of introductions) {
      if (OPEN_INTRODUCTION.includes(i.status)) blocked.set(i.storefront_id, "mise en relation en cours");
      else {
        const at = iso(i.answered_at ?? i.connected_at ?? i.requested_at)!;
        blocked.set(i.storefront_id, `mise en relation ${i.status === "connected" ? "déjà faite" : i.status === "declined" ? "refusée" : "expirée"} le ${at.slice(0, 10)}, pas avant ${cooldownDays} jours`);
      }
    }
    return blocked;
  }

  async createIntroduction(input: IntroductionInput): Promise<Introduction> {
    const at = this.now();
    try {
      const row = await this.db
        .insertInto("introductions")
        .values({ suggestion_id: input.suggestionId, buyer_user_id: input.buyerUserId, storefront_id: input.storefrontId, shared_text: input.sharedText, channel: input.channel ?? "app", requested_at: at, created_at: at, updated_at: at })
        .returningAll()
        .executeTakeFirstOrThrow();
      return toIntroduction(row as IntroductionRow);
    } catch (error) {
      // Index unique partiel : une seule mise en relation ouverte par couple (acheteur, vitrine).
      if ((error as { code?: string }).code === "23505") throw new IntroductionOpen();
      throw error;
    }
  }

  async listIntroductions(buyerUserId: string): Promise<Introduction[]> {
    const rows = await this.db.selectFrom("introductions").selectAll().where("buyer_user_id", "=", buyerUserId).orderBy("requested_at", "desc").execute();
    return rows.map((row) => toIntroduction(row as IntroductionRow));
  }

  async getIntroduction(id: string): Promise<Introduction | null> {
    const row = await this.db.selectFrom("introductions").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? toIntroduction(row as IntroductionRow) : null;
  }

  async listIntroductionsForStorefront(storefrontId: string): Promise<Introduction[]> {
    const rows = await this.db.selectFrom("introductions").selectAll().where("storefront_id", "=", storefrontId).orderBy("requested_at", "desc").execute();
    return rows.map((row) => toIntroduction(row as IntroductionRow));
  }

  async updateIntroduction(id: string, patch: IntroductionPatch): Promise<Introduction> {
    const row = await this.db
      .updateTable("introductions")
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.supplierMessage !== undefined ? { supplier_message: patch.supplierMessage } : {}),
        ...(patch.answeredAt !== undefined ? { answered_at: patch.answeredAt ? new Date(patch.answeredAt) : null } : {}),
        ...(patch.connectedAt !== undefined ? { connected_at: patch.connectedAt ? new Date(patch.connectedAt) : null } : {}),
        updated_at: this.now(),
      })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new IntroductionNotFound();
    return toIntroduction(row as IntroductionRow);
  }

  async listIntroductionsToExpire(before: string): Promise<Introduction[]> {
    const rows = await this.db.selectFrom("introductions").selectAll().where("status", "in", ["requested", "question"]).where("requested_at", "<", new Date(before)).execute();
    return rows.map((row) => toIntroduction(row as IntroductionRow));
  }

  async createReport(input: ReportInput): Promise<ListingReport> {
    const row = await this.db
      .insertInto("listing_reports")
      .values({ reporter_user_id: input.reporterUserId, storefront_id: input.storefrontId, suggestion_id: input.suggestionId, reason: input.reason, comment: input.comment?.trim() || null, created_at: this.now() })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toReport(row as ReportRow);
  }

  async getReport(id: string): Promise<ListingReport | null> {
    const row = await this.db.selectFrom("listing_reports").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? toReport(row as ReportRow) : null;
  }

  async listReports(options: { storefrontId?: string; status?: ReportStatus } = {}): Promise<ListingReport[]> {
    let query = this.db.selectFrom("listing_reports").selectAll();
    if (options.storefrontId) query = query.where("storefront_id", "=", options.storefrontId);
    if (options.status) query = query.where("status", "=", options.status);
    const rows = await query.orderBy("created_at", "desc").execute();
    return rows.map((row) => toReport(row as ReportRow));
  }

  async reviewReport(id: string, review: { status: Exclude<ReportStatus, "open">; adminDecision: string | null; adminUserId: string }): Promise<ListingReport> {
    const row = await this.db
      .updateTable("listing_reports")
      .set({ status: review.status, admin_decision: review.adminDecision, admin_user_id: review.adminUserId, reviewed_at: this.now() })
      .where("id", "=", id)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new ReportNotFound();
    return toReport(row as ReportRow);
  }

  async getPrefs(userId: string): Promise<MarketplacePrefs> {
    const row = await this.db.selectFrom("marketplace_prefs").selectAll().where("user_id", "=", userId).executeTakeFirst();
    return toPrefs(row);
  }

  async setPrefs(userId: string, patch: PrefsPatch): Promise<MarketplacePrefs> {
    const current = await this.getPrefs(userId);
    const at = this.now();
    const optInChanged = patch.suggestionsOptIn !== undefined && patch.suggestionsOptIn !== current.suggestionsOptIn;
    const optIn = patch.suggestionsOptIn ?? current.suggestionsOptIn;
    const agendaChanged = patch.agendaOptIn !== undefined && patch.agendaOptIn !== current.agendaOptIn;
    const agenda = patch.agendaOptIn ?? current.agendaOptIn;
    const values = {
      suggestions_opt_in: optIn,
      muted_categories: json(patch.mutedCategories !== undefined ? [...new Set(patch.mutedCategories)] : current.mutedCategories),
      opt_in_at: optInChanged ? (optIn ? at : null) : current.optInAt ? new Date(current.optInAt) : null,
      consent_version: optIn ? (patch.consentVersion ?? current.consentVersion) : null,
      agenda_opt_in: agenda,
      agenda_opt_in_at: agendaChanged ? (agenda ? at : null) : current.agendaOptInAt ? new Date(current.agendaOptInAt) : null,
      agenda_consent_version: agenda ? (patch.agendaConsentVersion ?? current.agendaConsentVersion) : null,
      updated_at: at,
    };
    await this.db
      .insertInto("marketplace_prefs")
      .values({ user_id: userId, ...values })
      .onConflict((oc) => oc.column("user_id").doUpdateSet(values))
      .execute();
    return this.getPrefs(userId);
  }
}
