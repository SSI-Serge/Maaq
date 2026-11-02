import { sql, type Kysely } from "kysely";
import { open, seal } from "@/server/assistant/fields";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { Rejection } from "@/server/http";
import { emailFingerprint } from "@/server/security/crypto";
import { integerSetting } from "@/server/settings";
import { analysisMode, type AnalysisMode } from "./analysis";
import { openBlob } from "./masked";
import { displayReport } from "./report";
import { planTransmission, type TransmitPlan } from "./plan";
import { loadDocument, objectStore, storeDocument } from "./storage";
import type { DocumentState } from "./transmission";

/**
 * Contrats de la famille, version 2 (US-124 à US-128, US-133 à US-135) : un contrat de base par catégorie, créé d'office, et des contrats complémentaires ; pour chacun, les
 * détails texte (US-33), les documents des champs attendus (US-126), les interrupteurs « Analyse IA » et « Challenge » avec leur preuve de consentement (CT-4). Remplace la V1
 * (documents classés dans le Drive, consentement par catégorie). La transmission (E3), le masquage (E4) et l'analyse (E5) viennent ensuite.
 */

export type FieldType = "text" | "date" | "amount" | "choice";
export type MaskingStatus = "pending" | "masking" | "to_verify" | "verified" | "uncertain" | "unreadable";
type Channel = "analysis" | "challenge";

export interface FieldView {
  id: string;
  label: string;
  type: FieldType;
  required: boolean;
  options: { id: string; label: string }[];
  /** Texte, date ISO (AAAA-MM-JJ), montant (« 12.50 ») ou identifiant du choix ; null si non renseigné. */
  value: string | null;
}

export interface DocumentView {
  id: string;
  fileName: string;
  kind: "pdf" | "photos";
  pages: number;
  sizeBytes: number;
  uploadedAt: string;
  uploadedByFirstName: string | null;
  transmittedAt: string | null;
  /** Date de suppression : 48 h après la transmission, sinon 30 jours après le dépôt. */
  expiresAt: string;
  /** Verrouillé pendant les 48 h qui suivent la transmission : ni remplacement, ni retrait (US-126 RF8). */
  locked: boolean;
  masking: { status: MaskingStatus; confidencePct: number | null; verifiedByFirstName: string | null; verifiedAt: string | null; healthDoubt: boolean; removedHealthPages: number };
}

export interface DocumentSlot {
  fieldId: string;
  name: string;
  help: string | null;
  required: boolean;
  document: DocumentView | null;
}

export interface SwitchView {
  enabled: boolean;
  byFirstName: string | null;
  at: string | null;
}

export interface TransmissionView {
  at: string;
  byFirstName: string | null;
  forAnalysis: boolean;
  forChallenge: boolean;
  analysisStatus: "running" | "awaiting_admin" | "completed" | "failed" | "cancelled" | null;
  challengeStatus: "sending" | "sent" | "failed" | null;
  /** 48 h après la transmission : les documents sont supprimés (US-134). */
  documentsDeletedAt: string;
}

export interface ContractView {
  id: string;
  categoryId: string;
  name: string;
  isBase: boolean;
  createdBy: { firstName: string | null; at: string } | null;
  /** Détails ou documents saisis (« Renseigné »). */
  filled: boolean;
  analysis: SwitchView;
  challenge: SwitchView;
  modified: { byFirstName: string | null; at: string } | null;
  fields: FieldView[];
  slots: DocumentSlot[];
  /** Champs obligatoires encore vides (US-126 RF5 : « N document(s) obligatoire(s) manquant(s) » ou « Prêt à transmettre »). */
  missingRequired: number;
  transmission: TransmissionView | null;
  /** Date du rapport d'analyse courant (US-132 RF5) ; le rapport lui-même vient avec E5. */
  reportAt: string | null;
  /** Rapport d'analyse (US-132) : HTML nettoyé, jetons déjà résolus (prénoms des membres) ou en forme neutre. */
  report: { html: string; generatedAt: string } | null;
  /** Ce que « Transmettre » ferait (US-129) : canaux, blocages, proposition d'activer l'autre canal (US-130). */
  transmit: TransmitPlan;
  /** Un email de challenge est parti depuis moins de 48 h : la suppression ne peut pas le rappeler (US-133 RF4). */
  challengeSentRecently: boolean;
}

export interface CategoryView {
  id: string;
  name: string;
  archived: boolean;
  archivedAt: string | null;
  /** « + Ajouter un contrat » : faux dans une catégorie archivée ou au plafond (US-124 RF3). */
  canAdd: boolean;
  atLimit: boolean;
  contracts: ContractView[];
}

export interface ContractsView {
  limits: { maxDocumentMb: number; maxContracts: number };
  analysis: { mode: AnalysisMode; text: string };
  challenge: { available: boolean; brokerName: string | null; text: string };
  categories: CategoryView[];
}

/** Texte PROVISOIRE du consentement à l'analyse, clairement marqué : le texte du DPO n'est pas livré (C-07). */
export const PROVISIONAL_ANALYSIS_TEXT =
  "[Texte provisoire, en attente de l'avis du DPO] Les documents de ce contrat seront analysés automatiquement par une intelligence artificielle (service Anthropic, en Union européenne ou aux États-Unis selon le contrat de service), puis supprimés 48 h après la transmission. Seul le rapport est conservé.";
const PROVISIONAL_LABEL = "provisoire";

const MEGABYTE = 1_048_576;
const MAX_NAME = 60;
const MAX_PHOTOS = 10;

/** Les contrats ne concernent que le noyau du compte : utilisateur principal et invité 1 (US-30 RF3, US-32 RT1). */
export function requireCore(session: SessionContext): string {
  const isCore = session.user.role === "primary_user" || (session.user.role === "guest" && session.user.guestRank === "core");
  if (!isCore || !session.user.accountId) throw new Rejection("forbidden", "Les contrats sont réservés à l'utilisateur principal et à l'invité 1.", 403);
  return session.user.accountId;
}

/** Ce que le texte masqué dit de la santé : pages retirées (signalées à la famille) et page douteuse restée (analyse bloquée, US-136 RF5). */
function healthOf(maskedText: Buffer | null): { healthDoubt: boolean; removedHealthPages: number } {
  if (!maskedText) return { healthDoubt: false, removedHealthPages: 0 };
  const blob = openBlob(maskedText);
  return { healthDoubt: blob.doubtHealthPages > 0, removedHealthPages: blob.removedHealthPages };
}

const iso = (value: Date | string | null | undefined) => (value ? new Date(value).toISOString() : null);

/** Refus de la base (message en français, violation de contrainte) → refus de l'application ; les autres erreurs passent telles quelles. */
function dbRefusal(error: unknown): unknown {
  const e = error as { code?: string; message?: string; constraint?: string };
  if (e.code === "23505" && e.constraint === "ux_account_contracts_name") return new Rejection("duplicate_name", "Un contrat porte déjà ce nom dans cette catégorie.", 409);
  if (e.code === "23514" && e.message) {
    const text = e.message.replace(/ \(.*$/, "");
    return new Rejection("rule_refused", /[.!?]$/.test(text) ? text : `${text}.`, 409);
  }
  return error;
}

// ---------------------------------------------------------------------------
// Textes de consentement
// ---------------------------------------------------------------------------

async function consentVersion(db: Kysely<DB>, channel: Channel, now: Date, create = false): Promise<{ id: string; content: string }> {
  const type = channel === "analysis" ? "contract_analysis_consent" : "contract_challenge_consent";
  const find = () =>
    db.selectFrom("legal_document_versions").select(["id", "content"]).where("document_type", "=", type).where("published_at", "<=", now).orderBy("published_at", "desc").orderBy("id", "desc").executeTakeFirst();
  const existing = await find();
  if (existing) return existing;
  if (channel === "analysis" && create) {
    // Aucun texte du DPO n'est publié : le texte provisoire, marqué comme tel, sert de version tant qu'il n'est pas remplacé.
    await db
      .insertInto("legal_document_versions")
      .values({ document_type: type, version_label: PROVISIONAL_LABEL, content: PROVISIONAL_ANALYSIS_TEXT, published_at: new Date(0) })
      .onConflict((oc) => oc.columns(["document_type", "version_label"]).doNothing())
      .execute();
    const created = await find();
    if (created) return created;
  }
  if (channel === "analysis") return { id: "", content: PROVISIONAL_ANALYSIS_TEXT };
  throw new Error("Aucun texte de consentement publié");
}

async function brokerName(db: Kysely<DB>): Promise<string | null> {
  const row = await db.selectFrom("platform_settings").select("value_text").where("setting_key", "=", "contract_broker_name").executeTakeFirst();
  return row?.value_text?.trim() || null;
}

async function challengeAvailable(db: Kysely<DB>): Promise<boolean> {
  return (await sql<{ ok: boolean }>`select contract_challenge_available() as ok`.execute(db)).rows[0]?.ok ?? false;
}

// ---------------------------------------------------------------------------
// Lecture : « Mes contrats »
// ---------------------------------------------------------------------------

type Contract = { id: string; contract_definition_id: string };

async function loadView(ctx: Ctx, accountId: string): Promise<ContractsView> {
  const db = ctx.db;
  const [mine, maxDocumentMb, maxContracts, confidenceThresholdPct, available, broker] = await Promise.all([
    db.selectFrom("account_contracts").selectAll().where("account_id", "=", accountId).orderBy("created_at").orderBy("id").execute(),
    integerSetting(db, "max_document_size_mb", 15),
    integerSetting(db, "max_contracts_per_category", 20),
    integerSetting(db, "contract_read_confidence_threshold_pct", 80),
    challengeAvailable(db),
    brokerName(db),
  ]);
  const used = new Set(mine.map((c) => c.contract_definition_id));
  const definitions = (
    await db.selectFrom("contract_definitions").select(["id", "name", "archived_at", "sort_order"]).orderBy("sort_order").orderBy("id").execute()
  ).filter((d) => d.archived_at === null || used.has(d.id));
  const defIds = definitions.map((d) => d.id);
  const contractIds = mine.map((c) => c.id);

  const [fields, options, docFields, values, documents, transmissions, reports] = await Promise.all([
    defIds.length
      ? db.selectFrom("contract_field_definitions").select(["id", "contract_definition_id", "label", "field_type", "is_required"]).where("contract_definition_id", "in", defIds).where("archived_at", "is", null).orderBy("sort_order").orderBy("id").execute()
      : [],
    defIds.length
      ? db
          .selectFrom("contract_field_options as o")
          .innerJoin("contract_field_definitions as f", "f.id", "o.field_definition_id")
          .select(["o.id", "o.field_definition_id", "o.label"])
          .where("f.contract_definition_id", "in", defIds)
          .orderBy("o.sort_order")
          .orderBy("o.id")
          .execute()
      : [],
    defIds.length
      ? db.selectFrom("contract_document_fields").select(["id", "contract_definition_id", "name", "help", "is_required"]).where("contract_definition_id", "in", defIds).orderBy("sort_order").orderBy("id").execute()
      : [],
    contractIds.length
      ? db
          .selectFrom("contract_field_values")
          .select(["account_contract_id", "field_definition_id", "value_text", "value_amount", "value_option_id", sql<string | null>`to_char(value_date, 'YYYY-MM-DD')`.as("value_date")])
          .where("account_contract_id", "in", contractIds)
          .execute()
      : [],
    contractIds.length ? db.selectFrom("contract_field_documents").selectAll().where("account_contract_id", "in", contractIds).execute() : [],
    contractIds.length ? db.selectFrom("contract_transmissions").selectAll().where("account_contract_id", "in", contractIds).orderBy("transmitted_at", "desc").execute() : [],
    contractIds.length ? db.selectFrom("contract_reports").select(["account_contract_id", "generated_at", "html"]).where("account_contract_id", "in", contractIds).execute() : [],
  ]);

  const userIds = [
    ...new Set(
      [
        ...mine.flatMap((m) => [m.consent_changed_by_user_id, m.analysis_changed_by_user_id, m.last_modified_by_user_id, m.created_by_user_id]),
        ...documents.flatMap((d) => [d.uploaded_by_user_id, d.verified_by_user_id]),
        ...transmissions.map((t) => t.transmitted_by_user_id),
      ].filter((id): id is string => id !== null),
    ),
  ];
  const memberNames = new Map(
    reports.length ? (await db.selectFrom("family_members").select(["id", "first_name"]).where("account_id", "=", accountId).where("anonymized_at", "is", null).execute()).flatMap((m) => (m.first_name ? [[m.id, m.first_name] as const] : [])) : [],
  );
  const names = new Map(userIds.length ? (await db.selectFrom("users").select(["id", "first_name"]).where("id", "in", userIds).execute()).map((u) => [u.id, u.first_name] as const) : []);
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? null) : null);

  const [analysisVersion, challengeVersion] = await Promise.all([consentVersion(db, "analysis", ctx.now), consentVersion(db, "challenge", ctx.now)]);
  const fieldViews = (defId: string, own: Contract) =>
    fields
      .filter((f) => f.contract_definition_id === defId)
      .map<FieldView>((f) => {
        const v = values.find((x) => x.account_contract_id === own.id && x.field_definition_id === f.id);
        const value = v ? (f.field_type === "text" ? v.value_text : f.field_type === "date" ? v.value_date : f.field_type === "amount" ? v.value_amount : (v.value_option_id ?? null)) : null;
        return {
          id: f.id,
          label: f.label,
          type: f.field_type,
          required: f.is_required,
          options: options.filter((o) => o.field_definition_id === f.id).map((o) => ({ id: o.id, label: o.label })),
          value: value === null ? null : String(value),
        };
      });

  const categories = definitions.map<CategoryView>((def) => {
    const archived = def.archived_at !== null;
    const own = mine.filter((c) => c.contract_definition_id === def.id).sort((a, b) => Number(b.is_base) - Number(a.is_base));
    const contracts = own.map<ContractView>((c) => {
      const slots = docFields
        .filter((f) => f.contract_definition_id === def.id)
        .map<DocumentSlot>((f) => {
          const d = documents.find((x) => x.account_contract_id === c.id && x.field_id === f.id);
          return {
            fieldId: f.id,
            name: f.name,
            help: f.help,
            required: f.is_required,
            document: d
              ? {
                  id: d.id,
                  fileName: open(d.file_name),
                  kind: d.source_kind,
                  pages: d.page_count,
                  sizeBytes: Number(d.size_bytes),
                  uploadedAt: iso(d.uploaded_at)!,
                  uploadedByFirstName: nameOf(d.uploaded_by_user_id),
                  transmittedAt: iso(d.transmitted_at),
                  expiresAt: iso(d.expires_at)!,
                  locked: d.transmitted_at !== null && new Date(d.expires_at) > ctx.now,
                  masking: { status: d.masking_status, confidencePct: d.confidence_pct, verifiedByFirstName: nameOf(d.verified_by_user_id), verifiedAt: iso(d.verified_at), ...healthOf(d.masked_text) },
                }
              : null,
          };
        });
      const last = transmissions.find((t) => t.account_contract_id === c.id);
      const report = reports.find((r) => r.account_contract_id === c.id);
      const detailValues = values.filter((v) => v.account_contract_id === c.id);
      const contract: Omit<ContractView, "transmit"> = {
        id: c.id,
        categoryId: def.id,
        name: c.name,
        isBase: c.is_base,
        createdBy: !c.is_base ? { firstName: nameOf(c.created_by_user_id), at: iso(c.created_at)! } : null,
        filled: detailValues.length > 0 || slots.some((s) => s.document),
        analysis: { enabled: c.analysis_enabled, byFirstName: nameOf(c.analysis_changed_by_user_id), at: iso(c.analysis_changed_at) },
        challenge: { enabled: c.consent_active, byFirstName: nameOf(c.consent_changed_by_user_id), at: iso(c.consent_changed_at) },
        modified: c.last_modified_at ? { byFirstName: nameOf(c.last_modified_by_user_id), at: iso(c.last_modified_at)! } : null,
        fields: fieldViews(def.id, c),
        slots,
        missingRequired: slots.filter((s) => s.required && !s.document).length,
        transmission: last
          ? {
              at: iso(last.transmitted_at)!,
              byFirstName: nameOf(last.transmitted_by_user_id),
              forAnalysis: last.for_analysis,
              forChallenge: last.for_challenge,
              analysisStatus: last.analysis_status,
              challengeStatus: last.challenge_status,
              documentsDeletedAt: new Date(new Date(last.transmitted_at).getTime() + 48 * 3_600_000).toISOString(),
            }
          : null,
        reportAt: iso(report?.generated_at),
        report: report ? { html: displayReport(open(report.html), memberNames), generatedAt: iso(report.generated_at)! } : null,
        challengeSentRecently: transmissions.some((t) => t.account_contract_id === c.id && t.challenge_sent_at !== null && ctx.now.getTime() - new Date(t.challenge_sent_at).getTime() < 48 * 3_600_000),
      };
      return { ...contract, transmit: planTransmission(contract, { analysisOpen: analysisMode() !== "off", challengeAvailable: available, archived, now: ctx.now, confidenceThresholdPct }) };
    });
    const atLimit = own.length >= maxContracts;
    return { id: def.id, name: def.name, archived, archivedAt: iso(def.archived_at), canAdd: !archived && !atLimit, atLimit, contracts };
  });

  return {
    limits: { maxDocumentMb, maxContracts },
    analysis: { mode: analysisMode(), text: analysisVersion.content },
    challenge: { available, brokerName: broker, text: broker ? challengeVersion.content.replace("[nom du partenaire]", broker) : challengeVersion.content },
    categories,
  };
}

/** Onglet « Mes contrats » : le contrat de base de chaque catégorie proposée est créé d'office (US-124 RF1), puis les contrats sont regroupés par catégorie. */
export async function getContracts(ctx: Ctx, session: SessionContext): Promise<ContractsView> {
  const accountId = requireCore(session);
  await sql`select ensure_base_contracts(${accountId}::uuid, ${session.user.id}::uuid)`.execute(ctx.db);
  return loadView(ctx, accountId);
}

export async function contractView(ctx: Ctx, accountId: string, contractId: string): Promise<ContractView> {
  const view = await loadView(ctx, accountId);
  const found = view.categories.flatMap((c) => c.contracts).find((c) => c.id === contractId);
  if (!found) throw new Rejection("not_found", "Ce contrat n'existe pas ou n'existe plus.", 404);
  return found;
}

/** Contrat de la famille (jamais celui d'une autre) ; sert de contrôle d'accès à toutes les opérations. */
async function ownContract(db: Kysely<DB>, accountId: string, contractId: string, forUpdate = false) {
  let query = db.selectFrom("account_contracts").selectAll().where("id", "=", contractId).where("account_id", "=", accountId);
  if (forUpdate) query = query.forUpdate();
  const row = await query.executeTakeFirst();
  if (!row) throw new Rejection("not_found", "Ce contrat n'existe pas ou n'existe plus.", 404);
  return row;
}

// ---------------------------------------------------------------------------
// Contrats complémentaires : ajout, nom, suppression (US-124, US-125, US-133)
// ---------------------------------------------------------------------------

function cleanName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) throw new Rejection("invalid_name", "Le nom du contrat est obligatoire.", 422);
  if (name.length > MAX_NAME) throw new Rejection("invalid_name", `Le nom du contrat est limité à ${MAX_NAME} caractères.`, 422);
  return name;
}

/** Ajoute un contrat complémentaire vide dans une catégorie : mêmes champs de documents que la catégorie (US-124 RF2). */
export async function addContract(ctx: Ctx, session: SessionContext, categoryId: string, rawName: string): Promise<ContractView> {
  const accountId = requireCore(session);
  const name = cleanName(rawName);
  try {
    const row = await ctx.db.transaction().execute(async (trx) => {
      const category = await trx.selectFrom("contract_definitions").select(["id", "archived_at"]).where("id", "=", categoryId).executeTakeFirst();
      if (!category) throw new Rejection("not_found", "Cette catégorie n'existe pas.", 404);
      // Le contrat de base d'abord : un premier contrat serait pris pour lui par la base.
      await sql`select ensure_base_contracts(${accountId}::uuid, ${session.user.id}::uuid)`.execute(trx);
      return trx
        .insertInto("account_contracts")
        .values({ account_id: accountId, contract_definition_id: categoryId, name, created_by_user_id: session.user.id })
        .returning("id")
        .executeTakeFirstOrThrow();
    });
    return await contractView(ctx, accountId, row.id);
  } catch (error) {
    throw dbRefusal(error);
  }
}

/** Renomme un contrat (US-125 RF3) ; le nom reste chez MAAQ, il n'est jamais envoyé à l'agent d'analyse. */
export async function renameContract(ctx: Ctx, session: SessionContext, contractId: string, rawName: string): Promise<ContractView> {
  const accountId = requireCore(session);
  const name = cleanName(rawName);
  await ownContract(ctx.db, accountId, contractId);
  try {
    await ctx.db.updateTable("account_contracts").set({ name, updated_at: ctx.now }).where("id", "=", contractId).where("account_id", "=", accountId).execute();
  } catch (error) {
    throw dbRefusal(error);
  }
  return contractView(ctx, accountId, contractId);
}

async function recordConsent(
  db: Kysely<DB>,
  ctx: Ctx,
  session: SessionContext,
  own: { id: string; account_id: string; contract_definition_id: string },
  channel: Channel,
  action: "granted" | "withdrawn",
  trigger: "user_action" | "contract_details_deleted" | "contract_deleted",
): Promise<void> {
  const version = await consentVersion(db, channel, ctx.now, true);
  await db
    .insertInto("contract_consent_events")
    .values({
      account_id: own.account_id,
      actor_user_id: session.user.id,
      actor_email_hash: emailFingerprint(session.user.email, Buffer.from(env().HMAC_KEY, "base64")),
      contract_definition_id: own.contract_definition_id,
      account_contract_id: own.id,
      channel,
      action_type: action,
      trigger_reason: trigger,
      legal_version_id: version.id,
      occurred_at: ctx.now,
    })
    .execute();
}

/**
 * Supprime un contrat complémentaire (US-133) : détails, documents et rapport partent, les preuves de consentement restent (CT-4). Un consentement encore actif est retiré et
 * journalisé. Le contrat de base ne se supprime pas (la base le refuse). Une analyse en cours disparaît avec le contrat : aucun rapport n'est créé.
 */
export async function deleteContract(ctx: Ctx, session: SessionContext, contractId: string): Promise<{ challengeSentRecently: boolean }> {
  const accountId = requireCore(session);
  const own = await ownContract(ctx.db, accountId, contractId);
  if (own.is_base) throw new Rejection("base_contract", "Le contrat de base d'une catégorie ne se supprime pas : vous pouvez vider ses informations et ses documents.", 409);
  const sentRecently = await ctx.db
    .selectFrom("contract_transmissions")
    .select("id")
    .where("account_contract_id", "=", contractId)
    .where("challenge_sent_at", ">", new Date(ctx.now.getTime() - 48 * 3_600_000))
    .executeTakeFirst();
  try {
    await ctx.db.transaction().execute(async (trx) => {
      const row = await ownContract(trx, accountId, contractId, true);
      if (row.analysis_enabled) await recordConsent(trx, ctx, session, row, "analysis", "withdrawn", "contract_deleted");
      if (row.consent_active) await recordConsent(trx, ctx, session, row, "challenge", "withdrawn", "contract_deleted");
      await trx.deleteFrom("account_contracts").where("id", "=", contractId).execute();
    });
  } catch (error) {
    throw dbRefusal(error);
  }
  return { challengeSentRecently: sentRecently !== undefined };
}

// ---------------------------------------------------------------------------
// Détails d'un contrat (US-33, US-35)
// ---------------------------------------------------------------------------

type Parsed = { ok: true; column: "value_text" | "value_date" | "value_amount" | "value_option_id"; value: string } | { ok: false; error: string };

function parseValue(field: { type: FieldType; options: { id: string }[] }, raw: string): Parsed {
  const value = raw.trim();
  switch (field.type) {
    case "text":
      return value.length <= 500 ? { ok: true, column: "value_text", value } : { ok: false, error: "500 caractères au maximum" };
    case "date": {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
      const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
      return date && date.toISOString().slice(0, 10) === value ? { ok: true, column: "value_date", value } : { ok: false, error: "Date invalide" };
    }
    case "amount": {
      const cleaned = value.replace(/[\s€]/g, "").replace(",", ".");
      return /^\d{1,10}(\.\d{1,2})?$/.test(cleaned) ? { ok: true, column: "value_amount", value: cleaned } : { ok: false, error: "Montant invalide" };
    }
    case "choice":
      return field.options.some((o) => o.id === value) ? { ok: true, column: "value_option_id", value } : { ok: false, error: "Choix invalide" };
  }
}

async function assertEditable(db: Kysely<DB>, categoryId: string): Promise<void> {
  const category = await db.selectFrom("contract_definitions").select("archived_at").where("id", "=", categoryId).executeTakeFirstOrThrow();
  if (category.archived_at) throw new Rejection("category_archived", "Cette catégorie est archivée : ses contrats se consultent, ils ne se modifient plus.", 409);
}

/**
 * Enregistre les détails d'un contrat : champs obligatoires et formats contrôlés selon le type défini par l'administrateur (US-33 RF2, RF3). Un champ vidé est supprimé ; la
 * dernière modification l'emporte (RF6). Une catégorie archivée ne se modifie plus (US-139 RF3).
 */
export async function saveDetails(ctx: Ctx, session: SessionContext, contractId: string, input: Record<string, string>): Promise<ContractView> {
  const accountId = requireCore(session);
  const own = await ownContract(ctx.db, accountId, contractId);
  await assertEditable(ctx.db, own.contract_definition_id);
  const current = await contractView(ctx, accountId, contractId);

  const errors: Record<string, string> = {};
  const clean = new Map<string, Extract<Parsed, { ok: true }> | null>();
  for (const field of current.fields) {
    const raw = (input[field.id] ?? "").trim();
    if (raw === "") {
      if (field.required) errors[field.id] = "Ce champ est obligatoire";
      else clean.set(field.id, null);
      continue;
    }
    const parsed = parseValue(field, raw);
    if (parsed.ok) clean.set(field.id, parsed);
    else errors[field.id] = parsed.error;
  }
  if (Object.keys(errors).length) throw new Rejection("invalid_details", "Certains détails sont à corriger.", 422, errors);

  await ctx.db.transaction().execute(async (trx) => {
    for (const [fieldId, parsed] of clean) {
      if (parsed === null) {
        await trx.deleteFrom("contract_field_values").where("account_contract_id", "=", contractId).where("field_definition_id", "=", fieldId).execute();
        continue;
      }
      const columns = { value_text: null, value_date: null, value_amount: null, value_option_id: null, [parsed.column]: parsed.value };
      await trx
        .insertInto("contract_field_values")
        .values({ account_contract_id: contractId, field_definition_id: fieldId, ...columns, updated_by_user_id: session.user.id, updated_at: ctx.now })
        .onConflict((oc) => oc.columns(["account_contract_id", "field_definition_id"]).doUpdateSet({ ...columns, updated_by_user_id: session.user.id, updated_at: ctx.now }))
        .execute();
    }
    await trx.updateTable("account_contracts").set({ last_modified_by_user_id: session.user.id, last_modified_at: ctx.now, updated_at: ctx.now }).where("id", "=", contractId).execute();
  });
  return contractView(ctx, accountId, contractId);
}

/**
 * Vide les détails et les documents d'un contrat, tout ou rien (US-35 RF3, RT2). Le contrat reste dans la liste, « Non renseigné », et les deux interrupteurs repassent à
 * « désactivé » avec leur retrait journalisé (RF5). Un document verrouillé après sa transmission fait refuser l'opération.
 */
export async function clearContract(ctx: Ctx, session: SessionContext, contractId: string): Promise<ContractView> {
  const accountId = requireCore(session);
  const first = await ownContract(ctx.db, accountId, contractId);
  await assertEditable(ctx.db, first.contract_definition_id);
  try {
    await ctx.db.transaction().execute(async (trx) => {
      const own = await ownContract(trx, accountId, contractId, true);
      await trx.deleteFrom("contract_field_values").where("account_contract_id", "=", contractId).execute();
      await trx.deleteFrom("contract_field_documents").where("account_contract_id", "=", contractId).execute();
      if (own.analysis_enabled) await recordConsent(trx, ctx, session, own, "analysis", "withdrawn", "contract_details_deleted");
      if (own.consent_active) await recordConsent(trx, ctx, session, own, "challenge", "withdrawn", "contract_details_deleted");
      await trx
        .updateTable("account_contracts")
        .set({
          consent_active: false,
          consent_changed_by_user_id: own.consent_active ? session.user.id : undefined,
          consent_changed_at: own.consent_active ? ctx.now : undefined,
          analysis_enabled: false,
          analysis_changed_by_user_id: own.analysis_enabled ? session.user.id : undefined,
          analysis_changed_at: own.analysis_enabled ? ctx.now : undefined,
          last_modified_by_user_id: null,
          last_modified_at: null,
          updated_at: ctx.now,
        })
        .where("id", "=", contractId)
        .execute();
    });
  } catch (error) {
    throw dbRefusal(error);
  }
  return contractView(ctx, accountId, contractId);
}

// ---------------------------------------------------------------------------
// Interrupteurs « Analyse IA » et « Challenge » (US-127, US-128, CT-4)
// ---------------------------------------------------------------------------

/**
 * Active ou désactive un canal, partagé par le noyau (US-127 RF3, US-128 RF3). L'activation suppose que le texte du canal a été accepté ; chaque changement est inscrit au journal
 * des preuves, avec la version du texte. L'analyse reste inactive tant que `CONTRACT_ANALYSIS_MODE` est « off » ; le challenge, tant que le courtier n'est pas désigné (C-10).
 */
export async function setChannel(ctx: Ctx, session: SessionContext, contractId: string, channel: Channel, input: { enabled: boolean; accepted?: boolean }): Promise<ContractView> {
  const accountId = requireCore(session);
  const first = await ownContract(ctx.db, accountId, contractId);
  if (input.enabled) {
    await assertEditable(ctx.db, first.contract_definition_id);
    if (channel === "analysis" && analysisMode() === "off") throw new Rejection("analysis_closed", "L'analyse IA n'est pas encore ouverte.", 409);
    if (channel === "challenge" && !(await challengeAvailable(ctx.db))) throw new Rejection("challenge_unavailable", "Le challenge sera disponible quand notre partenaire courtier sera désigné.", 409);
    if (input.accepted !== true) throw new Rejection("consent_required", "Acceptez le texte de consentement pour activer cette option.", 422);
  }
  try {
    await ctx.db.transaction().execute(async (trx) => {
      // État relu sous verrou : deux appels simultanés ne journalisent qu'un seul changement.
      const own = await ownContract(trx, accountId, contractId, true);
      const now = channel === "analysis" ? own.analysis_enabled : own.consent_active;
      if (now === input.enabled) return;
      await recordConsent(trx, ctx, session, own, channel, input.enabled ? "granted" : "withdrawn", "user_action");
      await trx
        .updateTable("account_contracts")
        .set(
          channel === "analysis"
            ? { analysis_enabled: input.enabled, analysis_changed_by_user_id: session.user.id, analysis_changed_at: ctx.now, updated_at: ctx.now }
            : { consent_active: input.enabled, consent_changed_by_user_id: session.user.id, consent_changed_at: ctx.now, updated_at: ctx.now },
        )
        .where("id", "=", contractId)
        .execute();
    });
  } catch (error) {
    throw dbRefusal(error);
  }
  return contractView(ctx, accountId, contractId);
}

// ---------------------------------------------------------------------------
// Documents (US-126, US-134)
// ---------------------------------------------------------------------------

export interface UploadedFile {
  name: string;
  content: Buffer;
}

const FORMATS = [
  { extensions: ["jpg", "jpeg"], mime: "image/jpeg", magic: (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { extensions: ["gif"], mime: "image/gif", magic: (b: Buffer) => b.subarray(0, 4).toString("latin1") === "GIF8" },
  { extensions: ["pdf"], mime: "application/pdf", magic: (b: Buffer) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
] as const;

const BAD_FORMAT = "Format non accepté. Formats possibles : jpeg, jpg, gif, pdf.";

/** Extension, type et début du fichier doivent concorder (US-34 RF2, repris). */
function formatOf(file: UploadedFile): (typeof FORMATS)[number] {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
  const format = FORMATS.find((f) => (f.extensions as readonly string[]).includes(extension));
  if (!format || file.content.length === 0 || !format.magic(file.content)) throw new Rejection("invalid_format", BAD_FORMAT, 422);
  return format;
}

const PHOTOS_HEADER = "MAAQPHOTOS1\n";

/** Plusieurs photos forment un seul document : un conteneur simple (en-tête JSON des pages, puis les octets), lu page par page à l'aperçu. */
export function bundlePhotos(pages: { mime: string; content: Buffer }[]): Buffer {
  const head = Buffer.from(`${PHOTOS_HEADER}${JSON.stringify(pages.map((p) => ({ mime: p.mime, size: p.content.length })))}\n`, "utf8");
  return Buffer.concat([head, ...pages.map((p) => p.content)]);
}

export function unbundlePhotos(bytes: Buffer): { mime: string; content: Buffer }[] {
  if (bytes.subarray(0, PHOTOS_HEADER.length).toString("utf8") !== PHOTOS_HEADER) throw new Error("Conteneur de photos illisible");
  const end = bytes.indexOf(0x0a, PHOTOS_HEADER.length);
  const index = JSON.parse(bytes.subarray(PHOTOS_HEADER.length, end).toString("utf8")) as { mime: string; size: number }[];
  let offset = end + 1;
  return index.map((p) => {
    const content = bytes.subarray(offset, offset + p.size);
    offset += p.size;
    return { mime: p.mime, content };
  });
}

/** Nombre de pages d'un PDF d'après ses objets « Page » : une estimation suffisante pour l'affichage (au moins 1). */
function pdfPages(content: Buffer): number {
  return Math.min(1000, Math.max(1, (content.toString("latin1").match(/\/Type\s*\/Page(?![A-Za-z])/g) ?? []).length));
}

/**
 * Dépose ou remplace le document d'un champ (US-126) : un PDF, ou de 1 à 10 photos qui forment un seul document (C-09). Le fichier est chiffré avant d'être confié au stockage ;
 * la base fixe la date de suppression, verrouille après la transmission et refuse une catégorie archivée.
 */
export async function addDocument(ctx: Ctx, session: SessionContext, contractId: string, fieldId: string, files: UploadedFile[]): Promise<ContractView> {
  const accountId = requireCore(session);
  const own = await ownContract(ctx.db, accountId, contractId);
  if (files.length === 0) throw new Rejection("invalid_body", "Aucun fichier reçu.", 400);
  const formats = files.map(formatOf);
  const isPdf = formats[0].mime === "application/pdf";
  if (formats.some((f) => (f.mime === "application/pdf") !== isPdf) || (isPdf && files.length > 1)) throw new Rejection("invalid_format", "Un champ reçoit un PDF, ou des photos : pas les deux.", 422);
  if (files.length > MAX_PHOTOS) throw new Rejection("too_many_pages", `Un champ reçoit 10 photos au plus.`, 422);
  const maxMb = await integerSetting(ctx.db, "max_document_size_mb", 15);
  const total = files.reduce((n, f) => n + f.content.length, 0);
  if (total > maxMb * MEGABYTE) throw new Rejection("too_large", `Ce document dépasse ${maxMb} Mo.`, 422);

  const plain = isPdf ? files[0].content : bundlePhotos(files.map((f, i) => ({ mime: formats[i].mime, content: f.content })));
  const pages = isPdf ? pdfPages(files[0].content) : files.length;
  const fileName = isPdf || files.length === 1 ? files[0].name.slice(0, 200) : `${files.length} photos`;
  const storageKey = await storeDocument(accountId, plain);
  try {
    await ctx.db.transaction().execute(async (trx) => {
      const existing = await trx.selectFrom("contract_field_documents").select("id").where("account_contract_id", "=", contractId).where("field_id", "=", fieldId).forUpdate().executeTakeFirst();
      const common = { source_kind: isPdf ? ("pdf" as const) : ("photos" as const), page_count: pages, size_bytes: total, file_name: seal(fileName), storage_key: storageKey, uploaded_by_user_id: session.user.id };
      if (existing) await trx.updateTable("contract_field_documents").set(common).where("id", "=", existing.id).execute();
      else await trx.insertInto("contract_field_documents").values({ account_contract_id: contractId, field_id: fieldId, ...common, uploaded_at: ctx.now, expires_at: new Date(ctx.now.getTime() + 86_400_000) }).execute();
      await trx.updateTable("account_contracts").set({ last_modified_by_user_id: session.user.id, last_modified_at: ctx.now, updated_at: ctx.now }).where("id", "=", own.id).execute();
    });
  } catch (error) {
    // Le dépôt a échoué (verrou, archivage, taille) : le fichier chiffré déjà déposé n'a plus de raison d'exister.
    await objectStore().remove(storageKey).catch(() => undefined);
    throw dbRefusal(error);
  }
  return contractView(ctx, accountId, contractId);
}

async function ownDocument(ctx: Ctx, accountId: string, documentId: string) {
  const row = await ctx.db
    .selectFrom("contract_field_documents as d")
    .innerJoin("account_contracts as c", "c.id", "d.account_contract_id")
    .select(["d.id", "d.account_contract_id", "d.storage_key", "d.source_kind", "d.file_name", "c.account_id"])
    .where("d.id", "=", documentId)
    .where("c.account_id", "=", accountId)
    .executeTakeFirst();
  if (!row) throw new Rejection("not_found", "Ce document n'existe pas ou n'existe plus.", 404);
  return row;
}

/** Retire un document (« Retirer ») : refusé pendant les 48 h qui suivent la transmission ; le fichier part à la file de suppression du stockage (US-126 RF4, RF8). */
export async function removeDocument(ctx: Ctx, session: SessionContext, documentId: string): Promise<ContractView> {
  const accountId = requireCore(session);
  const doc = await ownDocument(ctx, accountId, documentId);
  try {
    await ctx.db.deleteFrom("contract_field_documents").where("id", "=", documentId).execute();
  } catch (error) {
    throw dbRefusal(error);
  }
  return contractView(ctx, accountId, doc.account_contract_id);
}

/** Aperçu d'un document : le PDF entier, ou une page de photos (1 pour la première). Réservé au noyau du compte. */
export async function readDocument(ctx: Ctx, session: SessionContext, documentId: string, page = 1): Promise<{ fileName: string; mimeType: string; content: Buffer }> {
  const accountId = requireCore(session);
  const doc = await ownDocument(ctx, accountId, documentId);
  const bytes = await loadDocument(doc.storage_key);
  const fileName = open(doc.file_name);
  if (doc.source_kind === "pdf") return { fileName, mimeType: "application/pdf", content: bytes };
  const pages = unbundlePhotos(bytes);
  const chosen = pages[Math.min(Math.max(1, page), pages.length) - 1];
  return { fileName, mimeType: chosen.mime, content: chosen.content };
}

export { STATE_LABEL } from "./transmission";
export type { DocumentState };
