import { sql, type Transaction } from "kysely";
import { messenger } from "@/server/adapters/messaging";
import { signToken, verifyToken } from "@/server/auth/tokens";
import { env } from "@/server/env";
import { describeError } from "@/server/safe-log";
import { decrypt, encrypt, sha256 } from "@/server/security/crypto";
import { issueActivationLink } from "@/server/accounts/activation";
import { freeChildSheets, type ChildSheet } from "@/server/assistant/family";
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
  /** Prénom de la fiche enfant à laquelle ce profil est relié (« Profil enfant »), sinon `null`. */
  childSheet: string | null;
}

export interface GuestList {
  guests: Guest[];
  quota: number;
  used: number;
  hasCoreGuest: boolean;
  /** Fiches enfant sans profil, proposées à « Est-ce un de vos enfants ? » (S-56). */
  childSheets: ChildSheet[];
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

  const linked = new Map(
    (await ctx.db.selectFrom("family_members").select(["child_profile_user_id", "first_name"]).where("account_id", "=", accountId).where("child_profile_user_id", "is not", null).execute()).map((m) => [m.child_profile_user_id!, m.first_name ?? ""]),
  );
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
      childSheet: linked.get(r.id) ?? null,
    };
  });

  return {
    guests,
    quota: quota.guest_quota ?? 0,
    used: Number(quota.guests_used ?? 0),
    hasCoreGuest: guests.some((g) => g.rank === "core"),
    childSheets: await freeChildSheets(ctx.db, accountId, ctx.now),
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

/**
 * Ajoute un invité et prépare l'envoi de son invitation (US-18). Quota vérifié côté serveur (RT1).
 * `childMemberId` (S-56) : l'invité est un enfant du foyer. Son profil, encore en attente d'activation, est relié à sa fiche enfant dans la même transaction : dès l'activation,
 * il arrive sur son espace d'enfant. Un enfant est toujours un invité secondaire, jamais l'invité 1, même s'il est le premier invité du compte.
 */
export async function addGuest(
  ctx: Ctx,
  session: SessionContext,
  input: GuestInput & { designateCore: boolean; childMemberId?: string | null },
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
    const childMemberId = input.childMemberId ?? null;
    if (childMemberId) {
      if (input.designateCore) throw new Rejection("child_not_core", "Un enfant ne peut pas être l'invité 1.", 422);
      const sheet = await trx.selectFrom("family_members").select(["id", "role", "user_id", "archived_at", "child_profile_user_id"]).where("account_id", "=", accountId).where("id", "=", childMemberId).forUpdate().executeTakeFirst();
      if (!sheet || sheet.archived_at || sheet.role !== "child" || sheet.user_id) throw new Rejection("invalid_child_sheet", "Choisissez la fiche d'un de vos enfants.", 422);
      if (sheet.child_profile_user_id) throw new Rejection("child_sheet_taken", "Cette fiche a déjà un profil.", 409);
    }
    const rank = childMemberId ? "secondary" : await rankForNewGuest(trx, accountId, input.designateCore);
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
    if (childMemberId) await trx.updateTable("family_members").set({ child_profile_user_id: guest.id }).where("id", "=", childMemberId).execute();
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

/** Durée de validité du lien de confirmation d'un nouvel email de connexion. */
export const EMAIL_CONFIRMATION_HOURS = 48;

interface EmailChangeToken {
  exp: number;
  /** Profil de l'invité. */
  uid: string;
  /** Empreinte de l'email de connexion au moment de la demande : si l'email a changé entre-temps, le lien ne vaut plus. */
  old: string;
  /** Nouvel email, chiffré : il ne se lit ni dans l'adresse du lien ni dans les journaux. */
  enc: string;
}

const dataKey = () => Buffer.from(env().ENCRYPTION_KEY, "base64");
const printOf = (email: string) => sha256(email.trim().toLowerCase()).toString("hex");

function confirmationUrl(guestId: string, oldEmail: string, newEmail: string, now: Date): string {
  const token = signToken<EmailChangeToken>({ exp: now.getTime() + EMAIL_CONFIRMATION_HOURS * 3_600_000, uid: guestId, old: printOf(oldEmail), enc: encrypt(newEmail, dataKey()).toString("base64url") });
  return `${env().APP_URL.replace(/\/$/, "")}/confirmer-email?jeton=${encodeURIComponent(token)}`;
}

/**
 * Modifie les coordonnées d'un invité (US-19). Non activé : un changement d'email ou de téléphone invalide le lien en cours.
 * Actif : le nouvel email de connexion ne s'applique qu'après confirmation par l'invité (décision du PO du 13/11/2026, revue de sécurité) : un lien part à la NOUVELLE
 * adresse, l'ancienne est informée, et tant que l'invité n'a pas confirmé, son email actuel reste le seul valable. Sans cela, l'utilisateur principal pouvait prendre la
 * main sur le profil d'un invité en changeant son email puis en demandant un nouveau mot de passe. Rien n'est gardé en base : le lien signé porte la demande.
 * Retourne `emailPending` quand une confirmation est attendue.
 */
export async function updateGuest(ctx: Ctx, session: SessionContext, guestId: string, input: GuestInput): Promise<{ emailPending: boolean }> {
  const accountId = requirePrimary(session);
  const notice = await ctx.db.transaction().execute(async (trx) => {
    const guest = await guestOf(trx, accountId, guestId);
    const host = await hostOf(trx, accountId);
    const { email, phone } = await validateGuest(trx, input, { primaryEmail: host.email, exceptUserId: guestId });
    const emailChanged = email.toLowerCase() !== guest.email.toLowerCase();
    const phoneChanged = phone !== guest.phone;
    // Invité actif : son email de connexion ne change pas ici.
    const confirm = guest.status !== "pending_activation" && emailChanged;

    await trx
      .updateTable("users")
      .set({ first_name: input.firstName.trim(), last_name: input.lastName.trim(), ...(confirm ? {} : { email }), phone, updated_at: ctx.now })
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
    return confirm ? { oldEmail: guest.email, newEmail: email, firstName: input.firstName.trim() } : null;
  });

  if (!notice) return { emailPending: false };
  const by = `${session.user.firstName} ${session.user.lastName}`;
  await messenger().sendEmail({
    to: notice.newEmail,
    subject: "Confirmez votre nouvel email de connexion MAAQ",
    text:
      `Bonjour ${notice.firstName},\n\n` +
      `${by} demande que cette adresse devienne l'email de connexion de votre accès MAAQ.\n\n` +
      `Pour l'accepter, ouvrez ce lien dans les ${EMAIL_CONFIRMATION_HOURS} heures :\n${confirmationUrl(guestId, notice.oldEmail, notice.newEmail, ctx.now)}\n\n` +
      "Tant que vous n'avez pas confirmé, votre email de connexion actuel reste le seul valable. Si vous n'êtes pas à l'origine de cette demande, ignorez ce message.\n\n" +
      "L'équipe MAAQ",
  });
  await messenger().sendEmail({
    to: notice.oldEmail,
    subject: "Demande de changement de votre email de connexion MAAQ",
    text:
      `Bonjour ${notice.firstName},\n\n` +
      `${by} a demandé à changer l'email de connexion de votre accès MAAQ. Un lien de confirmation a été envoyé à la nouvelle adresse.\n\n` +
      "Rien ne change tant que vous n'avez pas confirmé depuis ce lien : cette adresse reste votre email de connexion. Si vous n'êtes pas d'accord, ne confirmez pas.\n\n" +
      "L'équipe MAAQ",
  });
  return { emailPending: true };
}

/** Ce que l'écran de confirmation montre avant d'appliquer : rien de plus que le prénom et le nouvel email. */
export interface EmailConfirmationView {
  firstName: string;
  newEmail: string;
}

async function readEmailChange(ctx: Ctx, token: string): Promise<{ guest: { id: string; first_name: string; email: string; account_id: string | null }; newEmail: string }> {
  const gone = () => new Rejection("link_expired", "Ce lien n'est plus valable. Demandez à la personne qui gère le compte de refaire la demande.", 410);
  const payload = verifyToken<EmailChangeToken>(token, ctx.now);
  if (!payload || typeof payload.uid !== "string" || typeof payload.old !== "string" || typeof payload.enc !== "string") throw gone();
  let newEmail: string;
  try {
    newEmail = decrypt(Buffer.from(payload.enc, "base64url"), dataKey());
  } catch {
    throw gone();
  }
  const guest = await ctx.db.selectFrom("users").select(["id", "first_name", "email", "account_id"]).where("id", "=", payload.uid).where("role", "=", "guest").where("status", "=", "active").executeTakeFirst();
  // L'email a changé depuis la demande (lien déjà utilisé, ou autre changement) : le lien ne vaut plus.
  if (!guest || printOf(guest.email) !== payload.old) throw gone();
  return { guest, newEmail };
}

export async function inspectEmailChange(ctx: Ctx, token: string): Promise<EmailConfirmationView> {
  const { guest, newEmail } = await readEmailChange(ctx, token);
  return { firstName: guest.first_name, newEmail };
}

/** L'invité confirme : le nouvel email devient son email de connexion, les deux adresses sont prévenues (US-19 RF4, RT1). Le lien ne sert qu'une fois. */
export async function confirmEmailChange(ctx: Ctx, token: string): Promise<EmailConfirmationView> {
  const { guest, newEmail } = await readEmailChange(ctx, token);
  const oldEmail = guest.email;
  await ctx.db.transaction().execute(async (trx) => {
    const current = await trx.selectFrom("users").select("email").where("id", "=", guest.id).forUpdate().executeTakeFirstOrThrow();
    if (current.email.toLowerCase() !== oldEmail.toLowerCase()) throw new Rejection("link_expired", "Ce lien n'est plus valable.", 410);
    const taken = await trx.selectFrom("users").select("id").where("email", "=", newEmail).where("status", "<>", "removed").where("id", "<>", guest.id).executeTakeFirst();
    if (taken) throw new Rejection("email_taken", "Cette adresse est déjà associée à un compte MAAQ.", 409);
    await trx.updateTable("users").set({ email: newEmail, updated_at: ctx.now }).where("id", "=", guest.id).execute();
    await trx
      .insertInto("security_events")
      .values({ user_id: guest.id, actor_user_id: guest.id, event_type: "login_email_changed", occurred_at: ctx.now, details: JSON.stringify({ changed_by: "primary_user", confirmed_by: "guest" }) })
      .execute();
  });
  for (const to of [oldEmail, newEmail]) {
    await messenger()
      .sendEmail({
        to,
        subject: "Votre email de connexion MAAQ a changé",
        text:
          `Bonjour ${guest.first_name},\n\n` +
          `L'email de connexion de votre accès MAAQ est désormais : ${newEmail}.\n\n` +
          (to === oldEmail ? "Cette adresse ne permet plus de vous connecter.\n\n" : "") +
          "L'équipe MAAQ",
      })
      .catch((error) => console.error(`Information du changement d'email non envoyée : ${describeError(error)}`));
  }
  return { firstName: guest.first_name, newEmail };
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
    // Plus aucune notification vers ses appareils.
    await trx.deleteFrom("push_subscriptions").where("device_id", "in", (eb) => eb.selectFrom("devices").select("id").where("user_id", "=", guestId)).execute();
    // La fiche enfant reliée à ce profil redevient libre : elle peut être proposée à une nouvelle invitation (S-56).
    await trx.updateTable("family_members").set({ child_profile_user_id: null }).where("account_id", "=", accountId).where("child_profile_user_id", "=", guestId).execute();
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

