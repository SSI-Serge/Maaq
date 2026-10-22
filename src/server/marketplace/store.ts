import { randomUUID } from "node:crypto";
import { EMPTY_FIELDS, groupFilled, SERVICE_CATEGORIES, touchedGroups, type FieldGroup, type Provenance, type ServiceCategory, type Storefront, type StorefrontFields, type StorefrontStatus } from "./model";

/**
 * Persistance de la vitrine d'un profil. Deux implémentations : la base (db-store.ts) et une version en
 * mémoire (tests unitaires, évaluations sans base). Une vitrine par profil, créée au premier enregistrement.
 */

export interface StateChange {
  status?: StorefrontStatus;
  pausedUntil?: string | null;
  publishedAt?: string | null;
  lastConfirmedAt?: string | null;
}

export interface StorefrontStore {
  get(userId: string): Promise<Storefront | null>;
  /**
   * Enregistre des champs ; crée le brouillon s'il n'existe pas. Chaque groupe touché prend la provenance
   * donnée pour lui (sinon « stated ») : une valeur modifiée n'est plus confirmée, sauf si l'origine le dit.
   */
  save(userId: string, patch: Partial<StorefrontFields>, origin?: Partial<Record<FieldGroup, Provenance>>): Promise<Storefront>;
  /** Marque des groupes comme confirmés par le fournisseur ; un groupe vide n'est pas confirmable. */
  confirm(userId: string, groups: FieldGroup[]): Promise<Storefront>;
  setState(userId: string, change: StateChange): Promise<Storefront>;
  listCategories(): Promise<ServiceCategory[]>;
  /** Vitrines publiées hors pause temporaire, au jour donné (AAAA-MM-JJ) : ce que lit la mise en relation. */
  listEligible(today: string): Promise<Storefront[]>;
}

export class StorefrontNotFound extends Error {
  constructor() {
    super("Aucune vitrine pour ce profil.");
    this.name = "StorefrontNotFound";
  }
}

export class GroupEmpty extends Error {
  constructor(group: FieldGroup) {
    super(`Le groupe « ${group} » est vide : rien à confirmer.`);
    this.name = "GroupEmpty";
  }
}

/** Version en mémoire, par profil. */
export class MemoryStorefrontStore implements StorefrontStore {
  private readonly items = new Map<string, Storefront>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async get(userId: string): Promise<Storefront | null> {
    const item = this.items.get(userId);
    return item ? structuredClone(item) : null;
  }

  private blank(userId: string): Storefront {
    const at = this.now().toISOString();
    return { ...EMPTY_FIELDS, id: randomUUID(), userId, status: "draft", pausedUntil: null, searchable: false, provenance: {}, lastConfirmedAt: null, publishedAt: null, version: 1, createdAt: at, updatedAt: at };
  }

  async save(userId: string, patch: Partial<StorefrontFields>, origin: Partial<Record<FieldGroup, Provenance>> = {}): Promise<Storefront> {
    const current = this.items.get(userId) ?? this.blank(userId);
    const at = this.now().toISOString();
    const next: Storefront = { ...current, updatedAt: at, version: current.version + (this.items.has(userId) ? 1 : 0) };
    for (const [key, value] of Object.entries(patch)) if (value !== undefined) (next as unknown as Record<string, unknown>)[key] = value;
    for (const group of touchedGroups(patch)) next.provenance[group] = { source: origin[group] ?? "stated", at };
    this.items.set(userId, next);
    return structuredClone(next);
  }

  async confirm(userId: string, groups: FieldGroup[]): Promise<Storefront> {
    const current = this.items.get(userId);
    if (!current) throw new StorefrontNotFound();
    const at = this.now().toISOString();
    for (const group of groups) {
      if (!groupFilled(current, group)) throw new GroupEmpty(group);
      current.provenance[group] = { source: "confirmed", at };
    }
    current.lastConfirmedAt = at;
    current.updatedAt = at;
    current.version += 1;
    return structuredClone(current);
  }

  async setState(userId: string, change: StateChange): Promise<Storefront> {
    const current = this.items.get(userId);
    if (!current) throw new StorefrontNotFound();
    if (change.status !== undefined) current.status = change.status;
    if (change.pausedUntil !== undefined) current.pausedUntil = change.pausedUntil;
    if (change.publishedAt !== undefined) current.publishedAt = change.publishedAt;
    if (change.lastConfirmedAt !== undefined) current.lastConfirmedAt = change.lastConfirmedAt;
    current.updatedAt = this.now().toISOString();
    current.version += 1;
    return structuredClone(current);
  }

  async listCategories(): Promise<ServiceCategory[]> {
    return SERVICE_CATEGORIES.map((c) => ({ ...c }));
  }

  async listEligible(today: string): Promise<Storefront[]> {
    return [...this.items.values()].filter((s) => s.status === "published" && (s.pausedUntil === null || s.pausedUntil < today)).map((s) => structuredClone(s));
  }
}
