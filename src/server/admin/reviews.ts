import { sql } from "kysely";
import type { Ctx } from "@/server/auth/service";
import { runAnalysis } from "@/server/contracts/analyze";
import { addManualMask, dbMaskCounts, openBlob, sealBlob } from "@/server/contracts/masked";
import { Rejection } from "@/server/http";
import { describeError } from "@/server/safe-log";
import { logAdminAction } from "./audit";

/**
 * « Analyses à valider » (US-138) : quand un contrat est transmis pour analyse avec une lecture incertaine, l'administrateur décide si l'analyse continue. Il ne voit
 * QUE le texte masqué, la catégorie, le score de lecture et la date limite : jamais le document d'origine, le nom du contrat, ni la famille. La lecture passe par la vue
 * `v_contract_reviews_to_decide` ; chaque consultation et chaque décision sont inscrites dans le journal d'administration (RT3, RF8).
 */

export interface ReviewSummary {
  id: string;
  category: string;
  createdAt: string;
  /** Suppression des documents : sans décision d'ici là, la demande disparaît (RF6). */
  expiresAt: string;
  documents: number;
  /** Score de lecture le plus bas des documents. */
  lowestConfidencePct: number | null;
}

export interface ReviewDocument {
  field: string;
  pages: number;
  confidencePct: number | null;
  /** Texte masqué, page par page (une page retirée porte sa ligne neutre). */
  texts: { text: string; removed: boolean }[];
  /** Mots mal lus par l'OCR (minuscules), à surligner dans le texte. */
  weak: string[];
}

export interface ReviewDetail extends ReviewSummary {
  documentsDetail: ReviewDocument[];
  masksAdded: number;
}

const iso = (value: Date | string) => new Date(value).toISOString();

/** Demandes en attente, de la plus ancienne à la plus récente (RF1). */
export async function listReviews(ctx: Ctx): Promise<ReviewSummary[]> {
  const rows = await ctx.db
    .selectFrom("v_contract_reviews_to_decide")
    .select(["review_id", "category_name", "created_at", "expires_at", "confidence_pct"])
    .where("expires_at", ">", ctx.now)
    .orderBy("created_at")
    .orderBy("review_id")
    .execute();
  const byId = new Map<string, ReviewSummary>();
  for (const r of rows) {
    const id = String(r.review_id);
    const known = byId.get(id);
    if (known) {
      known.documents += 1;
      if (r.confidence_pct !== null) known.lowestConfidencePct = known.lowestConfidencePct === null ? r.confidence_pct : Math.min(known.lowestConfidencePct, r.confidence_pct);
    } else {
      byId.set(id, { id, category: r.category_name ?? "", createdAt: iso(r.created_at!), expiresAt: iso(r.expires_at!), documents: 1, lowestConfidencePct: r.confidence_pct });
    }
  }
  return [...byId.values()];
}

/** Nombre de demandes en attente : affiché sur l'entrée du menu (RF1). */
export async function pendingReviewCount(ctx: Ctx): Promise<number> {
  const row = await ctx.db.selectFrom("v_contract_reviews_to_decide").select(sql<number>`count(distinct review_id)::int`.as("n")).where("expires_at", ">", ctx.now).executeTakeFirst();
  return row?.n ?? 0;
}

/** Ouvre une demande : le texte masqué des documents. Chaque consultation est journalisée (RT3). */
export async function getReview(ctx: Ctx, adminId: string, reviewId: string): Promise<ReviewDetail> {
  const rows = await ctx.db
    .selectFrom("v_contract_reviews_to_decide")
    .select(["review_id", "category_name", "created_at", "expires_at", "field_name", "page_count", "confidence_pct", "masked_text"])
    .where("review_id", "=", reviewId)
    .where("expires_at", ">", ctx.now)
    .execute();
  if (rows.length === 0) throw new Rejection("not_found", "Cette demande n'existe pas ou n'existe plus.", 404);
  const review = await ctx.db.selectFrom("contract_analysis_reviews").select("masks_added_count").where("id", "=", reviewId).executeTakeFirstOrThrow();
  await logAdminAction(ctx.db, { adminId, action: "contract_review_viewed", entityType: "contract_analysis_review", entityId: reviewId, now: ctx.now });
  const documentsDetail = rows.map<ReviewDocument>((r) => {
    const blob = r.masked_text ? openBlob(r.masked_text) : null;
    return {
      field: r.field_name ?? "",
      pages: r.page_count ?? 0,
      confidencePct: r.confidence_pct,
      texts: (blob?.pages ?? []).map((p) => ({ text: p.text, removed: p.state === "removed" })),
      weak: blob?.weak ?? [],
    };
  });
  const confidences = rows.map((r) => r.confidence_pct).filter((c): c is number => c !== null);
  return {
    id: String(rows[0].review_id),
    category: rows[0].category_name ?? "",
    createdAt: iso(rows[0].created_at!),
    expiresAt: iso(rows[0].expires_at!),
    documents: rows.length,
    lowestConfidencePct: confidences.length ? Math.min(...confidences) : null,
    documentsDetail,
    masksAdded: review.masks_added_count,
  };
}

/** « Masquer aussi ce mot » dans un document de la demande (RF3) : toutes ses occurrences dans ce document ; le nombre de masques ajoutés est gardé, jamais les valeurs. */
export async function addReviewMask(ctx: Ctx, adminId: string, reviewId: string, field: string, word: string): Promise<ReviewDetail> {
  const doc = await ctx.db
    .selectFrom("contract_analysis_reviews as r")
    .innerJoin("contract_transmissions as t", "t.id", "r.transmission_id")
    .innerJoin("contract_field_documents as d", "d.account_contract_id", "t.account_contract_id")
    .innerJoin("contract_document_fields as f", "f.id", "d.field_id")
    .select(["d.id", "d.masked_text"])
    .where("r.id", "=", reviewId)
    .where("r.decision", "is", null)
    .where("r.expires_at", ">", ctx.now)
    .where("f.name", "=", field)
    .executeTakeFirst();
  if (!doc?.masked_text) throw new Rejection("not_found", "Ce document n'existe pas ou n'existe plus.", 404);
  const { blob } = addManualMask(openBlob(doc.masked_text), word);
  await ctx.db.transaction().execute(async (trx) => {
    await trx.updateTable("contract_field_documents").set({ masked_text: sealBlob(blob), updated_at: ctx.now }).where("id", "=", doc.id).execute();
    await trx.deleteFrom("contract_document_mask_counts").where("document_id", "=", doc.id).execute();
    const counts = dbMaskCounts(blob.counts);
    if (counts.length) await trx.insertInto("contract_document_mask_counts").values(counts.map((c) => ({ document_id: doc.id, mask_type: c.mask_type as never, mask_count: c.mask_count }))).execute();
    await trx.updateTable("contract_analysis_reviews").set((eb) => ({ masks_added_count: eb("masks_added_count", "+", 1) })).where("id", "=", reviewId).execute();
  });
  return getReview(ctx, adminId, reviewId);
}

/**
 * Décision (RF4) : « Poursuivre l'analyse » (le texte masqué part à l'agent) ou « Ne pas poursuivre » (analyse annulée, la famille et la personne qui a transmis sont prévenues).
 * La décision est inscrite dans le journal : administrateur, date, décision, nombre de masques ajoutés (RF8).
 */
export async function decideReview(ctx: Ctx, adminId: string, reviewId: string, decision: "continue" | "stop"): Promise<{ decision: "continue" | "stop" }> {
  const review = await ctx.db.selectFrom("contract_analysis_reviews").select(["id", "transmission_id", "decision", "expires_at", "masks_added_count"]).where("id", "=", reviewId).executeTakeFirst();
  if (!review || new Date(review.expires_at) <= ctx.now) throw new Rejection("not_found", "Cette demande n'existe pas ou n'existe plus.", 404);
  if (review.decision) throw new Rejection("already_decided", "Cette demande a déjà reçu une décision.", 409);
  await ctx.db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable("contract_analysis_reviews")
      .set({ decision, decided_by_user_id: adminId, decided_at: ctx.now })
      .where("id", "=", reviewId)
      .where("decision", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!updated) throw new Rejection("already_decided", "Cette demande a déjà reçu une décision.", 409);
    await logAdminAction(trx, { adminId, action: "contract_analysis_decided", entityType: "contract_analysis_review", entityId: reviewId, details: { decision, masksAdded: review.masks_added_count }, now: ctx.now });
  });
  // « Poursuivre » : la base remet l'analyse « en cours » ; elle part tout de suite (le passage de fond la rattraperait sinon).
  if (decision === "continue") await runAnalysis(ctx, review.transmission_id).catch((error) => console.error(`Analyse après décision : ${describeError(error)}`));
  return { decision };
}
