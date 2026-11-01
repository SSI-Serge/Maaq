import { createHmac } from "node:crypto";
import type { Kysely } from "kysely";
import { open } from "@/server/assistant/fields";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { Rejection } from "@/server/http";
import { describeError } from "@/server/safe-log";
import { integerSetting } from "@/server/settings";
import { addManualMask, dbMaskCounts, MASKING_RULES_VERSION, openBlob, removeManualMask, sealBlob, type MaskedBlob } from "./masked";
import { createTokenSpace, maskDocument, residualIssues, type HouseholdFacts } from "./masking/engine";
import { documentReader, ReaderError, type ReadInput } from "./reader";
import { contractView, requireCore, unbundlePhotos, type ContractView } from "./service";
import { loadDocument } from "./storage";
import { analysisMode } from "./analysis";

/**
 * Du dépôt au texte masqué (US-136, US-137) : lecture du document par le service interne, masquage en trois couches, état du document, puis aperçu, masques ajoutés à la main
 * et confirmation par l'utilisateur. Le texte d'origine n'est gardé nulle part : seul le texte masqué est stocké, chiffré, avec le document.
 */

/** Sous cette confiance de lecture, le document est illisible : il se remplace (US-136 RF6). */
const UNREADABLE_BELOW_PCT = 30;
/** Un document dont on tire moins de caractères que cela est illisible, même si la lecture se dit sûre d'elle. */
const MIN_TEXT_CHARS = 30;
/** Un masquage resté « en cours » plus longtemps que cela est repris (le serveur qui le menait s'est arrêté). */
const STALE_MASKING_MINUTES = 15;

const tokenHash = (id: string) => createHmac("sha256", Buffer.from(env().HMAC_KEY, "base64")).update(id, "utf8").digest("hex").slice(0, 24);

/** Ce que MAAQ sait du foyer : prénoms, noms, emails et téléphones (couche 2, US-136 RT2). */
export async function householdFacts(db: Kysely<DB>, accountId: string): Promise<HouseholdFacts> {
  const [members, users] = await Promise.all([
    db
      .selectFrom("family_members as m")
      .leftJoin("users as u", "u.id", "m.user_id")
      .select(["m.id", "m.first_name", "m.birth_year", "m.birth_month", "u.last_name"])
      .where("m.account_id", "=", accountId)
      .where("m.anonymized_at", "is", null)
      .execute(),
    db.selectFrom("users").select(["first_name", "last_name", "email", "phone"]).where("account_id", "=", accountId).where("removed_at", "is", null).execute(),
  ]);
  const surnames = [...new Set([...members.map((m) => m.last_name), ...users.map((u) => u.last_name)].filter((n): n is string => !!n))];
  return {
    people: members
      .filter((m): m is typeof m & { first_name: string } => !!m.first_name)
      .map((m) => ({
        id: m.id,
        firstName: m.first_name,
        lastName: m.last_name ?? surnames[0] ?? null,
        birth: m.birth_year ? `${m.birth_year}${m.birth_month ? `-${String(m.birth_month).padStart(2, "0")}` : ""}` : null,
      })),
    emails: users.map((u) => u.email),
    phones: users.map((u) => u.phone).filter((p): p is string => !!p),
  };
}

type DocumentRow = { id: string; account_contract_id: string; storage_key: string; source_kind: "pdf" | "photos"; file_name: Buffer };

/** Fichiers du document, déchiffrés, dans l'ordre : un PDF, ou les photos regroupées au dépôt. */
async function filesOf(doc: DocumentRow): Promise<ReadInput[]> {
  const bytes = await loadDocument(doc.storage_key);
  if (doc.source_kind === "pdf") return [{ name: open(doc.file_name), mime: "application/pdf", content: bytes }];
  return unbundlePhotos(bytes).map((p, i) => ({ name: `page-${i + 1}`, mime: p.mime, content: p.content }));
}

/** Jetons déjà attribués dans les autres documents du contrat : le même nom garde le même jeton partout (US-136 RF2). */
async function seedTokens(db: Kysely<DB>, contractId: string, exceptDocumentId: string): Promise<MaskedBlob["tokens"]> {
  const rows = await db.selectFrom("contract_field_documents").select("masked_text").where("account_contract_id", "=", contractId).where("id", "<>", exceptDocumentId).where("masked_text", "is not", null).execute();
  const tokens: MaskedBlob["tokens"] = {};
  for (const row of rows) Object.assign(tokens, openBlob(row.masked_text!).tokens);
  return tokens;
}

function seededSpace(tokens: MaskedBlob["tokens"]) {
  const space = createTokenSpace(tokenHash);
  for (const [id, token] of Object.entries(tokens)) {
    space.assigned.set(id, token);
    const m = /^\[([A-Z]+)_(\d+)\]$/.exec(token);
    if (m) space.counters[m[1] as keyof typeof space.counters] = Math.max(space.counters[m[1] as keyof typeof space.counters] ?? 0, Number(m[2]));
  }
  return space;
}

export type ProcessOutcome = "masked" | "unreadable" | "retry" | "skipped";

/**
 * Lit et masque un document en attente. La prise est atomique (« en attente » vers « masquage en cours ») : deux appels simultanés ne le traitent pas deux fois.
 * Un service injoignable remet le document en attente ; un document illisible l'est pour de bon (à remplacer).
 */
export async function processDocument(ctx: Ctx, documentId: string): Promise<ProcessOutcome> {
  const reader = documentReader();
  if (!reader) return "skipped";
  const claimed = await ctx.db
    .updateTable("contract_field_documents")
    .set({ masking_status: "masking", updated_at: ctx.now })
    .where("id", "=", documentId)
    .where("masking_status", "=", "pending")
    .returning(["id", "account_contract_id", "storage_key", "source_kind", "file_name"])
    .executeTakeFirst();
  if (!claimed) return "skipped";

  const release = (status: "pending" | "unreadable") =>
    ctx.db.updateTable("contract_field_documents").set({ masking_status: status, updated_at: ctx.now }).where("id", "=", documentId).where("storage_key", "=", claimed.storage_key).where("masking_status", "=", "masking").execute();

  try {
    const contract = await ctx.db.selectFrom("account_contracts").select("account_id").where("id", "=", claimed.account_contract_id).executeTakeFirstOrThrow();
    const result = await reader.read(await filesOf(claimed));
    const characters = result.pages.reduce((n, p) => n + p.text.trim().length, 0);
    const weight = result.pages.reduce((n, p) => n + Math.max(1, p.text.trim().length), 0);
    const confidence = Math.round(result.pages.reduce((n, p) => n + p.confidence * Math.max(1, p.text.trim().length), 0) / weight);
    if (characters < MIN_TEXT_CHARS || confidence < UNREADABLE_BELOW_PCT) {
      await release("unreadable");
      return "unreadable";
    }

    const tokens = await seedTokens(ctx.db, claimed.account_contract_id, documentId);
    const space = seededSpace(tokens);
    const masked = maskDocument(
      result.pages.map((p) => p.text),
      { household: await householdFacts(ctx.db, contract.account_id), now: ctx.now, space, entities: result.pages.map((p) => p.entities) },
    );
    const blob: MaskedBlob = {
      v: 1,
      pages: masked.pages,
      counts: masked.counts,
      references: masked.references,
      removedHealthPages: masked.removedHealthPages,
      doubtHealthPages: masked.doubtHealthPages,
      manual: [],
      tokens: Object.fromEntries(space.assigned),
    };
    const threshold = await integerSetting(ctx.db, "contract_read_confidence_threshold_pct", 80);
    const status = confidence < threshold ? "uncertain" : "to_verify";
    const saved = await ctx.db.transaction().execute(async (trx) => {
      const updated = await trx
        .updateTable("contract_field_documents")
        .set({ masking_status: status, masked_text: sealBlob(blob), confidence_pct: confidence, masking_tool_version: result.tool.slice(0, 120), masking_rules_version: MASKING_RULES_VERSION, updated_at: ctx.now })
        .where("id", "=", documentId)
        .where("storage_key", "=", claimed.storage_key)
        .where("masking_status", "=", "masking")
        .returning("id")
        .executeTakeFirst();
      if (!updated) return false;
      await trx.deleteFrom("contract_document_mask_counts").where("document_id", "=", documentId).execute();
      const counts = dbMaskCounts(blob.counts);
      if (counts.length) await trx.insertInto("contract_document_mask_counts").values(counts.map((c) => ({ document_id: documentId, mask_type: c.mask_type as never, mask_count: c.mask_count }))).execute();
      return true;
    });
    return saved ? "masked" : "skipped";
  } catch (error) {
    if (error instanceof ReaderError && error.failure === "unreadable") {
      await release("unreadable");
      return "unreadable";
    }
    console.error("[contrats] masquage reporté :", describeError(error));
    await release("pending").catch(() => undefined);
    return "retry";
  }
}

/** Les documents en attente d'un contrat (ou de tous, pour le passage de fond), si l'analyse est ouverte et activée sur le contrat. Un par un : les jetons restent cohérents. */
export async function processPending(ctx: Ctx, options: { contractId?: string; limit?: number } = {}): Promise<{ processed: number; retry: number }> {
  if (analysisMode() === "off" || !documentReader()) return { processed: 0, retry: 0 };
  await ctx.db
    .updateTable("contract_field_documents")
    .set({ masking_status: "pending" })
    .where("masking_status", "=", "masking")
    .where("updated_at", "<", new Date(ctx.now.getTime() - STALE_MASKING_MINUTES * 60_000))
    .execute();
  let query = ctx.db
    .selectFrom("contract_field_documents as d")
    .innerJoin("account_contracts as c", "c.id", "d.account_contract_id")
    .select("d.id")
    .where("d.masking_status", "=", "pending")
    .where("c.analysis_enabled", "=", true)
    .where("d.transmitted_at", "is", null)
    .orderBy("d.uploaded_at")
    .limit(options.limit ?? 20);
  if (options.contractId) query = query.where("d.account_contract_id", "=", options.contractId);
  else query = query.where("d.updated_at", "<", new Date(ctx.now.getTime() - 2 * 60_000));
  let processed = 0;
  let retry = 0;
  for (const row of await query.execute()) {
    const outcome = await processDocument(ctx, row.id);
    if (outcome === "retry") retry += 1;
    else if (outcome !== "skipped") processed += 1;
  }
  return { processed, retry };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Aperçu, masques à la main, confirmation (US-137)
// ---------------------------------------------------------------------------------------------------------------------------

export interface MaskedPreview {
  documentId: string;
  fileName: string;
  status: "to_verify" | "uncertain" | "verified";
  confidencePct: number | null;
  pages: { text: string; removed: boolean }[];
  /** Jetons posés à la main, annulables : le jeton, ce qu'il remplace et combien de fois. */
  manual: { token: string; occurrences: number }[];
  /** Types de motifs personnels qui restent visibles (« email », « nom connu »…), jamais une valeur. */
  residual: string[];
  removedHealthPages: number;
  /** Page de santé douteuse restée dans le texte : l'analyse est bloquée (US-136 RF5). */
  healthDoubt: boolean;
  verifiedByFirstName: string | null;
  verifiedAt: string | null;
}

async function ownMaskedDocument(ctx: Ctx, accountId: string, documentId: string) {
  const row = await ctx.db
    .selectFrom("contract_field_documents as d")
    .innerJoin("account_contracts as c", "c.id", "d.account_contract_id")
    .select(["d.id", "d.account_contract_id", "d.file_name", "d.masking_status", "d.masked_text", "d.confidence_pct", "d.verified_by_user_id", "d.verified_at", "d.transmitted_at", "d.expires_at"])
    .where("d.id", "=", documentId)
    .where("c.account_id", "=", accountId)
    .executeTakeFirst();
  if (!row) throw new Rejection("not_found", "Ce document n'existe pas ou n'existe plus.", 404);
  return row;
}

async function previewOf(ctx: Ctx, accountId: string, row: Awaited<ReturnType<typeof ownMaskedDocument>>): Promise<MaskedPreview> {
  if (!row.masked_text || (row.masking_status !== "to_verify" && row.masking_status !== "uncertain" && row.masking_status !== "verified"))
    throw new Rejection("not_ready", "Le texte masqué de ce document n'est pas encore prêt.", 409);
  const blob = openBlob(row.masked_text);
  const visible = blob.pages.filter((p) => p.state !== "removed").map((p) => p.text).join("\n\n");
  const verifier = row.verified_by_user_id ? await ctx.db.selectFrom("users").select("first_name").where("id", "=", row.verified_by_user_id).executeTakeFirst() : null;
  return {
    documentId: row.id,
    fileName: open(row.file_name),
    status: row.masking_status,
    confidencePct: row.confidence_pct,
    pages: blob.pages.map((p) => ({ text: p.text, removed: p.state === "removed" })),
    manual: blob.manual.map((m) => ({ token: m.token, occurrences: m.originals.length })),
    residual: residualIssues(visible, { household: await householdFacts(ctx.db, accountId), now: ctx.now }),
    removedHealthPages: blob.removedHealthPages,
    healthDoubt: blob.doubtHealthPages > 0,
    verifiedByFirstName: verifier?.first_name ?? null,
    verifiedAt: row.verified_at ? new Date(row.verified_at).toISOString() : null,
  };
}

export async function maskedPreview(ctx: Ctx, session: SessionContext, documentId: string): Promise<MaskedPreview> {
  const accountId = requireCore(session);
  return previewOf(ctx, accountId, await ownMaskedDocument(ctx, accountId, documentId));
}

/** Un document déjà vérifié, transmis ou supprimé bientôt ne se retouche plus : pour changer son masquage, on le remplace. */
function editable(row: Awaited<ReturnType<typeof ownMaskedDocument>>) {
  if (row.masking_status !== "to_verify" && row.masking_status !== "uncertain") throw new Rejection("not_editable", "Ce document est déjà vérifié : remplacez-le pour refaire le masquage.", 409);
  if (row.transmitted_at) throw new Rejection("locked", "Ce document a été transmis.", 409);
}

async function saveBlob(ctx: Ctx, row: Awaited<ReturnType<typeof ownMaskedDocument>>, blob: MaskedBlob) {
  await ctx.db.transaction().execute(async (trx) => {
    const updated = await trx.updateTable("contract_field_documents").set({ masked_text: sealBlob(blob), updated_at: ctx.now }).where("id", "=", row.id).where("masking_status", "=", row.masking_status).returning("id").executeTakeFirst();
    if (!updated) throw new Rejection("conflict", "Le document vient de changer : rouvrez l'aperçu.", 409);
    await trx.deleteFrom("contract_document_mask_counts").where("document_id", "=", row.id).execute();
    const counts = dbMaskCounts(blob.counts);
    if (counts.length) await trx.insertInto("contract_document_mask_counts").values(counts.map((c) => ({ document_id: row.id, mask_type: c.mask_type as never, mask_count: c.mask_count }))).execute();
  });
}

/** « Masquer aussi ce mot » (US-137 RF3). */
export async function addMask(ctx: Ctx, session: SessionContext, documentId: string, word: string): Promise<MaskedPreview> {
  const accountId = requireCore(session);
  const row = await ownMaskedDocument(ctx, accountId, documentId);
  editable(row);
  if (!row.masked_text) throw new Rejection("not_ready", "Le texte masqué de ce document n'est pas encore prêt.", 409);
  const { blob } = addManualMask(openBlob(row.masked_text), word);
  await saveBlob(ctx, row, blob);
  return previewOf(ctx, accountId, await ownMaskedDocument(ctx, accountId, documentId));
}

/** Annule un masque posé à la main (US-137 RF3). */
export async function removeMask(ctx: Ctx, session: SessionContext, documentId: string, token: string): Promise<MaskedPreview> {
  const accountId = requireCore(session);
  const row = await ownMaskedDocument(ctx, accountId, documentId);
  editable(row);
  if (!row.masked_text) throw new Rejection("not_ready", "Le texte masqué de ce document n'est pas encore prêt.", 409);
  await saveBlob(ctx, row, removeManualMask(openBlob(row.masked_text), token));
  return previewOf(ctx, accountId, await ownMaskedDocument(ctx, accountId, documentId));
}

/** « Confirmer ce document » (US-137 RF4) : refusé tant qu'une page de santé douteuse reste dans le texte. */
export async function verifyDocument(ctx: Ctx, session: SessionContext, documentId: string): Promise<MaskedPreview> {
  const accountId = requireCore(session);
  const row = await ownMaskedDocument(ctx, accountId, documentId);
  editable(row);
  if (!row.masked_text) throw new Rejection("not_ready", "Le texte masqué de ce document n'est pas encore prêt.", 409);
  if (openBlob(row.masked_text).doubtHealthPages > 0) throw new Rejection("health_doubt", "Ce document contient peut-être des données de santé : il ne peut pas être confirmé. Retirez-le.", 422);
  try {
    await ctx.db.updateTable("contract_field_documents").set({ masking_status: "verified", verified_by_user_id: session.user.id, verified_at: ctx.now, updated_at: ctx.now }).where("id", "=", documentId).execute();
  } catch (error) {
    throw new Rejection("conflict", "Le document vient de changer : rouvrez l'aperçu.", 409, { reason: describeError(error) });
  }
  return previewOf(ctx, accountId, await ownMaskedDocument(ctx, accountId, documentId));
}


/** Lit et masque les documents en attente d'un contrat (appelé par l'écran après un dépôt ou l'activation de l'analyse) et renvoie le contrat à jour. */
export async function processContract(ctx: Ctx, session: SessionContext, contractId: string): Promise<ContractView> {
  const accountId = requireCore(session);
  await contractView(ctx, accountId, contractId); // refuse un contrat qui n'est pas celui du compte
  await processPending(ctx, { contractId });
  return contractView(ctx, accountId, contractId);
}
