import { sql } from "kysely";
import { issueActivationLink, sendAccountActivation } from "@/server/accounts/activation";
import type { Ctx } from "@/server/auth/service";
import { Rejection } from "@/server/http";
import { normalizePhone } from "@/server/phone";
import { adminName, logAdminAction } from "./audit";

/** Comptes des utilisateurs principaux, vus depuis la console (US-64, US-69). */

export type AccountStatus = "activation_pending" | "active" | "grace_period";

export interface AccountRow {
  id: string;
  name: string;
  email: string;
  status: AccountStatus;
  guests: number;
}

const EMAIL_FORMAT = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function primaryUsers(ctx: Ctx) {
  return ctx.db
    .selectFrom("accounts as a")
    .innerJoin("users as u", (join) => join.onRef("u.account_id", "=", "a.id").on("u.role", "=", "primary_user"))
    .select([
      "a.id",
      "a.status",
      "a.guest_quota",
      "a.daily_request_limit",
      "a.created_at",
      "u.id as user_id",
      "u.first_name",
      "u.last_name",
      "u.email",
      "u.phone",
      sql<number>`(SELECT count(*)::int FROM users g WHERE g.account_id = a.id AND g.role = 'guest' AND g.status IN ('pending_activation', 'active'))`.as(
        "guests",
      ),
    ]);
}

/** Liste filtrée par nom ou email (US-64 RF1). */
export async function listAccounts(ctx: Ctx, search = ""): Promise<AccountRow[]> {
  let query = primaryUsers(ctx).orderBy("a.created_at", "desc");
  const term = search.trim();
  if (term) {
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    query = query.where((eb) =>
      eb.or([
        eb("u.first_name", "ilike", like),
        eb("u.last_name", "ilike", like),
        eb(sql<string>`u.first_name || ' ' || u.last_name`, "ilike", like),
        eb(sql<string>`u.email::text`, "ilike", like),
      ]),
    );
  }
  const rows = await query.execute();
  return rows.map((r) => ({
    id: r.id,
    name: `${r.first_name} ${r.last_name}`,
    email: r.email,
    status: r.status,
    guests: r.guests,
  }));
}

export interface CreateAccountInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  guestQuota: number;
  dailyRequestLimit: number;
}

/**
 * Crée le compte au statut « Activation en attente » et envoie le lien d'activation (US-64 RF2 à RF4).
 * Les refus de saisie sont renvoyés champ par champ.
 */
export async function createAccount(ctx: Ctx, adminId: string, input: CreateAccountInput): Promise<{ accountId: string; email: string }> {
  const errors: Record<string, string> = {};
  const email = input.email.trim();
  if (!input.firstName.trim()) errors.firstName = "Le prénom est obligatoire.";
  if (!input.lastName.trim()) errors.lastName = "Le nom est obligatoire.";
  if (!EMAIL_FORMAT.test(email)) errors.email = "Adresse email invalide";
  const phone = input.phone.trim() ? normalizePhone(input.phone) : null;
  if (input.phone.trim() && !phone) errors.phone = "Numéro de téléphone invalide";
  if (!Number.isInteger(input.guestQuota) || input.guestQuota < 0) errors.guestQuota = "Indiquez un nombre entier positif ou nul.";
  if (!Number.isInteger(input.dailyRequestLimit) || input.dailyRequestLimit < 1) {
    errors.dailyRequestLimit = "Indiquez un nombre entier supérieur ou égal à 1.";
  }
  if (!errors.email) {
    const existing = await ctx.db.selectFrom("users").select("id").where("email", "=", email).where("status", "<>", "removed").executeTakeFirst();
    if (existing) errors.email = "Cette adresse est déjà associée à un compte MAAQ.";
  }
  if (Object.keys(errors).length) throw new Rejection("invalid_account", "Certaines informations sont à corriger.", 422, errors);

  const created = await ctx.db.transaction().execute(async (trx) => {
    const account = await trx
      .insertInto("accounts")
      .values({ status: "activation_pending", guest_quota: input.guestQuota, daily_request_limit: input.dailyRequestLimit, created_at: ctx.now })
      .returning("id")
      .executeTakeFirstOrThrow();
    const user = await trx
      .insertInto("users")
      .values({
        account_id: account.id,
        role: "primary_user",
        first_name: input.firstName.trim(),
        last_name: input.lastName.trim(),
        email,
        phone,
        status: "pending_activation",
        initial_setup_step: "step_1_my_info",
        created_at: ctx.now,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const link = await issueActivationLink(trx, { userId: user.id, kind: "account_activation", createdBy: adminId, now: ctx.now });
    await logAdminAction(trx, {
      adminId,
      action: "account_created",
      entityType: "account",
      entityId: account.id,
      details: { email, guest_quota: input.guestQuota, daily_request_limit: input.dailyRequestLimit },
      now: ctx.now,
    });
    return { accountId: account.id, link };
  });

  await sendAccountActivation(ctx.db, {
    linkId: created.link.linkId,
    token: created.link.token,
    to: email,
    firstName: input.firstName.trim(),
    now: ctx.now,
  });
  return { accountId: created.accountId, email };
}

export interface AccountDetail extends AccountRow {
  phone: string | null;
  guestQuota: number;
  dailyRequestLimit: number;
  activationLink: { sentAt: string | null; expiresAt: string; expired: boolean } | null;
  limitHistory: { before: number; after: number; admin: string; at: string }[];
}

/** Fiche d'un compte (US-64 RF6, US-69 RF1, RF6). */
export async function getAccount(ctx: Ctx, accountId: string): Promise<AccountDetail> {
  const row = await primaryUsers(ctx).where("a.id", "=", accountId).executeTakeFirst();
  if (!row) throw new Rejection("not_found", "Ce compte n'existe pas.", 404);

  const link = await ctx.db
    .selectFrom("activation_links")
    .select(["sent_at", "expires_at"])
    .where("user_id", "=", row.user_id)
    .where("used_at", "is", null)
    .where("revoked_at", "is", null)
    .executeTakeFirst();

  const history = await ctx.db
    .selectFrom("admin_audit_log as l")
    .leftJoin("users as u", "u.id", "l.admin_user_id")
    .select(["l.details", "l.occurred_at", "u.first_name", "u.last_name"])
    .where("l.entity_type", "=", "account")
    .where("l.entity_id", "=", accountId)
    .where("l.action_type", "=", "account_updated")
    .orderBy("l.occurred_at", "desc")
    .execute();

  return {
    id: row.id,
    name: `${row.first_name} ${row.last_name}`,
    email: row.email,
    phone: row.phone,
    status: row.status,
    guests: row.guests,
    guestQuota: row.guest_quota,
    dailyRequestLimit: row.daily_request_limit,
    activationLink:
      row.status === "activation_pending" && link
        ? {
            sentAt: link.sent_at ? new Date(link.sent_at).toISOString() : null,
            expiresAt: new Date(link.expires_at).toISOString(),
            expired: new Date(link.expires_at) <= ctx.now,
          }
        : null,
    limitHistory: history.flatMap((entry) => {
      const details = entry.details as { field?: string; before?: number; after?: number } | null;
      if (details?.field !== "daily_request_limit") return [];
      return [
        {
          before: details.before!,
          after: details.after!,
          admin: adminName(entry.first_name, entry.last_name),
          at: new Date(entry.occurred_at).toISOString(),
        },
      ];
    }),
  };
}

/** Modifie le plafond quotidien : s'applique aux demandes suivantes, sans remise à zéro (US-69 RF2 à RF4). */
export async function updateDailyLimit(ctx: Ctx, adminId: string, accountId: string, value: number): Promise<void> {
  if (!Number.isInteger(value) || value < 1) {
    throw new Rejection("invalid_limit", "Indiquez un nombre entier supérieur ou égal à 1.");
  }
  await ctx.db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom("accounts")
      .select("daily_request_limit")
      .where("id", "=", accountId)
      .forUpdate()
      .executeTakeFirst();
    if (!current) throw new Rejection("not_found", "Ce compte n'existe pas.", 404);
    if (current.daily_request_limit === value) return;
    await trx.updateTable("accounts").set({ daily_request_limit: value, updated_at: ctx.now }).where("id", "=", accountId).execute();
    await logAdminAction(trx, {
      adminId,
      action: "account_updated",
      entityType: "account",
      entityId: accountId,
      details: { field: "daily_request_limit", before: current.daily_request_limit, after: value },
      now: ctx.now,
    });
  });
}

/** Renvoie un nouveau lien d'activation et invalide le précédent (US-64 RF6). */
export async function resendActivation(ctx: Ctx, adminId: string, accountId: string): Promise<void> {
  const row = await primaryUsers(ctx).where("a.id", "=", accountId).executeTakeFirst();
  if (!row) throw new Rejection("not_found", "Ce compte n'existe pas.", 404);
  if (row.status !== "activation_pending") throw new Rejection("already_active", "Ce compte est déjà activé.", 409);

  const link = await ctx.db.transaction().execute(async (trx) => {
    const issued = await issueActivationLink(trx, { userId: row.user_id, kind: "account_activation", createdBy: adminId, now: ctx.now });
    await logAdminAction(trx, { adminId, action: "activation_link_resent", entityType: "account", entityId: accountId, now: ctx.now });
    return issued;
  });
  await sendAccountActivation(ctx.db, { linkId: link.linkId, token: link.token, to: row.email, firstName: row.first_name, now: ctx.now });
}
