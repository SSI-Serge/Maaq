import { sql, type Transaction } from "kysely";
import { messenger } from "@/server/adapters/messaging";
import { issueActivationLink } from "@/server/accounts/activation";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { normalizePhone } from "@/server/phone";
import { integerSetting } from "@/server/settings";
import type { InvitationContent } from "./invitations";

/** Gestion des invités par l'utilisateur principal (US-5, US-18 à US-21). */

export type GuestStatus = "not_invited" | "sending" | "invitation_sent" | "invitation_expired" | "send_failed" | "active" | "grace_period";

export interface Guest {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  rank: "core" | "secondary";
  status: GuestStatus;
  lastSentAt: string | null;
}

export interface GuestList {
  guests: Guest[];
  quota: number;
  used: number;
  hasCoreGuest: boolean;
}

/** Une invitation à envoyer, une fois la transaction validée (traitement en arrière-plan). */
export interface PendingDelivery {
  linkId: string;
  content: InvitationContent;
}

const EMAIL_FORMAT = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
/** 3 renvois par heure et par invité (US-5 RF6, RT2). */
const MAX_RESENDS_PER_HOUR = 3;

export function requirePrimary(session: SessionContext): string {
  if (session.user.role !== "primary_user" || !session.user.accountId) {
    throw new Rejection("forbidden", "Seul l'utilisateur principal gère les invités.", 403);
  }
  return session.user.accountId;
}

export async function listGuests(ctx: Ctx, accountId: string): Promise<GuestList> {
  const rows = await ctx.db
    .selectFrom("users as u")
    .leftJoinLateral(
      (eb) =>
        eb
          .selectFrom("activation_links as l")
          .select(["l.id", "l.delivery_status", "l.expires_at", "l.sent_at", "l.revoked_at", "l.used_at"])
          .whereRef("l.user_id", "=", "u.id")
          .where("l.kind", "=", "guest_invitation")
          .orderBy("l.created_at", "desc")
          .limit(1)
          .as("l"),
      (join) => join.onTrue(),
    )
    .select([
      "u.id",
      "u.first_name",
      "u.last_name",
      "u.email",
      "u.phone",
      "u.guest_rank",
      "u.status",
      "u.created_at",
      "l.id as link_id",
      "l.delivery_status",
      "l.expires_at",
      "l.sent_at",
      "l.revoked_at",
    ])
    .where("u.account_id", "=", accountId)
    .where("u.role", "=", "guest")
    .where("u.status", "<>", "removed")
    .orderBy(sql`u.guest_rank = 'core'`, "desc")
    .orderBy("u.created_at")
    .execute();

  const quota = await ctx.db
    .selectFrom("v_account_guest_quota")
    .select(["guest_quota", "guests_used"])
    .where("account_id", "=", accountId)
    .executeTakeFirstOrThrow();

  const guests: Guest[] = rows.map((r) => {
    let status: GuestStatus;
    if (r.status === "active") status = "active";
    else if (r.status === "grace_period") status = "grace_period";
    // Lien jamais envoyé, ou invalidé par un changement de coordonnées (US-19 RF3).
    else if (!r.link_id || r.revoked_at) status = "not_invited";
    else if (r.delivery_status === "sending") status = "sending";
    else if (r.delivery_status === "failed") status = "send_failed";
    else if (new Date(r.expires_at!) <= ctx.now) status = "invitation_expired";
    else status = "invitation_sent";
    return {
      id: r.id,
      firstName: r.first_name,
      lastName: r.last_name,
      email: r.email,
      phone: r.phone,
      rank: r.guest_rank!,
      status,
      lastSentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null,
    };
  });

  return {
    guests,
    quota: quota.guest_quota ?? 0,
    used: Number(quota.guests_used ?? 0),
    hasCoreGuest: guests.some((g) => g.rank === "core"),
  };
}

export interface GuestInput {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
}

/** Contrôles du formulaire d'un invité (US-18 RF2, RF3), champ par champ. */
async function validateGuest(
  trx: Transaction<DB>,
  input: GuestInput,
  context: { primaryEmail: string; exceptUserId?: string },
): Promise<{ email: string; phone: string | null }> {
  const errors: Record<string, string> = {};
  const email = input.email.trim();
  if (!input.firstName.trim()) errors.firstName = "Le prénom est obligatoire.";
  if (!input.lastName.trim()) errors.lastName = "Le nom est obligatoire.";
  if (!EMAIL_FORMAT.test(email)) errors.email = "Adresse email invalide";
  const phone = input.phone.trim() ? normalizePhone(input.phone) : null;
  if (input.phone.trim() && !phone) errors.phone = "Numéro de téléphone invalide";

  if (!errors.email) {
    let existing = trx.selectFrom("users").select("id").where("email", "=", email).where("status", "<>", "removed");
    if (context.exceptUserId) existing = existing.where("id", "<>", context.exceptUserId);
    if (email.toLowerCase() === context.primaryEmail.toLowerCase() || (await existing.executeTakeFirst())) {
      errors.email = "Cette adresse est déjà associée à un compte MAAQ";
    }
  }
  if (Object.keys(errors).length) throw new Rejection("invalid_guest", "Certaines informations sont à corriger.", 422, errors);
  return { email, phone };
}

async function hostOf(trx: Transaction<DB>, accountId: string) {
  return trx
    .selectFrom("users")
    .select(["id", "first_name", "last_name", "email"])
    .where("account_id", "=", accountId)
    .where("role", "=", "primary_user")
    .executeTakeFirstOrThrow();
}

async function invite(
  trx: Transaction<DB>,
  guest: { id: string; first_name: string; email: string; phone: string | null },
  host: { id: string; first_name: string; last_name: string },
  now: Date,
): Promise<PendingDelivery> {
  const link = await issueActivationLink(trx, { userId: guest.id, kind: "guest_invitation", createdBy: host.id, now, sms: guest.phone !== null });
  return {
    linkId: link.linkId,
    content: {
      token: link.token,
      guestFirstName: guest.first_name,
      hostFirstName: host.first_name,
      hostLastName: host.last_name,
      email: guest.email,
      phone: guest.phone,
    },
  };
}

/**
 * Le premier invité ajouté devient l'invité 1 ; ensuite, seulement si l'utilisateur principal le
 * désigne alors que le compte n'a plus d'invité 1 (US-18 RF5, US-20 RF6, RF11).
 */
async function rankForNewGuest(trx: Transaction<DB>, accountId: string, designateCore: boolean): Promise<"core" | "secondary"> {
  const guests = await trx.selectFrom("users").select(["guest_rank", "status"]).where("account_id", "=", accountId).where("role", "=", "guest").execute();
  const hasCore = guests.some((g) => g.guest_rank === "core" && g.status !== "removed");
  if (hasCore) return "secondary";
  if (guests.length === 0) return "core";
  return designateCore ? "core" : "secondary";
}

/** Ajoute un invité et prépare l'envoi de son invitation (US-18). Quota vérifié côté serveur (RT1). */
export async function addGuest(
  ctx: Ctx,
  session: SessionContext,
  input: GuestInput & { designateCore: boolean },
): Promise<{ guestId: string; delivery: PendingDelivery }> {
  const accountId = requirePrimary(session);
  return ctx.db.transaction().execute(async (trx) => {
    // Verrou du compte : deux ajouts simultanés ne dépassent pas le quota.
    const account = await trx.selectFrom("accounts").select("guest_quota").where("id", "=", accountId).forUpdate().executeTakeFirstOrThrow();
    const used = await trx
      .selectFrom("users")
      .select(sql<number>`count(*)::int`.as("n"))
      .where("account_id", "=", accountId)
      .where("role", "=", "guest")
      .where("status", "in", ["pending_activation", "active"])
      .executeTakeFirstOrThrow();
    if (used.n >= account.guest_quota) {
      throw new Rejection("quota_reached", "Vous avez atteint le nombre maximum d'invités de votre plan.", 409);
    }

    const host = await hostOf(trx, accountId);
    const { email, phone } = await validateGuest(trx, input, { primaryEmail: host.email });
    const rank = await rankForNewGuest(trx, accountId, input.designateCore);
    const guest = await trx
      .insertInto("users")
      .values({
        account_id: accountId,
        role: "guest",
        guest_rank: rank,
        first_name: input.firstName.trim(),
        last_name: input.lastName.trim(),
        email,
        phone,
        status: "pending_activation",
        created_at: ctx.now,
      })
      .returning(["id", "first_name", "email", "phone"])
      .executeTakeFirstOrThrow();
    return { guestId: guest.id, delivery: await invite(trx, guest, host, ctx.now) };
  });
}

/**
 * Enregistre l'invité 1 depuis la configuration initiale, sans lui envoyer d'invitation :
 * elle partira depuis l'écran de gestion des invités (US-11 RF3).
 */
export async function recordCoreGuest(ctx: Ctx, session: SessionContext, input: GuestInput): Promise<string> {
  const accountId = requirePrimary(session);
  return ctx.db.transaction().execute(async (trx) => {
    await trx.selectFrom("accounts").select("id").where("id", "=", accountId).forUpdate().execute();
    const host = await hostOf(trx, accountId);
    const existingCore = await trx
      .selectFrom("users")
      .select(["id", "status"])
      .where("account_id", "=", accountId)
      .where("guest_rank", "=", "core")
      .where("status", "<>", "removed")
      .executeTakeFirst();

    if (existingCore) {
      // Retour arrière dans le parcours : l'invité 1 pas encore invité est simplement corrigé.
      if (existingCore.status !== "pending_activation") return existingCore.id;
      const { email, phone } = await validateGuest(trx, input, { primaryEmail: host.email, exceptUserId: existingCore.id });
      await trx
        .updateTable("users")
        .set({ first_name: input.firstName.trim(), last_name: input.lastName.trim(), email, phone, updated_at: ctx.now })
        .where("id", "=", existingCore.id)
        .execute();
      return existingCore.id;
    }

    const { email, phone } = await validateGuest(trx, input, { primaryEmail: host.email });
    const guest = await trx
      .insertInto("users")
      .values({
        account_id: accountId,
        role: "guest",
        guest_rank: "core",
        first_name: input.firstName.trim(),
        last_name: input.lastName.trim(),
        email,
        phone,
        status: "pending_activation",
        created_at: ctx.now,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return guest.id;
  });
}

async function guestOf(trx: Transaction<DB>, accountId: string, guestId: string) {
  const guest = await trx
    .selectFrom("users")
    .select(["id", "first_name", "last_name", "email", "phone", "status", "guest_rank"])
    .where("id", "=", guestId)
    .where("account_id", "=", accountId)
    .where("role", "=", "guest")
    .where("status", "<>", "removed")
    .forUpdate()
    .executeTakeFirst();
  if (!guest) throw new Rejection("not_found", "Cet invité n'existe plus.", 404);
  return guest;
}

/** Envoie (ou renvoie) un lien d'invitation ; 3 renvois par heure au maximum (US-5). */
export async function sendInvitation(ctx: Ctx, session: SessionContext, guestId: string): Promise<PendingDelivery> {
  const accountId = requirePrimary(session);
  return ctx.db.transaction().execute(async (trx) => {
    const guest = await guestOf(trx, accountId, guestId);
    if (guest.status !== "pending_activation") throw new Rejection("already_active", "Cet invité a déjà activé son accès.", 409);

    const hourAgo = new Date(ctx.now.getTime() - 3_600_000);
    const links = await trx
      .selectFrom("activation_links")
      .select("created_at")
      .where("user_id", "=", guestId)
      .orderBy("created_at")
      .execute();
    // Le tout premier envoi n'est pas un renvoi.
    const recentResends = links.slice(1).filter((l) => new Date(l.created_at) > hourAgo);
    if (recentResends.length >= MAX_RESENDS_PER_HOUR) {
      const retryAt = new Date(new Date(recentResends[0].created_at).getTime() + 3_600_000);
      throw new Rejection("resend_limited", "Trop d'envois récents. Réessayez dans une heure.", 429, { retryAt: retryAt.toISOString() });
    }

    const host = await hostOf(trx, accountId);
    return invite(trx, guest, host, ctx.now);
  });
}

/**
 * Modifie les coordonnées d'un invité (US-19). Non activé : un changement d'email ou de téléphone
 * invalide le lien en cours. Actif : l'email de connexion change, les deux adresses sont prévenues.
 */
export async function updateGuest(ctx: Ctx, session: SessionContext, guestId: string, input: GuestInput): Promise<void> {
  const accountId = requirePrimary(session);
  const notice = await ctx.db.transaction().execute(async (trx) => {
    const guest = await guestOf(trx, accountId, guestId);
    const host = await hostOf(trx, accountId);
    const { email, phone } = await validateGuest(trx, input, { primaryEmail: host.email, exceptUserId: guestId });
    const emailChanged = email.toLowerCase() !== guest.email.toLowerCase();
    const phoneChanged = phone !== guest.phone;

    await trx
      .updateTable("users")
      .set({ first_name: input.firstName.trim(), last_name: input.lastName.trim(), email, phone, updated_at: ctx.now })
      .where("id", "=", guestId)
      .execute();

    if (guest.status === "pending_activation" && (emailChanged || phoneChanged)) {
      await trx
        .updateTable("activation_links")
        .set({ revoked_at: ctx.now })
        .where("user_id", "=", guestId)
        .where("used_at", "is", null)
        .where("revoked_at", "is", null)
        .execute();
    }
    if (guest.status === "active" && emailChanged) {
      await trx
        .insertInto("security_events")
        .values({
          user_id: guestId,
          actor_user_id: session.user.id,
          event_type: "login_email_changed",
          occurred_at: ctx.now,
          details: JSON.stringify({ changed_by: "primary_user" }),
        })
        .execute();
      return { oldEmail: guest.email, newEmail: email, firstName: input.firstName.trim() };
    }
    return null;
  });

  if (notice) {
    const text = (to: string) =>
      `Bonjour ${notice.firstName},\n\n` +
      `L'email de connexion de votre accès MAAQ a été modifié par ${session.user.firstName} ${session.user.lastName}. ` +
      `Il est désormais : ${notice.newEmail}.\n\n` +
      (to === notice.oldEmail ? "Cette adresse ne permet plus de vous connecter.\n\n" : "") +
      "L'équipe MAAQ";
    for (const to of [notice.oldEmail, notice.newEmail]) {
      await messenger().sendEmail({ to, subject: "Votre email de connexion MAAQ a changé", text: text(to) });
    }
  }
}

/**
 * Supprime un invité (US-20) : accès retiré immédiatement sur tous ses appareils, lien invalidé,
 * adresses en copie supprimées, place libérée. Ses données sont effacées après le délai réglé (RT2).
 * Aucun invité secondaire n'est promu (RF6).
 */
export async function removeGuest(ctx: Ctx, session: SessionContext, guestId: string): Promise<void> {
  const accountId = requirePrimary(session);
  const removed = await ctx.db.transaction().execute(async (trx) => {
    const guest = await guestOf(trx, accountId, guestId);
    const retentionDays = await integerSetting(trx, "guest_data_retention_days", 30);
    await trx
      .updateTable("users")
      .set({
        status: "removed",
        removed_at: ctx.now,
        purge_scheduled_at: new Date(ctx.now.getTime() + retentionDays * 86_400_000),
        updated_at: ctx.now,
      })
      .where("id", "=", guestId)
      .execute();
    await trx
      .updateTable("sessions")
      .set({ revoked_at: ctx.now, revoked_reason: "guest_removed" })
      .where("user_id", "=", guestId)
      .where("revoked_at", "is", null)
      .execute();
    await trx
      .updateTable("activation_links")
      .set({ revoked_at: ctx.now })
      .where("user_id", "=", guestId)
      .where("used_at", "is", null)
      .where("revoked_at", "is", null)
      .execute();
    await trx.deleteFrom("cc_addresses").where("user_id", "=", guestId).execute();
    return guest;
  });

  if (removed.status === "active") {
    await messenger().sendEmail({
      to: removed.email,
      subject: "Votre accès à MAAQ a été retiré",
      text:
        `Bonjour ${removed.first_name},\n\n` +
        `${session.user.firstName} ${session.user.lastName} a retiré votre accès à MAAQ. ` +
        `Vous ne pouvez plus vous connecter à l'application.\n\nL'équipe MAAQ`,
    });
  }
}

/** Désigne un invité comme invité 1 quand le compte n'en a plus (US-20 RF11). */
export async function designateCoreGuest(ctx: Ctx, session: SessionContext, guestId: string): Promise<void> {
  const accountId = requirePrimary(session);
  await ctx.db.transaction().execute(async (trx) => {
    await trx.selectFrom("accounts").select("id").where("id", "=", accountId).forUpdate().execute();
    const core = await trx
      .selectFrom("users")
      .select("id")
      .where("account_id", "=", accountId)
      .where("guest_rank", "=", "core")
      .where("status", "<>", "removed")
      .executeTakeFirst();
    if (core) throw new Rejection("core_exists", "Le compte a déjà un invité 1.", 409);
    await guestOf(trx, accountId, guestId);
    await trx.updateTable("users").set({ guest_rank: "core", updated_at: ctx.now }).where("id", "=", guestId).execute();
  });
}

