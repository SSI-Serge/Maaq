import type { Kysely } from "kysely";
import { z } from "zod";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { db } from "@/server/db/client";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { DbStorefrontStore } from "./db-store";
import {
  buyerPreview,
  cleanList,
  GROUP_LABEL,
  ISSUE_TEXT,
  publicationIssues,
  type BuyerPreview,
  type FieldGroup,
  type PublicationIssue,
  type ServiceCategory,
  type Storefront,
  type StorefrontFields,
} from "./model";
import { GroupEmpty, StorefrontNotFound, type StorefrontStore } from "./store";

/**
 * Vitrine d'un fournisseur, côté application : écran de relecture sur la fiche de l'agent vitrine (Catalogue ›
 * vitrine), publication, pause, indisponibilité. Mêmes données que le tchat de l'agent (US-05, US-06).
 */

let store: StorefrontStore | undefined;

export function storefrontStore(connection: Kysely<DB> = db()): StorefrontStore {
  store ??= new DbStorefrontStore(connection);
  return store;
}

const POSTCODE = /^\d{5}$/;
const DEPARTEMENT = /^(\d{2}|2A|2B|\d{3})$/;

export const storefrontPatchSchema = z.object({
  displayName: z.string().trim().max(100).nullable().optional(),
  categoryCode: z.string().regex(/^[a-z0-9_]+$/).nullable().optional(),
  services: z.array(z.string().trim().min(1).max(80)).max(20).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  postcode: z.string().regex(POSTCODE, "Code postal à 5 chiffres.").nullable().optional(),
  city: z.string().trim().max(100).nullable().optional(),
  modes: z.array(z.enum(["at_supplier", "travels", "remote"])).max(3).optional(),
  travelAreas: z.array(z.string().regex(DEPARTEMENT)).max(20).optional(),
  travelNote: z.string().trim().max(200).nullable().optional(),
  availabilityMode: z.enum(["hours", "by_arrangement"]).nullable().optional(),
  availabilityText: z.string().trim().max(300).nullable().optional(),
  priceMode: z.enum(["quote", "from", "range"]).nullable().optional(),
  priceMin: z.number().min(0).max(1_000_000).nullable().optional(),
  priceMax: z.number().min(0).max(1_000_000).nullable().optional(),
  languages: z.array(z.string().trim().min(1).max(40)).max(10).optional(),
  noticeText: z.string().trim().max(200).nullable().optional(),
  qualificationsText: z.string().trim().max(500).nullable().optional(),
  contactMethod: z.enum(["maaq_intro", "whatsapp"]).nullable().optional(),
  contactValue: z.string().trim().max(200).nullable().optional(),
});

export type StorefrontPatch = z.infer<typeof storefrontPatchSchema>;

export const GROUPS = Object.keys(GROUP_LABEL) as FieldGroup[];
export const confirmSchema = z.object({ groups: z.array(z.enum(GROUPS as [FieldGroup, ...FieldGroup[]])).min(1).max(GROUPS.length) });
export const pauseSchema = z.object({ paused: z.boolean() });
export const unavailableSchema = z.object({ until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() });

export interface StorefrontView {
  storefront: Storefront | null;
  issues: PublicationIssue[];
  /** Les mêmes, en phrases pour l'écran. */
  issueLines: string[];
  canPublish: boolean;
  preview: BuyerPreview | null;
  categories: ServiceCategory[];
}

function requireSupplier(session: SessionContext): string {
  if (session.user.role === "admin") throw new Rejection("forbidden", "Un administrateur n'a pas de vitrine.", 403);
  return session.user.id;
}

export function issueLines(issues: PublicationIssue[]): string[] {
  return issues.map((issue) => `${GROUP_LABEL[issue.group]} : ${ISSUE_TEXT[issue.reason]}`);
}

export async function viewOf(source: StorefrontStore, userId: string): Promise<StorefrontView> {
  const [storefront, categories] = await Promise.all([source.get(userId), source.listCategories()]);
  const issues = storefront ? publicationIssues(storefront) : [];
  return {
    storefront,
    issues,
    issueLines: issueLines(issues),
    canPublish: storefront !== null && issues.length === 0,
    preview: storefront ? buyerPreview(storefront, categories) : null,
    categories,
  };
}

export async function getStorefrontView(ctx: Ctx, session: SessionContext): Promise<StorefrontView> {
  return viewOf(storefrontStore(ctx.db), requireSupplier(session));
}

/** Normalise un lot de champs avant enregistrement : listes nettoyées, cohérence du tarif, catégorie connue. */
export async function normalizePatch(source: StorefrontStore, patch: StorefrontPatch): Promise<Partial<StorefrontFields>> {
  const next: Partial<StorefrontFields> = { ...patch };
  if (patch.services) next.services = cleanList(patch.services);
  if (patch.languages) next.languages = cleanList(patch.languages, 10);
  if (patch.travelAreas) next.travelAreas = cleanList(patch.travelAreas.map((d) => d.toUpperCase()));
  if (patch.modes) next.modes = [...new Set(patch.modes)];
  if (patch.categoryCode) {
    const known = (await source.listCategories()).some((c) => c.code === patch.categoryCode);
    if (!known) throw new Rejection("unknown_category", "Cette catégorie n'existe pas.");
  }
  if (patch.priceMode === "quote") {
    next.priceMin = null;
    next.priceMax = null;
  }
  if (patch.priceMode === "from") next.priceMax = null;
  if (patch.priceMin !== undefined && patch.priceMin !== null && patch.priceMax !== undefined && patch.priceMax !== null && patch.priceMax < patch.priceMin) {
    throw new Rejection("invalid_price_range", "Le prix maximum doit être supérieur au minimum.");
  }
  if (patch.availabilityMode === "by_arrangement") next.availabilityText = null;
  return next;
}

/** Modification depuis l'écran de relecture : le fournisseur écrit lui-même, le groupe est donc confirmé. */
export async function updateStorefront(ctx: Ctx, session: SessionContext, patch: StorefrontPatch): Promise<StorefrontView> {
  const userId = requireSupplier(session);
  const source = storefrontStore(ctx.db);
  const fields = await normalizePatch(source, patch);
  const origin = Object.fromEntries(GROUPS.map((group) => [group, "confirmed" as const]));
  await source.save(userId, fields, origin);
  return viewOf(source, userId);
}

export async function confirmStorefront(ctx: Ctx, session: SessionContext, groups: FieldGroup[]): Promise<StorefrontView> {
  const userId = requireSupplier(session);
  const source = storefrontStore(ctx.db);
  try {
    await source.confirm(userId, groups);
  } catch (error) {
    if (error instanceof StorefrontNotFound) throw new Rejection("not_found", error.message, 404);
    if (error instanceof GroupEmpty) throw new Rejection("group_empty", error.message);
    throw error;
  }
  return viewOf(source, userId);
}

/** Publication : action explicite, refusée tant qu'un champ obligatoire manque ou n'est pas confirmé (US-05). */
export async function publishStorefront(ctx: Ctx, session: SessionContext): Promise<StorefrontView> {
  const userId = requireSupplier(session);
  const source = storefrontStore(ctx.db);
  const storefront = await source.get(userId);
  if (!storefront) throw new Rejection("not_found", "Créez d'abord votre vitrine avec l'agent vitrine.", 404);
  const issues = publicationIssues(storefront);
  if (issues.length) throw new Rejection("storefront_incomplete", `Avant de publier : ${issueLines(issues).join(" ; ")}.`, 422, { issues });
  const at = ctx.now.toISOString();
  await source.setState(userId, { status: "published", publishedAt: storefront.publishedAt ?? at, lastConfirmedAt: at, pausedUntil: null });
  return viewOf(source, userId);
}

/** Pause : la vitrine reste enregistrée mais sort des recherches ; reprise sans rien ressaisir (US-06). */
export async function pauseStorefront(ctx: Ctx, session: SessionContext, paused: boolean): Promise<StorefrontView> {
  const userId = requireSupplier(session);
  const source = storefrontStore(ctx.db);
  const storefront = await source.get(userId);
  if (!storefront || storefront.status === "draft") throw new Rejection("not_published", "Cette vitrine n'est pas publiée.", 409);
  await source.setState(userId, { status: paused ? "paused" : "published" });
  return viewOf(source, userId);
}

/** Indisponibilité temporaire : exclue des recherches jusqu'à la date, sans changer les horaires habituels. */
export async function setUnavailableUntil(ctx: Ctx, session: SessionContext, until: string | null): Promise<StorefrontView> {
  const userId = requireSupplier(session);
  const source = storefrontStore(ctx.db);
  const storefront = await source.get(userId);
  if (!storefront) throw new Rejection("not_found", "Créez d'abord votre vitrine avec l'agent vitrine.", 404);
  if (until !== null && until < ctx.now.toISOString().slice(0, 10)) throw new Rejection("date_past", "Cette date est déjà passée.");
  await source.setState(userId, { pausedUntil: until });
  return viewOf(source, userId);
}
