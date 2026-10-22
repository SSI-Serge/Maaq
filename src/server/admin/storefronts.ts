import { sql } from "kysely";
import type { Ctx } from "@/server/auth/service";
import { Rejection } from "@/server/http";
import { matchStore } from "@/server/marketplace/buyer-service";
import { REPORT_REASON_LABEL, type ListingReport, type MatchLogEntry, type ReportStatus } from "@/server/marketplace/match-store";
import { buyerPreview, servedDepartements, type BuyerPreview, type FieldGroup, type ProvenanceEntry, type ServiceCategory, type StorefrontStatus } from "@/server/marketplace/model";
import { storefrontStore } from "@/server/marketplace/service";
import { logAdminAction } from "./audit";

/**
 * Administration des vitrines du marketplace silencieux (US-17) : liste par statut, signalées d'abord, suspension
 * et levée, correction de catégorie, lecture des raisons internes des suggestions et du journal de mise en
 * relation, traitement des signalements (US-16), compteurs. Chaque action est journalisée.
 */

export type StorefrontFilter = "all" | "reported" | "published" | "draft" | "paused" | "suspended";

export interface StorefrontRow {
  id: string;
  supplier: { id: string; name: string; email: string };
  displayName: string | null;
  categoryCode: string | null;
  categoryLabel: string | null;
  status: StorefrontStatus;
  pausedUntil: string | null;
  adminPaused: boolean;
  adminPauseReason: string | null;
  publishedAt: string | null;
  lastConfirmedAt: string | null;
  updatedAt: string;
  openReports: number;
  suggestionsShown: number;
  introductions: number;
}

export interface Counters {
  storefronts: { draft: number; published: number; paused: number; suspended: number };
  /** Vitrines éligibles (vue), par catégorie et par département desservi. */
  eligibleByCategory: { code: string; label: string; count: number }[];
  eligibleByDepartement: { departement: string; count: number }[];
  suggestions: { shown: number; interested: number; dismissed: number; muted: number; expired: number };
  introductions: { requested: number; question: number; connected: number; declined: number; expired: number };
  reports: { open: number; reviewed: number; dismissed: number };
}

export interface ReportView extends ListingReport {
  reasonLabel: string;
  reporterFirstName: string | null;
  adminName: string | null;
}

export interface StorefrontDetail {
  storefront: StorefrontRow;
  preview: BuyerPreview;
  provenance: Partial<Record<FieldGroup, ProvenanceEntry>>;
  categories: ServiceCategory[];
  reports: ReportView[];
  suggestions: { id: string; buyerFirstName: string | null; requestText: string | null; reason: string; internalReason: string; score: number | null; fit: string; status: string; shownAt: string }[];
  /** Décisions des dernières demandes où cette vitrine était candidate, retenue ou non (journal de mise en relation). */
  matchLog: { requestId: string; buyerFirstName: string | null; at: string | null; entry: MatchLogEntry }[];
  introductions: { id: string; buyerFirstName: string | null; status: string; requestedAt: string; answeredAt: string | null }[];
  audit: { action: string; at: string; admin: string | null; details: unknown }[];
}

function iso(value: Date | string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

export async function listStorefronts(ctx: Ctx, filter: StorefrontFilter = "all", search = ""): Promise<StorefrontRow[]> {
  let query = ctx.db
    .selectFrom("storefronts as s")
    .innerJoin("users as u", "u.id", "s.user_id")
    .leftJoin("service_categories as c", "c.code", "s.category_code")
    .select([
      "s.id",
      "s.user_id",
      "u.first_name",
      "u.last_name",
      "u.email",
      "s.display_name",
      "s.category_code",
      "c.label as category_label",
      "s.status",
      "s.paused_until",
      "s.admin_paused",
      "s.admin_pause_reason",
      "s.published_at",
      "s.last_confirmed_at",
      "s.updated_at",
      sql<number>`(select count(*) from listing_reports r where r.storefront_id = s.id and r.status = 'open')`.as("open_reports"),
      sql<number>`(select count(*) from suggestions g where g.storefront_id = s.id)`.as("suggestions_shown"),
      sql<number>`(select count(*) from introductions i where i.storefront_id = s.id)`.as("introductions"),
    ]);
  switch (filter) {
    case "reported":
      query = query.where(sql<boolean>`exists (select 1 from listing_reports r where r.storefront_id = s.id and r.status = 'open')`);
      break;
    case "published":
      query = query.where("s.status", "=", "published").where("s.admin_paused", "=", false);
      break;
    case "draft":
      query = query.where("s.status", "=", "draft");
      break;
    case "paused":
      query = query.where((eb) => eb.or([eb("s.status", "=", "paused"), eb("s.paused_until", ">=", sql<Date>`current_date`)]));
      break;
    case "suspended":
      query = query.where("s.admin_paused", "=", true);
      break;
  }
  const term = search.trim();
  if (term) {
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    query = query.where((eb) => eb.or([eb("s.display_name", "ilike", like), eb("u.email", "ilike", like), eb("u.last_name", "ilike", like), eb("c.label", "ilike", like)]));
  }
  // Signalées d'abord, puis les plus récemment modifiées.
  const rows = await query.orderBy(sql`open_reports desc`).orderBy("s.updated_at", "desc").execute();
  return rows.map((r) => ({
    id: r.id,
    supplier: { id: r.user_id, name: `${r.first_name} ${r.last_name}`, email: r.email },
    displayName: r.display_name,
    categoryCode: r.category_code,
    categoryLabel: r.category_label,
    status: r.status,
    pausedUntil: r.paused_until ? (typeof r.paused_until === "string" ? r.paused_until : r.paused_until.toISOString()).slice(0, 10) : null,
    adminPaused: r.admin_paused,
    adminPauseReason: r.admin_pause_reason,
    publishedAt: iso(r.published_at),
    lastConfirmedAt: iso(r.last_confirmed_at),
    updatedAt: iso(r.updated_at)!,
    openReports: Number(r.open_reports),
    suggestionsShown: Number(r.suggestions_shown),
    introductions: Number(r.introductions),
  }));
}

export async function marketplaceCounters(ctx: Ctx): Promise<Counters> {
  const count = <T extends string>(rows: { key: T; n: string | number }[]): Record<string, number> => Object.fromEntries(rows.map((r) => [r.key, Number(r.n)]));
  const storefronts = count(await ctx.db.selectFrom("storefronts").select([sql<string>`case when admin_paused then 'suspended' else status::text end`.as("key"), sql<number>`count(*)`.as("n")]).groupBy("key").execute());
  const suggestions = count(await ctx.db.selectFrom("suggestions").select([sql<string>`status::text`.as("key"), sql<number>`count(*)`.as("n")]).groupBy("key").execute());
  const introductions = count(await ctx.db.selectFrom("introductions").select([sql<string>`status::text`.as("key"), sql<number>`count(*)`.as("n")]).groupBy("key").execute());
  const reports = count(await ctx.db.selectFrom("listing_reports").select([sql<string>`status::text`.as("key"), sql<number>`count(*)`.as("n")]).groupBy("key").execute());
  const categories = await ctx.db.selectFrom("service_categories").select(["code", "label"]).orderBy("sort_order").execute();
  const eligible = await storefrontStore(ctx.db).listEligible(ctx.now.toISOString().slice(0, 10));
  const byCategory = new Map<string, number>();
  const byDepartement = new Map<string, number>();
  for (const sf of eligible) {
    if (sf.categoryCode) byCategory.set(sf.categoryCode, (byCategory.get(sf.categoryCode) ?? 0) + 1);
    for (const dep of servedDepartements(sf)) byDepartement.set(dep, (byDepartement.get(dep) ?? 0) + 1);
    if (sf.modes.includes("remote")) byDepartement.set("à distance", (byDepartement.get("à distance") ?? 0) + 1);
  }
  return {
    storefronts: { draft: storefronts.draft ?? 0, published: storefronts.published ?? 0, paused: storefronts.paused ?? 0, suspended: storefronts.suspended ?? 0 },
    eligibleByCategory: categories.filter((c) => byCategory.has(c.code)).map((c) => ({ code: c.code, label: c.label, count: byCategory.get(c.code)! })),
    eligibleByDepartement: [...byDepartement.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([departement, n]) => ({ departement, count: n })),
    suggestions: { shown: suggestions.shown ?? 0, interested: suggestions.interested ?? 0, dismissed: suggestions.dismissed ?? 0, muted: suggestions.muted ?? 0, expired: suggestions.expired ?? 0 },
    introductions: { requested: introductions.requested ?? 0, question: introductions.question ?? 0, connected: introductions.connected ?? 0, declined: introductions.declined ?? 0, expired: introductions.expired ?? 0 },
    reports: { open: reports.open ?? 0, reviewed: reports.reviewed ?? 0, dismissed: reports.dismissed ?? 0 },
  };
}

export async function getStorefrontDetail(ctx: Ctx, id: string): Promise<StorefrontDetail> {
  const row = (await listStorefronts(ctx)).find((s) => s.id === id);
  const storefront = await storefrontStore(ctx.db).getById(id);
  if (!row || !storefront) throw new Rejection("not_found", "Cette vitrine est introuvable.", 404);
  const categories = await matchStore(ctx.db).listCategories();
  const names = async (ids: (string | null)[]) => {
    const wanted = [...new Set(ids.filter((v): v is string => v !== null))];
    if (wanted.length === 0) return new Map<string, string>();
    const users = await ctx.db.selectFrom("users").select(["id", "first_name", "last_name", "role"]).where("id", "in", wanted).execute();
    return new Map(users.map((u) => [u.id, u.role === "admin" ? `${u.first_name} ${u.last_name}` : u.first_name]));
  };

  const reports = await matchStore(ctx.db).listReports({ storefrontId: id });
  const suggestionRows = await ctx.db
    .selectFrom("suggestions as g")
    .leftJoin("service_requests as r", "r.id", "g.request_id")
    .select(["g.id", "g.buyer_user_id", "r.text", "g.reason", "g.internal_reason", "g.score", "g.fit", "g.status", "g.shown_at"])
    .where("g.storefront_id", "=", id)
    .orderBy("g.shown_at", "desc")
    .limit(30)
    .execute();
  const logRows = await ctx.db
    .selectFrom("service_requests")
    .select(["id", "user_id", "last_matched_at", "match_log"])
    .where(sql<boolean>`match_log @> ${JSON.stringify([{ storefrontId: id }])}::jsonb`)
    .orderBy("last_matched_at", "desc")
    .limit(30)
    .execute();
  const introductionRows = await ctx.db.selectFrom("introductions").select(["id", "buyer_user_id", "status", "requested_at", "answered_at"]).where("storefront_id", "=", id).orderBy("requested_at", "desc").execute();
  const auditRows = await ctx.db
    .selectFrom("admin_audit_log as l")
    .leftJoin("users as a", "a.id", "l.admin_user_id")
    .select(["l.action_type", "l.occurred_at", "l.details", "a.first_name", "a.last_name"])
    .where("l.entity_type", "=", "storefront")
    .where("l.entity_id", "=", id)
    .orderBy("l.occurred_at", "desc")
    .limit(30)
    .execute();
  const people = await names([...reports.map((r) => r.reporterUserId), ...reports.map((r) => r.adminUserId), ...suggestionRows.map((s) => s.buyer_user_id), ...logRows.map((l) => l.user_id), ...introductionRows.map((i) => i.buyer_user_id)]);

  return {
    storefront: row,
    preview: buyerPreview(storefront, categories),
    provenance: storefront.provenance,
    categories,
    reports: reports.map((r) => ({ ...r, reasonLabel: REPORT_REASON_LABEL[r.reason], reporterFirstName: r.reporterUserId ? (people.get(r.reporterUserId) ?? null) : null, adminName: r.adminUserId ? (people.get(r.adminUserId) ?? null) : null })),
    suggestions: suggestionRows.map((s) => ({ id: s.id, buyerFirstName: people.get(s.buyer_user_id) ?? null, requestText: s.text, reason: s.reason, internalReason: s.internal_reason, score: s.score === null ? null : Number(s.score), fit: s.fit, status: s.status, shownAt: iso(s.shown_at)! })),
    matchLog: logRows.flatMap((l) => ((Array.isArray(l.match_log) ? l.match_log : []) as unknown as MatchLogEntry[]).filter((e) => e.storefrontId === id).map((entry) => ({ requestId: l.id, buyerFirstName: people.get(l.user_id) ?? null, at: iso(l.last_matched_at), entry }))),
    introductions: introductionRows.map((i) => ({ id: i.id, buyerFirstName: people.get(i.buyer_user_id) ?? null, status: i.status, requestedAt: iso(i.requested_at)!, answeredAt: iso(i.answered_at) })),
    audit: auditRows.map((a) => ({ action: a.action_type, at: iso(a.occurred_at)!, admin: a.first_name ? `${a.first_name} ${a.last_name}` : null, details: a.details })),
  };
}

/** Suspension par l'administrateur (ou levée) : la vitrine sort des suggestions, le fournisseur voit la raison. */
export async function setAdminPause(ctx: Ctx, adminId: string, id: string, paused: boolean, reason: string | null): Promise<void> {
  const store = storefrontStore(ctx.db);
  const storefront = await store.getById(id);
  if (!storefront) throw new Rejection("not_found", "Cette vitrine est introuvable.", 404);
  if (paused && !reason?.trim()) throw new Rejection("reason_required", "Indiquez la raison de la suspension : elle est montrée au fournisseur.");
  await store.setState(storefront.userId, { adminPaused: paused, adminPauseReason: paused ? reason!.trim() : null });
  await logAdminAction(ctx.db, { adminId, action: paused ? "storefront_paused" : "storefront_resumed", entityType: "storefront", entityId: id, details: paused ? { reason: reason!.trim() } : undefined, now: ctx.now });
}

/** Correction de catégorie par l'administrateur : la catégorie corrigée vaut confirmation (US-17). */
export async function remapCategory(ctx: Ctx, adminId: string, id: string, categoryCode: string): Promise<void> {
  const store = storefrontStore(ctx.db);
  const storefront = await store.getById(id);
  if (!storefront) throw new Rejection("not_found", "Cette vitrine est introuvable.", 404);
  const known = (await store.listCategories()).some((c) => c.code === categoryCode);
  if (!known) throw new Rejection("unknown_category", "Cette catégorie n'existe pas.");
  if (storefront.categoryCode === categoryCode) return;
  await store.save(storefront.userId, { categoryCode }, { category: "confirmed" });
  await logAdminAction(ctx.db, { adminId, action: "storefront_category_changed", entityType: "storefront", entityId: id, details: { from: storefront.categoryCode, to: categoryCode }, now: ctx.now });
}

/** Décision sur un signalement : « reviewed » (suite donnée, décrite) ou « dismissed » (sans suite). */
export async function reviewReport(ctx: Ctx, adminId: string, reportId: string, status: Exclude<ReportStatus, "open">, decision: string | null): Promise<ListingReport> {
  const store = matchStore(ctx.db);
  const report = await store.getReport(reportId);
  if (!report) throw new Rejection("not_found", "Ce signalement est introuvable.", 404);
  if (report.status !== "open") throw new Rejection("already_reviewed", "Ce signalement a déjà été traité.", 409);
  const reviewed = await store.reviewReport(reportId, { status, adminDecision: decision?.trim() || null, adminUserId: adminId });
  await logAdminAction(ctx.db, { adminId, action: "report_reviewed", entityType: "listing_report", entityId: reportId, details: { storefrontId: report.storefrontId, status, decision: decision?.trim() || null }, now: ctx.now });
  return reviewed;
}
