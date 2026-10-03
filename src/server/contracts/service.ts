import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { digitorn } from "@/server/adapters/digitorn";
import { drive } from "@/server/adapters/drive";
import { scanner } from "@/server/adapters/scanner";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { Rejection } from "@/server/http";
import { ensureDigitornRef } from "@/server/profile/digitorn-ref";
import { emailFingerprint } from "@/server/security/crypto";
import { integerSetting } from "@/server/settings";
import { readStaged, stage, unstage } from "./staging";

/** Contrats du compte (US-30 à US-36) : détails, documents scannés et consentement au challenge. */

export type FieldType = "text" | "date" | "amount" | "choice";
export type DocumentStatus = "pending" | "available" | "failed";

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
  mimeType: string;
  sizeBytes: number;
  addedAt: string;
  addedByFirstName: string | null;
  status: DocumentStatus;
}

export interface ContractView {
  id: string;
  name: string;
  filled: boolean;
  consent: { active: boolean; byFirstName: string | null; at: string | null };
  modified: { byFirstName: string | null; at: string } | null;
  fields: FieldView[];
  documents: DocumentView[];
}

export interface ContractsView {
  drive: { connected: boolean; primaryFirstName: string; canConnect: boolean; connectAgentId: string | null };
  limits: { maxDocumentMb: number; maxDocuments: number };
  consentText: string;
  contracts: ContractView[];
}

/** Formats acceptés (US-34 RF2) : extension, type et début du fichier doivent concorder. */
const FORMATS = [
  { extensions: ["jpg", "jpeg"], mime: "image/jpeg", magic: (b: Buffer) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { extensions: ["gif"], mime: "image/gif", magic: (b: Buffer) => b.subarray(0, 4).toString("latin1") === "GIF8" },
  { extensions: ["pdf"], mime: "application/pdf", magic: (b: Buffer) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
] as const;

const BAD_FORMAT = "Format non accepté. Formats possibles : jpeg, jpg, gif, pdf.";
const MEGABYTE = 1_048_576;
const CLASSIFICATION_ATTEMPTS = 3;
const CLASSIFICATION_DELAYS_MS = [1_000, 3_000];

/** Les contrats ne concernent que le noyau du compte : utilisateur principal et invité 1 (US-30 RF3, US-32 RT1). */
function requireCore(session: SessionContext): string {
  const isCore = session.user.role === "primary_user" || (session.user.role === "guest" && session.user.guestRank === "core");
  if (!isCore || !session.user.accountId) throw new Rejection("forbidden", "Les contrats sont réservés à l'utilisateur principal et à l'invité 1.", 403);
  return session.user.accountId;
}

const iso = (value: Date | string | null | undefined) => (value ? new Date(value).toISOString() : null);

async function primaryOf(db: Kysely<DB>, accountId: string) {
  return db.selectFrom("users").select(["id", "first_name"]).where("account_id", "=", accountId).where("role", "=", "primary_user").executeTakeFirstOrThrow();
}

async function currentConsentVersion(db: Kysely<DB>, now: Date) {
  const version = await db
    .selectFrom("legal_document_versions")
    .select(["id", "content"])
    .where("document_type", "=", "contract_challenge_consent")
    .where("published_at", "<=", now)
    .orderBy("published_at", "desc")
    .orderBy("id", "desc")
    .executeTakeFirst();
  if (!version) throw new Error("Aucun texte de consentement publié");
  return version;
}

// ---------------------------------------------------------------------------
// Lecture (US-32, US-33, US-34, US-36)
// ---------------------------------------------------------------------------

async function loadContracts(ctx: Ctx, accountId: string, onlyId?: string): Promise<ContractView[]> {
  let definitions = ctx.db.selectFrom("contract_definitions").select(["id", "name"]).where("archived_at", "is", null).orderBy("sort_order").orderBy("id");
  if (onlyId) definitions = definitions.where("id", "=", onlyId);
  const defs = await definitions.execute();
  if (defs.length === 0) return [];
  const defIds = defs.map((d) => d.id);

  const [fields, options, mine] = await Promise.all([
    ctx.db
      .selectFrom("contract_field_definitions")
      .select(["id", "contract_definition_id", "label", "field_type", "is_required"])
      .where("contract_definition_id", "in", defIds)
      .where("archived_at", "is", null)
      .orderBy("sort_order")
      .orderBy("id")
      .execute(),
    ctx.db
      .selectFrom("contract_field_options as o")
      .innerJoin("contract_field_definitions as f", "f.id", "o.field_definition_id")
      .select(["o.id", "o.field_definition_id", "o.label"])
      .where("f.contract_definition_id", "in", defIds)
      .orderBy("o.sort_order")
      .orderBy("o.id")
      .execute(),
    ctx.db.selectFrom("account_contracts").selectAll().where("account_id", "=", accountId).where("contract_definition_id", "in", defIds).execute(),
  ]);

  const accountContractIds = mine.map((m) => m.id);
  const [values, documents] = accountContractIds.length
    ? await Promise.all([
        ctx.db
          .selectFrom("contract_field_values")
          .select([
            "account_contract_id",
            "field_definition_id",
            "value_text",
            "value_amount",
            "value_option_id",
            sql<string | null>`to_char(value_date, 'YYYY-MM-DD')`.as("value_date"),
          ])
          .where("account_contract_id", "in", accountContractIds)
          .execute(),
        ctx.db
          .selectFrom("contract_documents as d")
          .leftJoin("users as u", "u.id", "d.added_by_user_id")
          .select(["d.id", "d.account_contract_id", "d.file_name", "d.mime_type", "d.size_bytes", "d.added_at", "d.classification_status", "u.first_name"])
          .where("d.account_contract_id", "in", accountContractIds)
          .orderBy("d.added_at")
          .orderBy("d.id")
          .execute(),
      ])
    : [[], []];

  const userIds = [...new Set(mine.flatMap((m) => [m.consent_changed_by_user_id, m.last_modified_by_user_id]).filter((id): id is string => id !== null))];
  const names = new Map(
    userIds.length ? (await ctx.db.selectFrom("users").select(["id", "first_name"]).where("id", "in", userIds).execute()).map((u) => [u.id, u.first_name] as const) : [],
  );

  return defs.map<ContractView>((def) => {
    const own = mine.find((m) => m.contract_definition_id === def.id);
    const ownValues = own ? values.filter((v) => v.account_contract_id === own.id) : [];
    const ownDocs = own ? documents.filter((d) => d.account_contract_id === own.id) : [];
    const fieldViews = fields
      .filter((f) => f.contract_definition_id === def.id)
      .map<FieldView>((f) => {
        const v = ownValues.find((x) => x.field_definition_id === f.id);
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
    return {
      id: def.id,
      name: def.name,
      filled: ownValues.length > 0 || ownDocs.length > 0,
      consent: {
        active: own?.consent_active ?? false,
        byFirstName: own?.consent_changed_by_user_id ? (names.get(own.consent_changed_by_user_id) ?? null) : null,
        at: iso(own?.consent_changed_at),
      },
      modified: own?.last_modified_at ? { byFirstName: own.last_modified_by_user_id ? (names.get(own.last_modified_by_user_id) ?? null) : null, at: iso(own.last_modified_at)! } : null,
      fields: fieldViews,
      documents: ownDocs.map<DocumentView>((d) => ({
        id: d.id,
        fileName: d.file_name,
        mimeType: d.mime_type,
        sizeBytes: Number(d.size_bytes),
        addedAt: iso(d.added_at)!,
        addedByFirstName: d.first_name,
        status: d.classification_status === "classified" ? "available" : d.classification_status === "failed" ? "failed" : "pending",
      })),
    };
  });
}

/** Onglet « Mes contrats » : liste définie par l'administrateur, état de chaque contrat et du Drive du compte. */
export async function getContracts(ctx: Ctx, session: SessionContext): Promise<ContractsView> {
  const accountId = requireCore(session);
  const [contracts, primary, driveRow, maxDocumentMb, maxDocuments, version] = await Promise.all([
    loadContracts(ctx, accountId),
    primaryOf(ctx.db, accountId),
    ctx.db
      .selectFrom("account_connections as c")
      .innerJoin("connector_types as t", "t.id", "c.connector_type_id")
      .select("c.status")
      .where("c.account_id", "=", accountId)
      .where("t.code", "=", "google_drive")
      .executeTakeFirst(),
    integerSetting(ctx.db, "max_document_size_mb", 15),
    integerSetting(ctx.db, "max_documents_per_contract", 20),
    currentConsentVersion(ctx.db, ctx.now),
  ]);

  // Agent du dashboard qui porte la connexion Drive du compte : le bouton « Connecter » y mène (US-32 RF11).
  const connectAgent = await ctx.db
    .selectFrom("profile_agents as pa")
    .innerJoin("agent_requirements as r", "r.agent_id", "pa.agent_id")
    .innerJoin("connector_types as t", "t.id", "r.connector_type_id")
    .select("pa.agent_id")
    .where("pa.user_id", "=", session.user.id)
    .where("pa.removed_at", "is", null)
    .where("t.code", "=", "google_drive")
    .where("r.owner_scope", "=", "account")
    .orderBy("pa.added_at")
    .executeTakeFirst();

  return {
    drive: {
      connected: driveRow?.status === "connected",
      primaryFirstName: primary.first_name,
      canConnect: session.user.role === "primary_user",
      connectAgentId: connectAgent?.agent_id ?? null,
    },
    limits: { maxDocumentMb, maxDocuments },
    consentText: version.content,
    contracts,
  };
}

async function getContract(ctx: Ctx, accountId: string, contractId: string): Promise<ContractView> {
  const [contract] = await loadContracts(ctx, accountId, contractId);
  if (!contract) throw new Rejection("not_found", "Ce contrat n'existe pas ou n'est plus suivi.", 404);
  return contract;
}

/** Contrat suivi par le compte, créé à la première saisie, au premier document ou au premier consentement (US-32 RF6). */
async function ensureAccountContract(db: Kysely<DB>, accountId: string, contractId: string): Promise<{ id: string; consent_active: boolean }> {
  const definition = await db.selectFrom("contract_definitions").select("id").where("id", "=", contractId).where("archived_at", "is", null).executeTakeFirst();
  if (!definition) throw new Rejection("not_found", "Ce contrat n'existe pas ou n'est plus suivi.", 404);
  await db.insertInto("account_contracts").values({ account_id: accountId, contract_definition_id: contractId }).onConflict((oc) => oc.columns(["account_id", "contract_definition_id"]).doNothing()).execute();
  return db.selectFrom("account_contracts").select(["id", "consent_active"]).where("account_id", "=", accountId).where("contract_definition_id", "=", contractId).executeTakeFirstOrThrow();
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

/**
 * Enregistre les détails d'un contrat : champs obligatoires et formats contrôlés selon le type défini
 * par l'administrateur (RF2, RF3). Un champ vidé est supprimé ; la dernière modification l'emporte (RF6).
 */
export async function saveDetails(ctx: Ctx, session: SessionContext, contractId: string, input: Record<string, string>): Promise<ContractView> {
  const accountId = requireCore(session);
  const current = await getContract(ctx, accountId, contractId);

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

  const own = await ensureAccountContract(ctx.db, accountId, contractId);
  await ctx.db.transaction().execute(async (trx) => {
    for (const [fieldId, parsed] of clean) {
      if (parsed === null) {
        await trx.deleteFrom("contract_field_values").where("account_contract_id", "=", own.id).where("field_definition_id", "=", fieldId).execute();
        continue;
      }
      const columns = { value_text: null, value_date: null, value_amount: null, value_option_id: null, [parsed.column]: parsed.value };
      await trx
        .insertInto("contract_field_values")
        .values({ account_contract_id: own.id, field_definition_id: fieldId, ...columns, updated_by_user_id: session.user.id, updated_at: ctx.now })
        .onConflict((oc) =>
          oc.columns(["account_contract_id", "field_definition_id"]).doUpdateSet({ ...columns, updated_by_user_id: session.user.id, updated_at: ctx.now }),
        )
        .execute();
    }
    await trx.updateTable("account_contracts").set({ last_modified_by_user_id: session.user.id, last_modified_at: ctx.now, updated_at: ctx.now }).where("id", "=", own.id).execute();
  });
  return getContract(ctx, accountId, contractId);
}

/**
 * Supprime tous les détails et documents d'un contrat, tout ou rien (US-35 RF3, RT2). Le contrat reste
 * dans la liste, « Non renseigné », et le consentement repasse à « désactivé » (RF5). Les documents
 * restent dans le Drive : seuls les liens disparaissent (RT1).
 */
export async function clearContract(ctx: Ctx, session: SessionContext, contractId: string): Promise<ContractView> {
  const accountId = requireCore(session);
  await getContract(ctx, accountId, contractId);
  const own = await ensureAccountContract(ctx.db, accountId, contractId);

  const staged = await ctx.db.transaction().execute(async (trx) => {
    const documents = await trx.selectFrom("contract_documents").select("staging_storage_key").where("account_contract_id", "=", own.id).execute();
    await trx.deleteFrom("contract_field_values").where("account_contract_id", "=", own.id).execute();
    await trx.deleteFrom("contract_documents").where("account_contract_id", "=", own.id).execute();
    if (own.consent_active) await recordConsent(trx, ctx, session, accountId, contractId, "withdrawn", "contract_details_deleted");
    await trx
      .updateTable("account_contracts")
      .set({ consent_active: false, consent_changed_by_user_id: own.consent_active ? session.user.id : undefined, consent_changed_at: own.consent_active ? ctx.now : undefined, last_modified_by_user_id: null, last_modified_at: null, updated_at: ctx.now })
      .where("id", "=", own.id)
      .execute();
    return documents.map((d) => d.staging_storage_key);
  });
  for (const key of staged) await unstage(key).catch(() => undefined);
  return getContract(ctx, accountId, contractId);
}

// ---------------------------------------------------------------------------
// Documents (US-34, US-35)
// ---------------------------------------------------------------------------

export interface UploadInput {
  fileName: string;
  content: Buffer;
}

/** Contrôle de format et de taille, aussi côté serveur (US-34 RT3). */
function checkFile(input: UploadInput, maxMb: number): (typeof FORMATS)[number] {
  const extension = input.fileName.split(".").pop()?.toLowerCase() ?? "";
  const format = FORMATS.find((f) => (f.extensions as readonly string[]).includes(extension));
  if (!format || input.content.length === 0 || !format.magic(input.content)) throw new Rejection("bad_format", BAD_FORMAT, 422);
  if (input.content.length > maxMb * MEGABYTE) throw new Rejection("too_large", `Ce document dépasse ${maxMb} Mo.`, 422, { maxMb });
  return format;
}

const tooMany = (max: number) => new Rejection("too_many_documents", `Ce contrat a atteint le nombre maximum de documents (${max}).`, 409, { max });

/**
 * Ajoute un document à un contrat : formats, taille et nombre vérifiés, analyse antivirus, puis
 * stockage provisoire en attendant le classement dans le Drive par l'agent (RF1 à RF5, RT2, RT3).
 */
export async function addDocument(ctx: Ctx, session: SessionContext, contractId: string, input: UploadInput): Promise<{ contract: ContractView; documentId: string }> {
  const accountId = requireCore(session);
  const [maxMb, maxDocuments] = await Promise.all([integerSetting(ctx.db, "max_document_size_mb", 15), integerSetting(ctx.db, "max_documents_per_contract", 20)]);
  const format = checkFile(input, maxMb);
  const own = await ensureAccountContract(ctx.db, accountId, contractId);

  const existing = await ctx.db.selectFrom("contract_documents").select(sql<number>`count(*)::int`.as("n")).where("account_contract_id", "=", own.id).executeTakeFirstOrThrow();
  if (existing.n >= maxDocuments) throw tooMany(maxDocuments);

  if (!(await scanner().scan(input.content)).clean) {
    throw new Rejection("document_infected", "Ce document n'a pas pu être vérifié : il n'a pas été ajouté.", 422);
  }

  const key = randomUUID();
  await stage(key, input.content);
  let documentId: string;
  try {
    documentId = await ctx.db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto("contract_documents")
        .values({
          account_contract_id: own.id,
          file_name: input.fileName.replace(/[\\/]/g, "_").slice(0, 255),
          mime_type: format.mime,
          size_bytes: input.content.length,
          added_by_user_id: session.user.id,
          added_at: ctx.now,
          scan_status: "clean",
          staging_storage_key: key,
        })
        .returning("id")
        .executeTakeFirstOrThrow();
      await trx.updateTable("account_contracts").set({ last_modified_by_user_id: session.user.id, last_modified_at: ctx.now, updated_at: ctx.now }).where("id", "=", own.id).execute();
      return row.id;
    });
  } catch (error) {
    await unstage(key).catch(() => undefined);
    const message = (error as Error).message;
    if (/Limite de \d+ documents/.test(message)) throw tooMany(maxDocuments);
    if (/trop volumineux/.test(message)) throw new Rejection("too_large", `Ce document dépasse ${maxMb} Mo.`, 422, { maxMb });
    throw error;
  }
  return { contract: await getContract(ctx, accountId, contractId), documentId };
}

async function ownDocument(ctx: Ctx, accountId: string, documentId: string) {
  const doc = await ctx.db
    .selectFrom("contract_documents as d")
    .innerJoin("account_contracts as c", "c.id", "d.account_contract_id")
    .select(["d.id", "d.file_name", "d.mime_type", "d.classification_status", "d.drive_file_ref", "d.staging_storage_key", "c.id as account_contract_id", "c.contract_definition_id"])
    .where("d.id", "=", documentId)
    .where("c.account_id", "=", accountId)
    .executeTakeFirst();
  if (!doc) throw new Rejection("not_found", "Ce document n'existe plus.", 404);
  return doc;
}

/**
 * Retire un document d'un contrat (US-35 RF2) : seul le lien disparaît, le fichier reste dans le
 * Drive de l'utilisateur principal (RT1).
 */
export async function removeDocument(ctx: Ctx, session: SessionContext, documentId: string): Promise<ContractView> {
  const accountId = requireCore(session);
  const doc = await ownDocument(ctx, accountId, documentId).catch((error) => {
    if (error instanceof Rejection && error.status === 404) return null; // déjà retiré (double envoi)
    throw error;
  });
  if (!doc) throw new Rejection("not_found", "Ce document n'existe plus.", 404);
  await ctx.db.transaction().execute(async (trx) => {
    await trx.deleteFrom("contract_documents").where("id", "=", documentId).execute();
    await trx.updateTable("account_contracts").set({ last_modified_by_user_id: session.user.id, last_modified_at: ctx.now, updated_at: ctx.now }).where("id", "=", doc.account_contract_id).execute();
  });
  await unstage(doc.staging_storage_key).catch(() => undefined);
  return getContract(ctx, accountId, doc.contract_definition_id);
}

/** Contenu d'un document pour l'aperçu : dans le Drive une fois classé, sinon en stockage provisoire (US-34 RF6). */
export async function readDocument(ctx: Ctx, session: SessionContext, documentId: string): Promise<{ fileName: string; mimeType: string; content: Buffer }> {
  const accountId = requireCore(session);
  const doc = await ownDocument(ctx, accountId, documentId);
  if (doc.classification_status === "classified" && doc.drive_file_ref) {
    const stored = await drive().read(accountId, doc.drive_file_ref);
    return { fileName: doc.file_name, mimeType: doc.mime_type, content: stored.content };
  }
  if (!doc.staging_storage_key) throw new Rejection("not_found", "Ce document n'est pas disponible.", 404);
  return { fileName: doc.file_name, mimeType: doc.mime_type, content: await readStaged(doc.staging_storage_key) };
}

// ---------------------------------------------------------------------------
// Classement par Admin_Classify (US-34 RF12 à RF14)
// ---------------------------------------------------------------------------

async function driveConnected(db: Kysely<DB>, accountId: string): Promise<boolean> {
  const row = await db
    .selectFrom("account_connections as c")
    .innerJoin("connector_types as t", "t.id", "c.connector_type_id")
    .select("c.status")
    .where("c.account_id", "=", accountId)
    .where("t.code", "=", "google_drive")
    .executeTakeFirst();
  return row?.status === "connected";
}

/**
 * Fait classer un document dans le Drive de l'utilisateur principal : trois essais, puis « Classement
 * impossible ». Un Drive non connecté échoue aussitôt, réessayer n'y changerait rien. Renvoie l'état final.
 */
export async function classifyDocument(db: Kysely<DB>, documentId: string, options: { delaysMs?: number[]; now?: () => Date } = {}): Promise<"classified" | "failed" | "gone"> {
  const delays = options.delaysMs ?? CLASSIFICATION_DELAYS_MS;
  const now = options.now ?? (() => new Date());
  const doc = await db
    .selectFrom("contract_documents as d")
    .innerJoin("account_contracts as c", "c.id", "d.account_contract_id")
    .select(["d.id", "d.file_name", "d.mime_type", "d.classification_status", "d.staging_storage_key", "c.account_id"])
    .where("d.id", "=", documentId)
    .executeTakeFirst();
  if (!doc) return "gone";
  if (doc.classification_status === "classified") return "classified";

  const fail = async (attempts: number) => {
    await db.updateTable("contract_documents").set({ classification_status: "failed", classification_attempts: attempts, updated_at: now() }).where("id", "=", documentId).execute();
    return "failed" as const;
  };
  if (!(await driveConnected(db, doc.account_id)) || !doc.staging_storage_key) return fail(CLASSIFICATION_ATTEMPTS);

  const primary = await primaryOf(db, doc.account_id);
  for (let attempt = 1; attempt <= CLASSIFICATION_ATTEMPTS; attempt++) {
    try {
      const content = await readStaged(doc.staging_storage_key);
      const { driveFileRef } = await digitorn().classifyDocument({
        accountId: doc.account_id,
        ownerRef: await ensureDigitornRef(db, primary.id),
        fileName: doc.file_name,
        mimeType: doc.mime_type,
        content,
      });
      const done = await db
        .updateTable("contract_documents")
        .set({ classification_status: "classified", drive_file_ref: driveFileRef, staging_storage_key: null, classification_attempts: attempt, updated_at: now() })
        .where("id", "=", documentId)
        .returning("id")
        .executeTakeFirst();
      if (!done) return "gone";
      await unstage(doc.staging_storage_key).catch(() => undefined);
      return "classified";
    } catch {
      await db.updateTable("contract_documents").set({ classification_attempts: attempt, updated_at: now() }).where("id", "=", documentId).execute();
      if (attempt < CLASSIFICATION_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, delays[attempt - 1] ?? 0));
      // Le document a pu être retiré pendant l'attente.
      if (!(await db.selectFrom("contract_documents").select("id").where("id", "=", documentId).executeTakeFirst())) return "gone";
    }
  }
  return fail(CLASSIFICATION_ATTEMPTS);
}

/** Lance le classement en arrière-plan : l'envoi est déjà terminé, le profil n'attend pas (US-34 RF13, CC-10). */
export function classifyInBackground(db: Kysely<DB>, documentId: string): void {
  void classifyDocument(db, documentId).catch((error) => console.error("Classement du document", documentId, error));
}

/** « Réessayer » sur un document dont le classement a échoué (US-34 RF14). */
export async function retryClassification(ctx: Ctx, session: SessionContext, documentId: string): Promise<ContractView> {
  const accountId = requireCore(session);
  const doc = await ownDocument(ctx, accountId, documentId);
  if (doc.classification_status === "failed") {
    await ctx.db.updateTable("contract_documents").set({ classification_status: "pending", classification_attempts: 0, updated_at: ctx.now }).where("id", "=", documentId).execute();
    classifyInBackground(ctx.db, documentId);
  }
  return getContract(ctx, accountId, doc.contract_definition_id);
}

// ---------------------------------------------------------------------------
// Consentement au challenge (US-36)
// ---------------------------------------------------------------------------

async function recordConsent(
  db: Kysely<DB>,
  ctx: Ctx,
  session: SessionContext,
  accountId: string,
  contractId: string,
  action: "granted" | "withdrawn",
  trigger: "user_action" | "contract_details_deleted",
): Promise<void> {
  const version = await currentConsentVersion(db, ctx.now);
  await db
    .insertInto("contract_consent_events")
    .values({
      account_id: accountId,
      actor_user_id: session.user.id,
      actor_email_hash: emailFingerprint(session.user.email, Buffer.from(env().HMAC_KEY, "base64")),
      contract_definition_id: contractId,
      action_type: action,
      trigger_reason: trigger,
      legal_version_id: version.id,
      occurred_at: ctx.now,
    })
    .execute();
}

/**
 * Active ou désactive le consentement au challenge d'un contrat, partagé par le noyau (RF3). L'activation
 * suppose que le texte a été accepté (RF2) ; chaque changement est inscrit au journal des preuves (RT1).
 */
export async function setConsent(ctx: Ctx, session: SessionContext, contractId: string, input: { active: boolean; accepted?: boolean }): Promise<ContractView> {
  const accountId = requireCore(session);
  if (input.active && input.accepted !== true) throw new Rejection("consent_required", "Acceptez le texte de consentement pour activer cette option.", 422);
  await getContract(ctx, accountId, contractId);
  const own = await ensureAccountContract(ctx.db, accountId, contractId);

  await ctx.db.transaction().execute(async (trx) => {
    // État relu sous verrou : deux appels simultanés ne journalisent qu'un seul changement.
    const row = await trx.selectFrom("account_contracts").select("consent_active").where("id", "=", own.id).forUpdate().executeTakeFirstOrThrow();
    if (row.consent_active === input.active) return;
    await recordConsent(trx, ctx, session, accountId, contractId, input.active ? "granted" : "withdrawn", "user_action");
    await trx
      .updateTable("account_contracts")
      .set({ consent_active: input.active, consent_changed_by_user_id: session.user.id, consent_changed_at: ctx.now, updated_at: ctx.now })
      .where("id", "=", own.id)
      .execute();
  });
  return getContract(ctx, accountId, contractId);
}
