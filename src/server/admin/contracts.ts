import { sql, type Transaction } from "kysely";
import type { Ctx } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { logAdminAction } from "./audit";

/** Liste des contrats obligatoires et de leurs champs, commune à tous les clients (US-48). */

export type ContractFieldType = "text" | "date" | "amount" | "choice";

export interface ContractRow {
  id: string;
  name: string;
  /** Comptes ayant déjà renseigné ce contrat (avertissement avant retrait, RF4). */
  accounts: number;
}

export async function listContracts(ctx: Ctx): Promise<ContractRow[]> {
  const rows = await ctx.db
    .selectFrom("contract_definitions as c")
    .select([
      "c.id",
      "c.name",
      sql<number>`(SELECT count(*)::int FROM account_contracts ac WHERE ac.contract_definition_id = c.id)`.as("accounts"),
    ])
    .where("c.archived_at", "is", null)
    .orderBy("c.sort_order")
    .orderBy("c.id")
    .execute();
  return rows;
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

/** Retire un contrat de la liste ; les données des clients restent dans leur Drive (RF4). */
export async function archiveContract(ctx: Ctx, adminId: string, id: string): Promise<void> {
  await ctx.db.transaction().execute(async (trx) => {
    const archived = await trx
      .updateTable("contract_definitions")
      .set({ archived_at: ctx.now, updated_at: ctx.now })
      .where("id", "=", id)
      .where("archived_at", "is", null)
      .returning("name")
      .executeTakeFirst();
    if (!archived) throw new Rejection("not_found", "Ce contrat n'existe plus.", 404);
    await logAdminAction(trx, { adminId, action: "contract_archived", entityType: "contract", entityId: id, details: { name: archived.name }, now: ctx.now });
  });
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
