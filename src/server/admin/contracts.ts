import { sql, type Transaction } from "kysely";
import type { Ctx } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { logAdminAction } from "./audit";

/**
 * Catégories de contrats (ex-« contrats obligatoires », US-48, C-19), communes à tous les clients, avec leurs champs de documents attendus (US-122, US-123) et leurs champs de
 * détail (US-33). Une catégorie qui contient des contrats s'archive (elle n'est plus proposée, ses contrats restent en lecture) ; une catégorie sans contrat se supprime.
 */

export type ContractFieldType = "text" | "date" | "amount" | "choice";

export interface ContractRow {
  id: string;
  name: string;
  /** Familles qui ont des contrats dans la catégorie (confirmation d'archivage, US-139 RF1). */
  accounts: number;
  /** Contrats de familles dans la catégorie, de base compris. */
  contracts: number;
  /** Champs de documents attendus (« Aucun document attendu : à configurer »). */
  documentFields: number;
  /** Date d'archivage ; la catégorie n'est plus proposée aux familles (US-139 RF2). */
  archivedAt: string | null;
}

/** Les catégories proposées, dans l'ordre choisi, puis les archivées (grisées). */
export async function listContracts(ctx: Ctx): Promise<ContractRow[]> {
  const rows = await ctx.db
    .selectFrom("contract_definitions as c")
    .select([
      "c.id",
      "c.name",
      "c.archived_at",
      sql<number>`(SELECT count(DISTINCT ac.account_id)::int FROM account_contracts ac WHERE ac.contract_definition_id = c.id)`.as("accounts"),
      sql<number>`(SELECT count(*)::int FROM account_contracts ac WHERE ac.contract_definition_id = c.id)`.as("contracts"),
      sql<number>`(SELECT count(*)::int FROM contract_document_fields f WHERE f.contract_definition_id = c.id)`.as("documentFields"),
    ])
    .orderBy(sql`c.archived_at IS NOT NULL`)
    .orderBy("c.sort_order")
    .orderBy("c.id")
    .execute();
  return rows.map((r) => ({ id: r.id, name: r.name, accounts: r.accounts, contracts: r.contracts, documentFields: r.documentFields, archivedAt: r.archived_at ? new Date(r.archived_at).toISOString() : null }));
}

function cleanName(name: string): string {
  const value = name.trim().replace(/\s+/g, " ");
  if (!value) throw new Rejection("invalid_name", "Le nom du contrat est obligatoire.");
  if (value.length > 120) throw new Rejection("invalid_name", "Le nom du contrat est limité à 120 caractères.");
  return value;
}

async function assertUniqueName(trx: Transaction<DB>, name: string, exceptId?: string) {
  let query = trx
    .selectFrom("contract_definitions")
    .select("id")
    .where(sql<string>`lower(name)`, "=", name.toLowerCase())
    .where("archived_at", "is", null);
  if (exceptId) query = query.where("id", "<>", exceptId);
  if (await query.executeTakeFirst()) throw new Rejection("duplicate_name", "Un contrat porte déjà ce nom.", 409);
}

/** Ajoute un contrat en fin de liste ; nom unique sans tenir compte des majuscules (RF2). */
export async function addContract(ctx: Ctx, adminId: string, rawName: string): Promise<string> {
  const name = cleanName(rawName);
  return ctx.db.transaction().execute(async (trx) => {
    // Sérialise les modifications de la liste (ordre et unicité).
    await sql`SELECT pg_advisory_xact_lock(hashtext('contract_definitions'))`.execute(trx);
    await assertUniqueName(trx, name);
    const last = await trx
      .selectFrom("contract_definitions")
      .select(sql<number>`coalesce(max(sort_order), 0)`.as("max"))
      .where("archived_at", "is", null)
      .executeTakeFirstOrThrow();
    const row = await trx
      .insertInto("contract_definitions")
      .values({ name, sort_order: last.max + 1, created_at: ctx.now })
      .returning("id")
      .executeTakeFirstOrThrow();
    await logAdminAction(trx, { adminId, action: "contract_created", entityType: "contract", entityId: row.id, details: { name }, now: ctx.now });
    return row.id;
  });
}

/** Renomme un contrat ; les informations des clients sont conservées (RF3, RT2). */
export async function renameContract(ctx: Ctx, adminId: string, id: string, rawName: string): Promise<void> {
  const name = cleanName(rawName);
  await ctx.db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext('contract_definitions'))`.execute(trx);
    await assertUniqueName(trx, name, id);
    const before = await trx
      .updateTable("contract_definitions")
      .set({ name, updated_at: ctx.now })
      .where("id", "=", id)
      .where("archived_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!before) throw new Rejection("not_found", "Ce contrat n'existe plus.", 404);
    await logAdminAction(trx, { adminId, action: "contract_updated", entityType: "contract", entityId: id, details: { name }, now: ctx.now });
  });
}

/** Déplace un contrat d'un cran vers le haut ou le bas (RF3). */
export async function moveContract(ctx: Ctx, adminId: string, id: string, direction: "up" | "down"): Promise<void> {
  await ctx.db.transaction().execute(async (trx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtext('contract_definitions'))`.execute(trx);
    const list = await trx
      .selectFrom("contract_definitions")
      .select(["id", "sort_order"])
      .where("archived_at", "is", null)
      .orderBy("sort_order")
      .orderBy("id")
      .execute();
    const index = list.findIndex((c) => c.id === id);
    if (index < 0) throw new Rejection("not_found", "Ce contrat n'existe plus.", 404);
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    // Renumérotation complète : l'ordre reste cohérent même après des retraits.
    for (const [position, contract] of list.entries()) {
      await trx.updateTable("contract_definitions").set({ sort_order: position + 1 }).where("id", "=", contract.id).execute();
    }
    await logAdminAction(trx, { adminId, action: "contract_updated", entityType: "contract", entityId: id, details: { moved: direction }, now: ctx.now });
  });
}

/**
 * Archive une catégorie (C-19, US-139) : elle n'est plus proposée et ne reçoit plus de contrats ; les familles gardent contrats, détails et rapports en lecture, sans dépôt ni
 * transmission (la base le refuse). Définitif en V1 : pas de désarchivage.
 */
export async function archiveContract(ctx: Ctx, adminId: string, id: string): Promise<void> {
  await ctx.db.transaction().execute(async (trx) => {
    const archived = await trx
      .updateTable("contract_definitions")
      .set({ archived_at: ctx.now, updated_at: ctx.now })
      .where("id", "=", id)
      .where("archived_at", "is", null)
      .returning("name")
      .executeTakeFirst();
    if (!archived) throw new Rejection("not_found", "Cette catégorie n'existe plus.", 404);
    await logAdminAction(trx, { adminId, action: "contract_archived", entityType: "contract", entityId: id, details: { name: archived.name }, now: ctx.now });
  });
}

/** Supprime une catégorie qui ne contient aucun contrat, avec ses champs ; sinon la base refuse et la catégorie s'archive (US-139 RF6). */
export async function deleteContract(ctx: Ctx, adminId: string, id: string): Promise<void> {
  try {
    await ctx.db.transaction().execute(async (trx) => {
      const gone = await trx.deleteFrom("contract_definitions").where("id", "=", id).returning("name").executeTakeFirst();
      if (!gone) throw new Rejection("not_found", "Cette catégorie n'existe plus.", 404);
      await logAdminAction(trx, { adminId, action: "contract_updated", entityType: "contract", entityId: id, details: { deleted: true, name: gone.name }, now: ctx.now });
    });
  } catch (error) {
    throw ruleError(error);
  }
}

/**
 * Traduit un refus de la base (message en français, code de violation de contrainte) en refus de l'application ; les autres erreurs passent telles quelles.
 * L'unicité du nom d'un champ dans la catégorie a son propre message (US-122 CA 1.2).
 */
function ruleError(error: unknown): unknown {
  const e = error as { code?: string; message?: string; constraint?: string };
  if (e.code === "23505" && e.constraint === "ux_contract_document_fields_name") return new Rejection("duplicate_name", "Ce nom existe déjà dans la catégorie.", 409);
  if (e.code === "23514" && e.message) {
    const text = e.message.replace(/ \(.*$/, "");
    if (/^10 champs/.test(text)) return new Rejection("too_many_fields", "10 champs au plus par catégorie.", 409);
    return new Rejection("rule_refused", /[.!?]$/.test(text) ? text : `${text}.`, 409);
  }
  return error;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Champs de documents attendus (US-122, US-123)
// ---------------------------------------------------------------------------------------------------------------------------

export interface DocumentFieldRow {
  id: string;
  name: string;
  help: string | null;
  required: boolean;
  /** Contrats où un document est déposé dans ce champ (confirmation avant retrait, US-122 RF5). */
  used: number;
}

export interface DocumentFields {
  category: string;
  archived: boolean;
  fields: DocumentFieldRow[];
}

const MAX_FIELD_NAME = 80;
const MAX_FIELD_HELP = 200;

async function loadCategory(trx: Transaction<DB> | Ctx["db"], id: string, forUpdate = false) {
  let query = trx.selectFrom("contract_definitions").select(["name", "archived_at"]).where("id", "=", id);
  if (forUpdate) query = query.forUpdate();
  const category = await query.executeTakeFirst();
  if (!category) throw new Rejection("not_found", "Cette catégorie n'existe plus.", 404);
  return category;
}

export async function getDocumentFields(ctx: Ctx, categoryId: string): Promise<DocumentFields> {
  const category = await loadCategory(ctx.db, categoryId);
  const fields = await ctx.db
    .selectFrom("contract_document_fields as f")
    .select([
      "f.id",
      "f.name",
      "f.help",
      "f.is_required",
      sql<number>`(SELECT count(*)::int FROM contract_field_documents d WHERE d.field_id = f.id)`.as("used"),
    ])
    .where("f.contract_definition_id", "=", categoryId)
    .orderBy("f.sort_order")
    .orderBy("f.id")
    .execute();
  return { category: category.name, archived: category.archived_at !== null, fields: fields.map((f) => ({ id: f.id, name: f.name, help: f.help, required: f.is_required, used: f.used })) };
}

function cleanFieldName(raw: string): string {
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) throw new Rejection("invalid_name", "Le nom du champ est obligatoire.", 422);
  if (name.length > MAX_FIELD_NAME) throw new Rejection("invalid_name", `Le nom du champ est limité à ${MAX_FIELD_NAME} caractères.`, 422);
  return name;
}

function cleanFieldHelp(raw: string | null | undefined): string | null {
  const help = (raw ?? "").trim();
  if (!help) return null;
  if (help.length > MAX_FIELD_HELP) throw new Rejection("invalid_help", `L'aide est limitée à ${MAX_FIELD_HELP} caractères.`, 422);
  return help;
}

async function logFieldChange(trx: Transaction<DB>, ctx: Ctx, adminId: string, fieldId: string, details: Record<string, unknown>) {
  await logAdminAction(trx, { adminId, action: "contract_document_field_changed", entityType: "contract_document_field", entityId: fieldId, details, now: ctx.now });
}

const notArchived = (category: { archived_at: Date | null }) => {
  if (category.archived_at) throw new Rejection("category_archived", "Cette catégorie est archivée : ses champs ne se modifient plus.", 409);
};

/** Ajoute un champ en fin de liste ; il apparaît, vide, dans tous les contrats de la catégorie (US-122 RF4). Facultatif seulement s'il reste un champ obligatoire (US-123 RF4). */
export async function addDocumentField(ctx: Ctx, adminId: string, categoryId: string, input: { name: string; help?: string | null; required?: boolean }): Promise<string> {
  const name = cleanFieldName(input.name);
  const help = cleanFieldHelp(input.help);
  try {
    return await ctx.db.transaction().execute(async (trx) => {
      notArchived(await loadCategory(trx, categoryId, true));
      const last = await trx.selectFrom("contract_document_fields").select(sql<number>`coalesce(max(sort_order), 0)`.as("max")).where("contract_definition_id", "=", categoryId).executeTakeFirstOrThrow();
      const field = await trx
        .insertInto("contract_document_fields")
        .values({ contract_definition_id: categoryId, name, help, is_required: input.required ?? true, sort_order: last.max + 1 })
        .returning("id")
        .executeTakeFirstOrThrow();
      await logFieldChange(trx, ctx, adminId, field.id, { category_id: categoryId, change: "added", name, required: input.required ?? true });
      // Le contrôle « au moins un champ obligatoire » est différé à la fin de la transaction : on le force ici pour que le refus soit rendu par cette requête.
      await sql`SET CONSTRAINTS trg_contract_document_fields_required IMMEDIATE`.execute(trx);
      return field.id;
    });
  } catch (error) {
    throw ruleError(error);
  }
}

/** Renomme un champ, change son aide ou son caractère obligatoire ; les documents déposés ne sont pas touchés (US-122 RF6, US-123 RF5). */
export async function updateDocumentField(
  ctx: Ctx,
  adminId: string,
  categoryId: string,
  fieldId: string,
  changes: { name?: string; help?: string | null; required?: boolean },
): Promise<void> {
  const set: { name?: string; help?: string | null; is_required?: boolean; updated_at: Date } = { updated_at: ctx.now };
  if (changes.name !== undefined) set.name = cleanFieldName(changes.name);
  if (changes.help !== undefined) set.help = cleanFieldHelp(changes.help);
  if (changes.required !== undefined) set.is_required = changes.required;
  try {
    await ctx.db.transaction().execute(async (trx) => {
      notArchived(await loadCategory(trx, categoryId, true));
      const updated = await trx.updateTable("contract_document_fields").set(set).where("id", "=", fieldId).where("contract_definition_id", "=", categoryId).returning("id").executeTakeFirst();
      if (!updated) throw new Rejection("not_found", "Ce champ n'existe plus.", 404);
      await logFieldChange(trx, ctx, adminId, fieldId, { category_id: categoryId, change: "updated", fields: Object.keys(changes) });
      await sql`SET CONSTRAINTS trg_contract_document_fields_required IMMEDIATE`.execute(trx);
    });
  } catch (error) {
    throw ruleError(error);
  }
}

/** Déplace un champ d'un cran (US-122 RF1). */
export async function moveDocumentField(ctx: Ctx, adminId: string, categoryId: string, fieldId: string, direction: "up" | "down"): Promise<void> {
  await ctx.db.transaction().execute(async (trx) => {
    notArchived(await loadCategory(trx, categoryId, true));
    const list = await trx.selectFrom("contract_document_fields").select(["id"]).where("contract_definition_id", "=", categoryId).orderBy("sort_order").orderBy("id").execute();
    const index = list.findIndex((f) => f.id === fieldId);
    if (index < 0) throw new Rejection("not_found", "Ce champ n'existe plus.", 404);
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= list.length) return;
    [list[index], list[target]] = [list[target], list[index]];
    for (const [position, field] of list.entries()) {
      await trx.updateTable("contract_document_fields").set({ sort_order: position + 1 }).where("id", "=", field.id).execute();
    }
    await logFieldChange(trx, ctx, adminId, fieldId, { category_id: categoryId, change: "moved", direction });
  });
}

/**
 * Retire un champ : les documents qui y sont déposés sont supprimés (confirmation avec leur nombre côté écran, US-122 RF5) ; leurs fichiers partent à la file de suppression du
 * stockage. Refusé si c'est le dernier champ obligatoire d'une catégorie qui en garde d'autres.
 */
export async function removeDocumentField(ctx: Ctx, adminId: string, categoryId: string, fieldId: string): Promise<{ deletedDocuments: number }> {
  try {
    return await ctx.db.transaction().execute(async (trx) => {
      notArchived(await loadCategory(trx, categoryId, true));
      const used = await trx.selectFrom("contract_field_documents").select(sql<number>`count(*)::int`.as("n")).where("field_id", "=", fieldId).executeTakeFirstOrThrow();
      const removed = await trx.deleteFrom("contract_document_fields").where("id", "=", fieldId).where("contract_definition_id", "=", categoryId).returning("name").executeTakeFirst();
      if (!removed) throw new Rejection("not_found", "Ce champ n'existe plus.", 404);
      await logFieldChange(trx, ctx, adminId, fieldId, { category_id: categoryId, change: "removed", name: removed.name, documents_deleted: used.n });
      await sql`SET CONSTRAINTS trg_contract_document_fields_required IMMEDIATE`.execute(trx);
      return { deletedDocuments: used.n };
    });
  } catch (error) {
    throw ruleError(error);
  }
}

export interface ContractField {
  id: string;
  label: string;
  type: ContractFieldType;
  required: boolean;
  options: string[];
}

export async function getContractFields(ctx: Ctx, contractId: string): Promise<{ name: string; fields: ContractField[] }> {
  const contract = await ctx.db
    .selectFrom("contract_definitions")
    .select("name")
    .where("id", "=", contractId)
    .where("archived_at", "is", null)
    .executeTakeFirst();
  if (!contract) throw new Rejection("not_found", "Ce contrat n'existe plus.", 404);
  const fields = await ctx.db
    .selectFrom("contract_field_definitions")
    .select(["id", "label", "field_type", "is_required"])
    .where("contract_definition_id", "=", contractId)
    .where("archived_at", "is", null)
    .orderBy("sort_order")
    .orderBy("id")
    .execute();
  const options = fields.length
    ? await ctx.db
        .selectFrom("contract_field_options")
        .select(["field_definition_id", "label"])
        .where("field_definition_id", "in", fields.map((f) => f.id))
        .orderBy("sort_order")
        .execute()
    : [];
  return {
    name: contract.name,
    fields: fields.map((f) => ({
      id: f.id,
      label: f.label,
      type: f.field_type,
      required: f.is_required,
      options: options.filter((o) => o.field_definition_id === f.id).map((o) => o.label),
    })),
  };
}

/** Ajoute un champ de détail, appliqué immédiatement à tous les clients (RF10). */
export async function addContractField(
  ctx: Ctx,
  adminId: string,
  contractId: string,
  input: { label: string; type: ContractFieldType; required: boolean; options: string[] },
): Promise<string> {
  const label = input.label.trim().replace(/\s+/g, " ");
  if (!label || label.length > 120) throw new Rejection("invalid_label", "Le libellé est obligatoire (120 caractères au maximum).");
  const options = [...new Set(input.options.map((o) => o.trim()).filter(Boolean))];
  if (input.type === "choice" && options.length < 2) {
    throw new Rejection("invalid_options", "Une liste de choix demande au moins deux choix, un par ligne.");
  }

  return ctx.db.transaction().execute(async (trx) => {
    const contract = await trx
      .selectFrom("contract_definitions")
      .select("id")
      .where("id", "=", contractId)
      .where("archived_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!contract) throw new Rejection("not_found", "Ce contrat n'existe plus.", 404);
    const duplicate = await trx
      .selectFrom("contract_field_definitions")
      .select("id")
      .where("contract_definition_id", "=", contractId)
      .where("archived_at", "is", null)
      .where(sql<string>`lower(label)`, "=", label.toLowerCase())
      .executeTakeFirst();
    if (duplicate) throw new Rejection("duplicate_label", "Ce contrat a déjà un champ portant ce libellé.", 409);

    const last = await trx
      .selectFrom("contract_field_definitions")
      .select(sql<number>`coalesce(max(sort_order), 0)`.as("max"))
      .where("contract_definition_id", "=", contractId)
      .executeTakeFirstOrThrow();
    const field = await trx
      .insertInto("contract_field_definitions")
      .values({
        contract_definition_id: contractId,
        label,
        field_type: input.type,
        is_required: input.required,
        sort_order: last.max + 1,
        created_at: ctx.now,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    if (input.type === "choice") {
      await trx
        .insertInto("contract_field_options")
        .values(options.map((o, i) => ({ field_definition_id: field.id, label: o, sort_order: i + 1 })))
        .execute();
    }
    await logAdminAction(trx, {
      adminId,
      action: "contract_field_changed",
      entityType: "contract_field",
      entityId: field.id,
      details: { contract_id: contractId, change: "added", label, type: input.type, required: input.required },
      now: ctx.now,
    });
    return field.id;
  });
}

/** Retire un champ ; les valeurs déjà saisies sont conservées (archivage). */
export async function archiveContractField(ctx: Ctx, adminId: string, contractId: string, fieldId: string): Promise<void> {
  await ctx.db.transaction().execute(async (trx) => {
    const archived = await trx
      .updateTable("contract_field_definitions")
      .set({ archived_at: ctx.now, updated_at: ctx.now })
      .where("id", "=", fieldId)
      .where("contract_definition_id", "=", contractId)
      .where("archived_at", "is", null)
      .returning("label")
      .executeTakeFirst();
    if (!archived) throw new Rejection("not_found", "Ce champ n'existe plus.", 404);
    await logAdminAction(trx, {
      adminId,
      action: "contract_field_changed",
      entityType: "contract_field",
      entityId: fieldId,
      details: { contract_id: contractId, change: "removed", label: archived.label },
      now: ctx.now,
    });
  });
}
