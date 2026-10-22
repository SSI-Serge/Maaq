import { randomUUID } from "node:crypto";
import type { ServiceCategory, Storefront, StorefrontFields } from "./model";
import { SERVICE_CATEGORIES } from "./model";
import type { StorefrontStore } from "./store";

/**
 * Marketplace silencieux, côté acheteur : besoins (service_requests), suggestions, mises en relation et
 * préférences de consentement (marketplace_prefs). Deux implémentations : la base (match-db-store.ts) et
 * une version en mémoire pour les tests et les évaluations sans base.
 */

/** proposed : déduite de l'agenda, en attente du oui de la personne avant toute recherche. */
export type RequestStatus = "proposed" | "open" | "suggested" | "closed";
export type RequestSource = "chat" | "agenda";
export type SuggestionStatus = "shown" | "interested" | "dismissed" | "muted" | "expired";
export type SuggestionFit = "strong" | "possible";
export type IntroductionStatus = "requested" | "accepted" | "declined" | "question" | "connected" | "expired";

/** Ce qu'une vitrine publiée laisse sortir du compte du fournisseur : la vue v_eligible_storefronts, jamais le contact. */
export interface EligibleStorefront extends Omit<StorefrontFields, "contactValue"> {
  id: string;
  userId: string;
  publishedAt: string | null;
  lastConfirmedAt: string | null;
}

/** Une ligne du journal de mise en relation : une vitrine candidate et ce qu'on en a décidé. */
export interface MatchLogEntry {
  storefrontId: string;
  name: string;
  lines: string[];
  decision: "ineligible" | "withheld" | "shown";
}

export interface ServiceRequest {
  id: string;
  userId: string;
  text: string;
  categoryCode: string | null;
  postcode: string | null;
  /** L'acheteur accepte un service à distance : la zone n'est alors pas indispensable. */
  remoteOk: boolean;
  timingText: string | null;
  source: RequestSource;
  /** Clé opaque de l'événement d'agenda à l'origine de la demande, et sa date (jamais le titre). */
  agendaEventKey: string | null;
  agendaEventDate: string | null;
  status: RequestStatus;
  notifyLater: boolean;
  lastMatchedAt: string | null;
  matchLog: MatchLogEntry[];
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RequestInput {
  text: string;
  categoryCode?: string | null;
  postcode?: string | null;
  remoteOk?: boolean;
  timingText?: string | null;
  source?: RequestSource;
  agendaEventKey?: string | null;
  agendaEventDate?: string | null;
  /** « proposed » pour une demande issue de l'agenda ; « open » par défaut. */
  status?: "proposed" | "open";
}

export interface RequestPatch extends Omit<Partial<RequestInput>, "status" | "source" | "agendaEventKey" | "agendaEventDate"> {
  status?: RequestStatus;
  notifyLater?: boolean;
  lastMatchedAt?: string | null;
  matchLog?: MatchLogEntry[];
  closedAt?: string | null;
}

export interface Suggestion {
  id: string;
  requestId: string | null;
  buyerUserId: string;
  storefrontId: string;
  reason: string;
  internalReason: string;
  score: number | null;
  fit: SuggestionFit;
  status: SuggestionStatus;
  shownAt: string;
  decidedAt: string | null;
}

export interface SuggestionInput {
  requestId: string | null;
  buyerUserId: string;
  storefrontId: string;
  reason: string;
  internalReason: string;
  score: number | null;
  fit: SuggestionFit;
}

export interface Introduction {
  id: string;
  suggestionId: string | null;
  buyerUserId: string;
  storefrontId: string;
  sharedText: string;
  channel: "app" | "whatsapp";
  status: IntroductionStatus;
  supplierMessage: string | null;
  requestedAt: string;
  answeredAt: string | null;
  connectedAt: string | null;
}

export interface IntroductionPatch {
  status?: IntroductionStatus;
  supplierMessage?: string | null;
  answeredAt?: string | null;
  connectedAt?: string | null;
}

export interface IntroductionInput {
  suggestionId: string | null;
  buyerUserId: string;
  storefrontId: string;
  sharedText: string;
  channel?: "app" | "whatsapp";
}

export interface MarketplacePrefs {
  suggestionsOptIn: boolean;
  /** Lecture de l'agenda pour repérer un besoin : consentement propre, texte et version distincts. */
  agendaOptIn: boolean;
  agendaOptInAt: string | null;
  agendaConsentVersion: string | null;
  mutedCategories: string[];
  optInAt: string | null;
  consentVersion: string | null;
}

export interface PrefsPatch {
  suggestionsOptIn?: boolean;
  mutedCategories?: string[];
  consentVersion?: string;
  agendaOptIn?: boolean;
  agendaConsentVersion?: string;
}

export const DEFAULT_PREFS: MarketplacePrefs = { suggestionsOptIn: false, agendaOptIn: false, agendaOptInAt: null, agendaConsentVersion: null, mutedCategories: [], optInAt: null, consentVersion: null };

/** Profil lu par le marketplace : prénom et zone par défaut. */
export interface BuyerProfile {
  userId: string;
  firstName: string;
  postcode: string | null;
}

export interface EligibleFilter {
  /** Catégorie demandée ; null = toutes. */
  categoryCode: string | null;
  /** Jamais la vitrine de l'acheteur lui-même. */
  excludeUserId: string;
  /** Seulement les vitrines publiées ou reconfirmées depuis cet instant (traitement périodique). */
  changedSince?: string | null;
}

/** Vitrines qu'on ne propose pas (encore) à cet acheteur, avec la raison lisible. */
export type BlockedStorefronts = Map<string, string>;

export interface MatchStore {
  /** Vitrines publiées, hors pause au jour donné (AAAA-MM-JJ) : la vue v_eligible_storefronts. */
  listEligible(today: string, filter: EligibleFilter): Promise<EligibleStorefront[]>;
  /** Une vitrine encore éligible, par identifiant ; null si elle ne l'est plus (dépubliée, en pause). */
  getEligible(storefrontId: string, today: string): Promise<EligibleStorefront | null>;
  listCategories(): Promise<ServiceCategory[]>;

  createRequest(userId: string, input: RequestInput): Promise<ServiceRequest>;
  getRequest(userId: string, id: string): Promise<ServiceRequest | null>;
  listRequests(userId: string, options?: { status?: RequestStatus }): Promise<ServiceRequest[]>;
  updateRequest(userId: string, id: string, patch: RequestPatch): Promise<ServiceRequest>;
  /** Demandes ouvertes à réexaminer plus tard, tous profils confondus, avec le consentement de chacun. */
  listNotifyLaterRequests(): Promise<{ request: ServiceRequest; prefs: MarketplacePrefs }[]>;
  /** Profils actifs qui ont consenti à la lecture de l'agenda (et aux suggestions). */
  listAgendaProfiles(): Promise<BuyerProfile[]>;
  /** Parmi des clés d'événements, celles jamais examinées pour ce profil. */
  unseenAgendaKeys(userId: string, keys: string[]): Promise<string[]>;
  markAgendaSeen(userId: string, keys: string[]): Promise<void>;

  addSuggestions(inputs: SuggestionInput[]): Promise<Suggestion[]>;
  getSuggestion(buyerUserId: string, id: string): Promise<Suggestion | null>;
  listSuggestions(buyerUserId: string, options?: { status?: SuggestionStatus[]; requestId?: string }): Promise<Suggestion[]>;
  setSuggestionStatus(buyerUserId: string, id: string, status: SuggestionStatus): Promise<Suggestion>;
  /** Couples (acheteur, vitrine) à ne pas reproposer : suggestion active, écartée depuis moins de `cooldownDays`, mise en relation ouverte ou récente. */
  blockedStorefronts(buyerUserId: string, cooldownDays: number): Promise<BlockedStorefronts>;

  /** Crée la mise en relation ; refuse s'il en existe déjà une ouverte pour ce couple. */
  createIntroduction(input: IntroductionInput): Promise<Introduction>;
  listIntroductions(buyerUserId: string): Promise<Introduction[]>;
  getIntroduction(id: string): Promise<Introduction | null>;
  /** Mises en relation reçues par une vitrine (côté fournisseur). */
  listIntroductionsForStorefront(storefrontId: string): Promise<Introduction[]>;
  updateIntroduction(id: string, patch: IntroductionPatch): Promise<Introduction>;
  /** Mises en relation encore sans réponse (requested, question) demandées avant cet instant. */
  listIntroductionsToExpire(before: string): Promise<Introduction[]>;

  getPrefs(userId: string): Promise<MarketplacePrefs>;
  setPrefs(userId: string, patch: PrefsPatch): Promise<MarketplacePrefs>;
}

export class RequestNotFound extends Error {
  constructor() {
    super("Cette demande est introuvable.");
    this.name = "RequestNotFound";
  }
}

export class SuggestionNotFound extends Error {
  constructor() {
    super("Cette suggestion est introuvable.");
    this.name = "SuggestionNotFound";
  }
}

export class IntroductionNotFound extends Error {
  constructor() {
    super("Cette mise en relation est introuvable.");
    this.name = "IntroductionNotFound";
  }
}

export class IntroductionOpen extends Error {
  constructor() {
    super("Une mise en relation est déjà en cours avec ce fournisseur.");
    this.name = "IntroductionOpen";
  }
}

/** Statuts d'une mise en relation encore en cours : un seul par couple (acheteur, vitrine). */
export const OPEN_INTRODUCTION: IntroductionStatus[] = ["requested", "question", "accepted"];
export const ACTIVE_SUGGESTION: SuggestionStatus[] = ["shown", "interested"];

export function eligibleOf(s: Storefront): EligibleStorefront {
  return {
    id: s.id,
    userId: s.userId,
    publishedAt: s.publishedAt,
    lastConfirmedAt: s.lastConfirmedAt,
    displayName: s.displayName,
    categoryCode: s.categoryCode,
    services: s.services,
    description: s.description,
    postcode: s.postcode,
    city: s.city,
    modes: s.modes,
    travelAreas: s.travelAreas,
    travelNote: s.travelNote,
    availabilityMode: s.availabilityMode,
    availabilityText: s.availabilityText,
    priceMode: s.priceMode,
    priceMin: s.priceMin,
    priceMax: s.priceMax,
    languages: s.languages,
    noticeText: s.noticeText,
    qualificationsText: s.qualificationsText,
    contactMethod: s.contactMethod,
  };
}

function daysBefore(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

/** Version en mémoire, adossée à un magasin de vitrines en mémoire. */
export class MemoryMatchStore implements MatchStore {
  private readonly requests = new Map<string, ServiceRequest>();
  private readonly suggestions = new Map<string, Suggestion>();
  private readonly introductions = new Map<string, Introduction>();
  private readonly prefs = new Map<string, MarketplacePrefs>();
  private readonly seen = new Map<string, Set<string>>();
  /** Profils connus de la version en mémoire (tests) : prénom et code postal. */
  readonly profiles = new Map<string, { firstName: string; postcode: string | null }>();

  constructor(
    private readonly storefronts: StorefrontStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listAgendaProfiles(): Promise<BuyerProfile[]> {
    const out: BuyerProfile[] = [];
    for (const [userId, prefs] of this.prefs) {
      if (!prefs.agendaOptIn || !prefs.suggestionsOptIn) continue;
      const profile = this.profiles.get(userId);
      out.push({ userId, firstName: profile?.firstName ?? userId, postcode: profile?.postcode ?? null });
    }
    return out;
  }

  async unseenAgendaKeys(userId: string, keys: string[]): Promise<string[]> {
    const seen = this.seen.get(userId) ?? new Set();
    return keys.filter((key) => !seen.has(key));
  }

  async markAgendaSeen(userId: string, keys: string[]): Promise<void> {
    const seen = this.seen.get(userId) ?? new Set();
    for (const key of keys) seen.add(key);
    this.seen.set(userId, seen);
  }

  async listEligible(today: string, filter: EligibleFilter): Promise<EligibleStorefront[]> {
    const all = await this.storefronts.listEligible(today);
    return all
      .filter((s) => s.userId !== filter.excludeUserId)
      .filter((s) => filter.categoryCode === null || s.categoryCode === filter.categoryCode)
      .filter((s) => !filter.changedSince || (s.publishedAt !== null && s.publishedAt > filter.changedSince) || (s.lastConfirmedAt !== null && s.lastConfirmedAt > filter.changedSince))
      .map(eligibleOf);
  }

  async getEligible(storefrontId: string, today: string): Promise<EligibleStorefront | null> {
    const found = (await this.storefronts.listEligible(today)).find((s) => s.id === storefrontId);
    return found ? eligibleOf(found) : null;
  }

  async listCategories(): Promise<ServiceCategory[]> {
    return SERVICE_CATEGORIES.map((c) => ({ ...c }));
  }

  async createRequest(userId: string, input: RequestInput): Promise<ServiceRequest> {
    const at = this.now().toISOString();
    const request: ServiceRequest = {
      id: randomUUID(),
      userId,
      text: input.text.trim(),
      categoryCode: input.categoryCode ?? null,
      postcode: input.postcode ?? null,
      remoteOk: input.remoteOk ?? false,
      timingText: input.timingText ?? null,
      source: input.source ?? "chat",
      agendaEventKey: input.agendaEventKey ?? null,
      agendaEventDate: input.agendaEventDate ?? null,
      status: input.status ?? "open",
      notifyLater: false,
      lastMatchedAt: null,
      matchLog: [],
      closedAt: null,
      createdAt: at,
      updatedAt: at,
    };
    if (request.agendaEventKey && [...this.requests.values()].some((r) => r.userId === userId && r.agendaEventKey === request.agendaEventKey)) throw new Error("Une demande existe déjà pour cet événement d'agenda.");
    this.requests.set(request.id, request);
    return structuredClone(request);
  }

  async getRequest(userId: string, id: string): Promise<ServiceRequest | null> {
    const found = this.requests.get(id);
    return found && found.userId === userId ? structuredClone(found) : null;
  }

  async listRequests(userId: string, options: { status?: RequestStatus } = {}): Promise<ServiceRequest[]> {
    return [...this.requests.values()]
      .filter((r) => r.userId === userId && (!options.status || r.status === options.status))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((r) => structuredClone(r));
  }

  async updateRequest(userId: string, id: string, patch: RequestPatch): Promise<ServiceRequest> {
    const found = this.requests.get(id);
    if (!found || found.userId !== userId) throw new RequestNotFound();
    if (patch.text !== undefined) found.text = patch.text.trim();
    if (patch.categoryCode !== undefined) found.categoryCode = patch.categoryCode;
    if (patch.postcode !== undefined) found.postcode = patch.postcode;
    if (patch.remoteOk !== undefined) found.remoteOk = patch.remoteOk;
    if (patch.timingText !== undefined) found.timingText = patch.timingText;
    if (patch.status !== undefined) found.status = patch.status;
    if (patch.notifyLater !== undefined) found.notifyLater = patch.notifyLater;
    if (patch.lastMatchedAt !== undefined) found.lastMatchedAt = patch.lastMatchedAt;
    if (patch.matchLog !== undefined) found.matchLog = patch.matchLog;
    if (patch.closedAt !== undefined) found.closedAt = patch.closedAt;
    found.updatedAt = this.now().toISOString();
    return structuredClone(found);
  }

  async listNotifyLaterRequests(): Promise<{ request: ServiceRequest; prefs: MarketplacePrefs }[]> {
    const out: { request: ServiceRequest; prefs: MarketplacePrefs }[] = [];
    for (const request of this.requests.values()) {
      if (request.status !== "open" || !request.notifyLater) continue;
      out.push({ request: structuredClone(request), prefs: await this.getPrefs(request.userId) });
    }
    return out.sort((a, b) => a.request.createdAt.localeCompare(b.request.createdAt));
  }

  async addSuggestions(inputs: SuggestionInput[]): Promise<Suggestion[]> {
    const at = this.now().toISOString();
    const created: Suggestion[] = [];
    for (const input of inputs) {
      const active = [...this.suggestions.values()].some((s) => s.buyerUserId === input.buyerUserId && s.storefrontId === input.storefrontId && ACTIVE_SUGGESTION.includes(s.status));
      if (active) throw new Error("Une suggestion active existe déjà pour cette vitrine.");
      const suggestion: Suggestion = { id: randomUUID(), ...input, status: "shown", shownAt: at, decidedAt: null };
      this.suggestions.set(suggestion.id, suggestion);
      created.push(structuredClone(suggestion));
    }
    return created;
  }

  async getSuggestion(buyerUserId: string, id: string): Promise<Suggestion | null> {
    const found = this.suggestions.get(id);
    return found && found.buyerUserId === buyerUserId ? structuredClone(found) : null;
  }

  async listSuggestions(buyerUserId: string, options: { status?: SuggestionStatus[]; requestId?: string } = {}): Promise<Suggestion[]> {
    return [...this.suggestions.values()]
      .filter((s) => s.buyerUserId === buyerUserId && (!options.status || options.status.includes(s.status)) && (!options.requestId || s.requestId === options.requestId))
      .sort((a, b) => b.shownAt.localeCompare(a.shownAt))
      .map((s) => structuredClone(s));
  }

  async setSuggestionStatus(buyerUserId: string, id: string, status: SuggestionStatus): Promise<Suggestion> {
    const found = this.suggestions.get(id);
    if (!found || found.buyerUserId !== buyerUserId) throw new SuggestionNotFound();
    found.status = status;
    found.decidedAt = this.now().toISOString();
    return structuredClone(found);
  }

  async blockedStorefronts(buyerUserId: string, cooldownDays: number): Promise<BlockedStorefronts> {
    const since = daysBefore(this.now(), cooldownDays);
    const blocked: BlockedStorefronts = new Map();
    for (const s of this.suggestions.values()) {
      if (s.buyerUserId !== buyerUserId) continue;
      if (ACTIVE_SUGGESTION.includes(s.status)) blocked.set(s.storefrontId, "déjà suggérée, en attente de votre réponse");
      else if (s.status === "dismissed" && s.decidedAt && s.decidedAt > since) blocked.set(s.storefrontId, `écartée le ${s.decidedAt.slice(0, 10)}, pas avant ${cooldownDays} jours`);
    }
    for (const i of this.introductions.values()) {
      if (i.buyerUserId !== buyerUserId) continue;
      if (OPEN_INTRODUCTION.includes(i.status)) blocked.set(i.storefrontId, "mise en relation en cours");
      else {
        const at = i.answeredAt ?? i.connectedAt ?? i.requestedAt;
        if (at > since) blocked.set(i.storefrontId, `mise en relation ${i.status === "connected" ? "déjà faite" : i.status === "declined" ? "refusée" : "expirée"} le ${at.slice(0, 10)}, pas avant ${cooldownDays} jours`);
      }
    }
    return blocked;
  }

  async createIntroduction(input: IntroductionInput): Promise<Introduction> {
    const open = [...this.introductions.values()].some((i) => i.buyerUserId === input.buyerUserId && i.storefrontId === input.storefrontId && OPEN_INTRODUCTION.includes(i.status));
    if (open) throw new IntroductionOpen();
    const at = this.now().toISOString();
    const introduction: Introduction = {
      id: randomUUID(),
      suggestionId: input.suggestionId,
      buyerUserId: input.buyerUserId,
      storefrontId: input.storefrontId,
      sharedText: input.sharedText,
      channel: input.channel ?? "app",
      status: "requested",
      supplierMessage: null,
      requestedAt: at,
      answeredAt: null,
      connectedAt: null,
    };
    this.introductions.set(introduction.id, introduction);
    return structuredClone(introduction);
  }

  async listIntroductions(buyerUserId: string): Promise<Introduction[]> {
    return [...this.introductions.values()]
      .filter((i) => i.buyerUserId === buyerUserId)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
      .map((i) => structuredClone(i));
  }

  async getIntroduction(id: string): Promise<Introduction | null> {
    const found = this.introductions.get(id);
    return found ? structuredClone(found) : null;
  }

  async listIntroductionsForStorefront(storefrontId: string): Promise<Introduction[]> {
    return [...this.introductions.values()]
      .filter((i) => i.storefrontId === storefrontId)
      .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
      .map((i) => structuredClone(i));
  }

  async updateIntroduction(id: string, patch: IntroductionPatch): Promise<Introduction> {
    const found = this.introductions.get(id);
    if (!found) throw new IntroductionNotFound();
    if (patch.status !== undefined) found.status = patch.status;
    if (patch.supplierMessage !== undefined) found.supplierMessage = patch.supplierMessage;
    if (patch.answeredAt !== undefined) found.answeredAt = patch.answeredAt;
    if (patch.connectedAt !== undefined) found.connectedAt = patch.connectedAt;
    return structuredClone(found);
  }

  async listIntroductionsToExpire(before: string): Promise<Introduction[]> {
    return [...this.introductions.values()]
      .filter((i) => (i.status === "requested" || i.status === "question") && i.requestedAt < before)
      .map((i) => structuredClone(i));
  }

  async getPrefs(userId: string): Promise<MarketplacePrefs> {
    return structuredClone(this.prefs.get(userId) ?? DEFAULT_PREFS);
  }

  async setPrefs(userId: string, patch: PrefsPatch): Promise<MarketplacePrefs> {
    const current = await this.getPrefs(userId);
    const next: MarketplacePrefs = { ...current };
    if (patch.mutedCategories !== undefined) next.mutedCategories = [...new Set(patch.mutedCategories)];
    if (patch.suggestionsOptIn !== undefined && patch.suggestionsOptIn !== current.suggestionsOptIn) {
      next.suggestionsOptIn = patch.suggestionsOptIn;
      next.optInAt = patch.suggestionsOptIn ? this.now().toISOString() : null;
      next.consentVersion = patch.suggestionsOptIn ? (patch.consentVersion ?? current.consentVersion) : null;
    } else if (patch.consentVersion !== undefined && next.suggestionsOptIn) next.consentVersion = patch.consentVersion;
    if (patch.agendaOptIn !== undefined && patch.agendaOptIn !== current.agendaOptIn) {
      next.agendaOptIn = patch.agendaOptIn;
      next.agendaOptInAt = patch.agendaOptIn ? this.now().toISOString() : null;
      next.agendaConsentVersion = patch.agendaOptIn ? (patch.agendaConsentVersion ?? current.agendaConsentVersion) : null;
    }
    this.prefs.set(userId, next);
    return structuredClone(next);
  }
}
