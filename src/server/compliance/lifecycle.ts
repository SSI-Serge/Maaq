import { sql, type Kysely, type Transaction } from "kysely";
import { digitorn } from "@/server/adapters/digitorn";
import { messenger } from "@/server/adapters/messaging";
import { processChatErasure, unlockWithPassword, type Ctx, type SessionContext } from "@/server/auth/service";
import { unstage } from "@/server/contracts/staging";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { alertAdmin } from "@/server/logbook/service";
import { deleteExportFiles } from "./exports";

/**
 * Suppression des données et du compte (US-56), délai de grâce et reprise (US-58, US-59), anonymisation des
 * demandes d'un invité supprimé (US-57) et suppression des comptes jamais activés (US-68).
 */

export const GRACE_DAYS = 30;
const REMINDER_DAYS = 7;
const DAY_MS = 86_400_000;
/** Une suppression chez Digitorn qui a échoué est réessayée chaque jour (US-58 RF5). */
const RETRY_AFTER_HOURS = 23;
const REDACTED = "[supprimé]";

type Db = Kysely<DB>;
type Executor = Db | Transaction<DB>;

const dateFr = (value: Date | string) => new Date(value).toLocaleDateString("fr-FR", { dateStyle: "long" });

async function mail(to: string, subject: string, text: string): Promise<void> {
  // L'envoi d'un email ne doit jamais défaire une suppression ou une reprise déjà enregistrée.
  try {
    await messenger().sendEmail({ to, subject, text });
  } catch (error) {
    console.error(`Email « ${subject} » non envoyé :`, error);
  }
}

async function closeSessions(db: Executor, userIds: string[], now: Date): Promise<void> {
  if (userIds.length === 0) return;
  await db
    .updateTable("sessions")
    .set({ revoked_at: now, revoked_reason: "account_grace_period" })
    .where("user_id", "in", userIds)
    .where("revoked_at", "is", null)
    .execute();
}

/** Les tchats sont effacés quand les sessions se ferment, comme à une déconnexion (US-43). */
async function eraseChats(ctx: Ctx, db: Executor, userIds: string[]): Promise<string[]> {
  const ids: string[] = [];
  for (const userId of userIds) {
    const row = await db.insertInto("chat_erasure_requests").values({ user_id: userId, reason: "logout", requested_at: ctx.now }).returning("id").executeTakeFirstOrThrow();
    ids.push(row.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Demande de suppression (US-56)
// ---------------------------------------------------------------------------

export interface DeletionResult {
  purgeAt: string;
}

/**
 * Désactive le compte et lance le délai de grâce de 30 jours, après vérification du mot de passe (RF2, RF3).
 * Pour l'utilisateur principal, tout le compte est suspendu et les invités sont prévenus (RF6) ; la suppression
 * vaut désabonnement (RF8). Pour un invité, seul son profil est concerné.
 */
export async function requestDeletion(ctx: Ctx, session: SessionContext, password: string): Promise<DeletionResult> {
  if (session.user.role === "admin") throw new Rejection("forbidden", "Un administrateur ne supprime pas son compte ici.", 403);
  if (session.user.inGracePeriod) throw new Rejection("already_pending", "La suppression de ce compte est déjà programmée.", 409);

  const check = await unlockWithPassword(ctx, session, password);
  if (check.kind === "locked") throw new Rejection("login_locked", "Trop d'échecs de mot de passe. Réessayez dans quelques minutes.", 429);
  if (check.kind !== "ok") throw new Rejection("wrong_password", "Mot de passe incorrect.", 403);

  const purgeAt = new Date(ctx.now.getTime() + GRACE_DAYS * DAY_MS);
  let erasures: string[] = [];
  let guestsToInform: { email: string; first_name: string }[] = [];

  if (session.user.role === "primary_user") {
    const accountId = session.user.accountId!;
    await ctx.db.transaction().execute(async (trx) => {
      const claimed = await trx
        .updateTable("accounts")
        .set({ status: "grace_period", grace_origin: "in_app_request", grace_started_at: ctx.now, purge_scheduled_at: purgeAt, subscription_ended_at: ctx.now, grace_reminder_sent_at: null })
        .where("id", "=", accountId)
        .where("status", "=", "active")
        .returning("id")
        .executeTakeFirst();
      if (!claimed) throw new Rejection("already_pending", "La suppression de ce compte est déjà programmée.", 409);
      const people = await trx.selectFrom("users").select(["id", "email", "first_name", "role", "status"]).where("account_id", "=", accountId).where("status", "in", ["active", "pending_activation"]).execute();
      await closeSessions(trx, people.map((p) => p.id), ctx.now);
      await trx
        .updateTable("activation_links")
        .set({ revoked_at: ctx.now })
        .where("user_id", "in", people.map((p) => p.id))
        .where("used_at", "is", null)
        .where("revoked_at", "is", null)
        .execute();
      erasures = await eraseChats(ctx, trx, people.filter((p) => p.status === "active").map((p) => p.id));
      guestsToInform = people.filter((p) => p.role === "guest" && p.status === "active");
    });
  } else {
    await ctx.db.transaction().execute(async (trx) => {
      await trx.updateTable("users").set({ status: "grace_period", deletion_requested_at: ctx.now, purge_scheduled_at: purgeAt }).where("id", "=", session.user.id).where("status", "=", "active").execute();
      await closeSessions(trx, [session.user.id], ctx.now);
      erasures = await eraseChats(ctx, trx, [session.user.id]);
    });
  }
  for (const id of erasures) await processChatErasure(ctx, id);

  const when = dateFr(purgeAt);
  await mail(
    session.user.email,
    "Suppression de votre compte MAAQ programmée",
    `Bonjour ${session.user.firstName},\n\nVotre demande de suppression est enregistrée. Votre compte et vos données seront supprimés définitivement le ${when}.\n` +
      `D'ici là, vous pouvez annuler la suppression en vous reconnectant à MAAQ.\n\nL'équipe MAAQ`,
  );
  for (const guest of guestsToInform) {
    await mail(
      guest.email,
      "Votre accès à MAAQ est suspendu",
      `Bonjour ${guest.first_name},\n\n${session.user.firstName} ${session.user.lastName} a demandé la suppression de son compte MAAQ. Votre accès est suspendu et vos données seront supprimées le ${when}, sauf si ${session.user.firstName} reprend son compte.\n\nL'équipe MAAQ`,
    );
  }
  return { purgeAt: purgeAt.toISOString() };
}

// ---------------------------------------------------------------------------
// Reprise du compte (US-59)
// ---------------------------------------------------------------------------

async function supportAddress(db: Executor): Promise<string | null> {
  return (await db.selectFrom("platform_settings").select("value_text").where("setting_key", "=", "support_email").executeTakeFirst())?.value_text ?? null;
}

async function restoreAccount(ctx: Ctx, accountId: string, actor: { firstName: string; lastName: string }): Promise<void> {
  await ctx.db
    .updateTable("accounts")
    .set({ status: "active", grace_origin: null, grace_started_at: null, purge_scheduled_at: null, subscription_ended_at: null, grace_reminder_sent_at: null })
    .where("id", "=", accountId)
    .execute();
  const guests = await ctx.db.selectFrom("users").select(["email", "first_name"]).where("account_id", "=", accountId).where("role", "=", "guest").where("status", "=", "active").execute();
  for (const guest of guests) {
    await mail(
      guest.email,
      "Votre accès à MAAQ est rétabli",
      `Bonjour ${guest.first_name},\n\n${actor.firstName} ${actor.lastName} a repris son compte MAAQ. Vous pouvez de nouveau vous connecter.\n\nL'équipe MAAQ`,
    );
  }
}

/**
 * Annule la suppression pendant le délai de grâce. Après une suppression demandée dans l'application, le compte et
 * ses données sont rétablis aussitôt (RF3). Après un désabonnement, un nouvel abonnement hors de l'application est
 * nécessaire (RF2). Un invité reprend son propre compte, mais jamais celui que l'utilisateur principal a quitté (RF9).
 */
export async function cancelDeletion(ctx: Ctx, session: SessionContext): Promise<{ resumed: true }> {
  if (!session.user.inGracePeriod) throw new Rejection("not_in_grace", "Ce compte n'est pas en cours de suppression.", 409);
  const row = await ctx.db
    .selectFrom("users as u")
    .innerJoin("accounts as a", "a.id", "u.account_id")
    .select(["u.status as user_status", "a.status as account_status", "a.grace_origin"])
    .where("u.id", "=", session.user.id)
    .executeTakeFirstOrThrow();

  if (row.account_status === "grace_period") {
    if (session.user.role !== "primary_user") {
      throw new Rejection("only_primary", "Seul l'utilisateur principal peut reprendre ce compte.", 403);
    }
    if (row.grace_origin === "billing_unsubscribe") {
      const support = await supportAddress(ctx.db);
      throw new Rejection(
        "resubscribe_required",
        `Après un désabonnement, la reprise du compte suppose un nouvel abonnement, souscrit hors de l'application.${support ? ` Contactez MAAQ à ${support} pour vous réabonner.` : " Contactez MAAQ pour vous réabonner."}`,
        409,
      );
    }
    await restoreAccount(ctx, session.user.accountId!, session.user);
    return { resumed: true };
  }

  await ctx.db.updateTable("users").set({ status: "active", deletion_requested_at: null, purge_scheduled_at: null }).where("id", "=", session.user.id).where("status", "=", "grace_period").execute();
  return { resumed: true };
}

// ---------------------------------------------------------------------------
// Désabonnement et réabonnement signalés par l'outil de facturation (US-58 RF1, RT2)
// ---------------------------------------------------------------------------

export async function applyBillingEvent(ctx: Ctx, input: { event: "unsubscribed" | "resubscribed"; email: string }): Promise<{ changed: boolean }> {
  const primary = await ctx.db
    .selectFrom("users as u")
    .innerJoin("accounts as a", "a.id", "u.account_id")
    .select(["u.id", "u.first_name", "u.last_name", "u.email", "a.id as account_id", "a.status", "a.grace_origin"])
    .where(sql<string>`lower(u.email::text)`, "=", input.email.trim().toLowerCase())
    .where("u.role", "=", "primary_user")
    .where("u.status", "<>", "removed")
    .executeTakeFirst();
  if (!primary) throw new Rejection("unknown_account", "Aucun compte ne correspond à cette adresse.", 404);

  if (input.event === "resubscribed") {
    if (primary.status !== "grace_period") return { changed: false };
    await restoreAccount(ctx, primary.account_id, { firstName: primary.first_name, lastName: primary.last_name });
    return { changed: true };
  }

  if (primary.status !== "active") return { changed: false }; // déjà en délai de grâce, ou jamais activé
  const purgeAt = new Date(ctx.now.getTime() + GRACE_DAYS * DAY_MS);
  let erasures: string[] = [];
  await ctx.db.transaction().execute(async (trx) => {
    await trx
      .updateTable("accounts")
      .set({ status: "grace_period", grace_origin: "billing_unsubscribe", grace_started_at: ctx.now, purge_scheduled_at: purgeAt, subscription_ended_at: ctx.now, grace_reminder_sent_at: null })
      .where("id", "=", primary.account_id)
      .execute();
    const people = await trx.selectFrom("users").select(["id", "status"]).where("account_id", "=", primary.account_id).where("status", "in", ["active", "pending_activation"]).execute();
    await closeSessions(trx, people.map((p) => p.id), ctx.now);
    erasures = await eraseChats(ctx, trx, people.filter((p) => p.status === "active").map((p) => p.id));
  });
  for (const id of erasures) await processChatErasure(ctx, id);
  await mail(
    primary.email,
    "Votre abonnement MAAQ est résilié",
    `Bonjour ${primary.first_name},\n\nVotre désabonnement est enregistré. L'accès à MAAQ est suspendu pour vous et vos invités, et vos données seront supprimées définitivement le ${dateFr(purgeAt)}.\n` +
      `Pour reprendre votre compte avant cette date, souscrivez un nouvel abonnement.\n\nL'équipe MAAQ`,
  );
  return { changed: true };
}

// ---------------------------------------------------------------------------
// Anonymisation des demandes d'un invité supprimé (US-57)
// ---------------------------------------------------------------------------

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const EMAIL_PATTERN = /[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+/g;
const PHONE_PATTERN = /(?:\+33|0033|0)[\s.-]?[1-9](?:[\s.-]?\d{2}){4}/g;

/** Retire d'un texte le nom, l'email et le téléphone de la personne, ainsi que tout numéro ou adresse qui y ressemble (RF2). */
export function redact(text: string, person: { firstName: string; lastName: string; email: string; phone: string | null }): string {
  let out = text.replace(EMAIL_PATTERN, REDACTED).replace(PHONE_PATTERN, REDACTED);
  const needles = [`${person.firstName} ${person.lastName}`, person.lastName, person.firstName, person.email, person.phone ?? ""].filter((n) => n.trim().length >= 2);
  for (const needle of needles.sort((a, b) => b.length - a.length)) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(needle)}(?![\\p{L}\\p{N}])`, "giu"), REDACTED);
  }
  return out;
}

interface Leaving {
  id: string;
  account_id: string | null;
  role: "primary_user" | "guest" | "admin";
  digitorn_user_ref: string | null;
}

/**
 * Anonymise les entrées du carnet d'un invité avant sa suppression définitive. Pendant le traitement les
 * entrées sont masquées (RF7) ; en cas d'échec elles le restent et l'opération est reprise plus tard, de sorte
 * qu'aucune entrée n'est jamais affichée avec le nom d'un invité supprimé (RF6). L'opération est irréversible (RT2).
 */
async function anonymizeEntries(db: Db, guestId: string, digitornRef: string | null): Promise<void> {
  const person = await db.selectFrom("users").select(["first_name", "last_name", "email", "phone"]).where("id", "=", guestId).executeTakeFirstOrThrow();
  const who = { firstName: person.first_name, lastName: person.last_name, email: person.email, phone: person.phone };

  await db.updateTable("logbook_entries").set({ anonymization_status: "pending" }).where("requester_user_id", "=", guestId).where("anonymization_status", "=", "none").execute();
  const entries = await db
    .selectFrom("logbook_entries")
    .select(["id", "occurred_at", "summary", "result"])
    .where("requester_user_id", "=", guestId)
    .where("anonymization_status", "=", "pending")
    .execute();
  for (const entry of entries) {
    await db
      .updateTable("logbook_entries")
      .set({ summary: redact(entry.summary, who), result: entry.result === null ? null : redact(entry.result, who) })
      .where("id", "=", entry.id)
      .where("occurred_at", "=", entry.occurred_at)
      .execute();
  }
  if (digitornRef) await digitorn().anonymizeLogbook(digitornRef);
  await db.updateTable("logbook_entries").set({ anonymization_status: "done" }).where("requester_user_id", "=", guestId).where("anonymization_status", "=", "pending").execute();
}

// ---------------------------------------------------------------------------
// Suppressions définitives
// ---------------------------------------------------------------------------

/** Trace minimale et non nominative d'une suppression : date et identifiants techniques seulement (US-58 RF7). */
async function leaveTrace(db: Executor, people: Leaving[], now: Date): Promise<void> {
  for (const person of people) {
    await db
      .insertInto("erasure_traces")
      .values({
        former_user_id: person.id,
        former_account_id: person.account_id,
        former_role: person.role,
        deleted_at: now,
        digitorn_user_ref: person.digitorn_user_ref,
        // Sans profil chez Digitorn, il n'y a rien à y supprimer (US-68 RT3).
        digitorn_status: person.digitorn_user_ref ? "pending" : "done",
        completed_at: person.digitorn_user_ref ? null : now,
      })
      .execute();
  }
}

async function usersOfAccount(db: Executor, accountId: string): Promise<Leaving[]> {
  return db.selectFrom("users").select(["id", "account_id", "role", "digitorn_user_ref"]).where("account_id", "=", accountId).execute();
}

/** Supprime un compte entier et tout ce qu'il contient, chez MAAQ puis chez Digitorn (US-58 RF4). */
export async function purgeAccount(ctx: Ctx, accountId: string): Promise<void> {
  const people = await usersOfAccount(ctx.db, accountId);
  const staged = await ctx.db
    .selectFrom("contract_documents as d")
    .innerJoin("account_contracts as c", "c.id", "d.account_contract_id")
    .select("d.staging_storage_key")
    .where("c.account_id", "=", accountId)
    .execute();
  await deleteExportFiles(ctx.db, people.map((p) => p.id));

  await ctx.db.transaction().execute(async (trx) => {
    const account = await trx.selectFrom("accounts").select(["id", "subscription_ended_at"]).where("id", "=", accountId).forUpdate().executeTakeFirst();
    if (!account) return; // déjà supprimé
    // La preuve des consentements est gardée 5 ans après la fin de l'abonnement (US-36 RT1).
    const keepUntil = new Date(new Date(account.subscription_ended_at ?? ctx.now).getTime());
    keepUntil.setUTCFullYear(keepUntil.getUTCFullYear() + 5);
    await trx.updateTable("contract_consent_events").set({ retain_until: keepUntil }).where("account_id", "=", accountId).execute();
    await leaveTrace(trx, people, ctx.now);
    await trx.deleteFrom("accounts").where("id", "=", accountId).execute();
  });
  for (const key of staged) await unstage(key.staging_storage_key).catch(() => undefined);
  await processErasures(ctx, { force: true });
}

/** Supprime définitivement un invité : demandes anonymisées, adresses en copie effacées, contrats du compte conservés (US-56 RF7). */
export async function purgeGuest(ctx: Ctx, guestId: string): Promise<void> {
  const guest = await ctx.db.selectFrom("users").select(["id", "account_id", "role", "digitorn_user_ref"]).where("id", "=", guestId).where("role", "=", "guest").executeTakeFirst();
  if (!guest) return;
  await anonymizeEntries(ctx.db, guest.id, guest.digitorn_user_ref);
  await deleteExportFiles(ctx.db, [guest.id]);
  await ctx.db.transaction().execute(async (trx) => {
    await trx.deleteFrom("cc_addresses").where("user_id", "=", guest.id).execute();
    await leaveTrace(trx, [guest], ctx.now);
    await trx.deleteFrom("users").where("id", "=", guest.id).execute();
  });
  await processErasures(ctx, { force: true });
}

/** Demande à Digitorn de supprimer les profils effacés ; réessayé chaque jour, avec alerte à l'administrateur (US-58 RF5). */
export async function processErasures(ctx: Ctx, options: { force?: boolean } = {}): Promise<{ done: number; failed: number }> {
  let query = ctx.db.selectFrom("erasure_traces").select(["id", "digitorn_user_ref", "digitorn_attempts"]).where("digitorn_status", "<>", "done");
  if (!options.force) {
    const retryBefore = new Date(ctx.now.getTime() - RETRY_AFTER_HOURS * 3_600_000);
    query = query.where((eb) => eb.or([eb("last_attempt_at", "is", null), eb("last_attempt_at", "<", retryBefore)]));
  }
  const traces = await query.execute();
  let done = 0;
  const failures: string[] = [];
  for (const trace of traces) {
    try {
      if (trace.digitorn_user_ref) await digitorn().deleteProfile(trace.digitorn_user_ref);
      await ctx.db
        .updateTable("erasure_traces")
        .set({ digitorn_status: "done", completed_at: ctx.now, digitorn_user_ref: null, digitorn_attempts: trace.digitorn_attempts + 1, last_attempt_at: ctx.now, last_error: null })
        .where("id", "=", trace.id)
        .execute();
      done++;
    } catch (error) {
      const message = (error as Error).message.slice(0, 500);
      await ctx.db
        .updateTable("erasure_traces")
        .set({ digitorn_status: "failed", digitorn_attempts: trace.digitorn_attempts + 1, last_attempt_at: ctx.now, last_error: message })
        .where("id", "=", trace.id)
        .execute();
      failures.push(`trace ${trace.id} : ${message}`);
    }
  }
  if (failures.length) {
    await alertAdmin(ctx.db, "Suppression chez Digitorn en échec", `La suppression de données chez Digitorn a échoué (nouvel essai demain) :\n${failures.join("\n")}`);
  }
  return { done, failed: failures.length };
}

/** Supprime un compte ou un invité jamais activé, sans rien conserver d'autre qu'une trace (US-68). */
async function purgeNeverActivated(ctx: Ctx, candidate: Leaving): Promise<void> {
  if (candidate.role === "primary_user" && candidate.account_id) {
    await ctx.db.transaction().execute(async (trx) => {
      const people = await usersOfAccount(trx, candidate.account_id!);
      await leaveTrace(trx, people, ctx.now);
      await trx.deleteFrom("accounts").where("id", "=", candidate.account_id!).execute();
    });
    return;
  }
  await ctx.db.transaction().execute(async (trx) => {
    await leaveTrace(trx, [candidate], ctx.now);
    await trx.deleteFrom("users").where("id", "=", candidate.id).execute();
  });
}

export interface LifecycleResult {
  reminders: number;
  accountsPurged: number;
  guestsPurged: number;
  neverActivatedPurged: number;
  failures: number;
  digitorn: { done: number; failed: number };
}

/**
 * Traitement quotidien : rappels de suppression, suppressions arrivées à échéance, comptes jamais activés,
 * réessais chez Digitorn (US-56 RT2, US-58, US-68 RT1). Chaque suppression qui échoue est retentée au passage suivant.
 */
export async function runLifecycle(ctx: Ctx): Promise<LifecycleResult> {
  const result: LifecycleResult = { reminders: 0, accountsPurged: 0, guestsPurged: 0, neverActivatedPurged: 0, failures: 0, digitorn: { done: 0, failed: 0 } };
  const attempt = async (label: string, work: () => Promise<void>) => {
    try {
      await work();
      return true;
    } catch (error) {
      result.failures++;
      console.error(`Suppression en échec (${label}), reprise au prochain passage :`, error);
      return false;
    }
  };

  // Rappel 7 jours avant la suppression définitive (US-58 RF3).
  const reminders = await ctx.db
    .selectFrom("accounts as a")
    .innerJoin("users as u", (join) => join.onRef("u.account_id", "=", "a.id").on("u.role", "=", "primary_user"))
    .select(["a.id", "a.purge_scheduled_at", "u.email", "u.first_name"])
    .where("a.status", "=", "grace_period")
    .where("a.grace_reminder_sent_at", "is", null)
    .where("a.purge_scheduled_at", "<=", new Date(ctx.now.getTime() + REMINDER_DAYS * DAY_MS))
    .execute();
  for (const reminder of reminders) {
    await mail(
      reminder.email,
      "Votre compte MAAQ sera supprimé dans 7 jours",
      `Bonjour ${reminder.first_name},\n\nVotre compte et vos données seront supprimés définitivement le ${dateFr(reminder.purge_scheduled_at!)}. Pour le conserver, reconnectez-vous à MAAQ avant cette date.\n\nL'équipe MAAQ`,
    );
    await ctx.db.updateTable("accounts").set({ grace_reminder_sent_at: ctx.now }).where("id", "=", reminder.id).execute();
    result.reminders++;
  }

  const dueAccounts = await ctx.db.selectFrom("accounts").select("id").where("status", "=", "grace_period").where("purge_scheduled_at", "<=", ctx.now).execute();
  for (const account of dueAccounts) {
    if (await attempt(`compte ${account.id}`, () => purgeAccount(ctx, account.id))) result.accountsPurged++;
  }

  // Invités qui ont supprimé leur compte (délai de grâce écoulé) ou que l'utilisateur principal a retirés (US-20 RT2).
  const dueGuests = await ctx.db
    .selectFrom("users as u")
    .innerJoin("accounts as a", "a.id", "u.account_id")
    .select("u.id")
    .where("u.role", "=", "guest")
    .where("u.status", "in", ["grace_period", "removed"])
    .where("u.purge_scheduled_at", "<=", ctx.now)
    .where("a.status", "<>", "grace_period")
    .execute();
  for (const guest of dueGuests) {
    if (await attempt(`invité ${guest.id}`, () => purgeGuest(ctx, guest.id))) result.guestsPurged++;
  }

  const stale = await ctx.db.selectFrom("v_never_activated_purge_candidates").select(["user_id", "account_id", "role"]).execute();
  for (const candidate of stale) {
    const row: Leaving = { id: candidate.user_id!, account_id: candidate.account_id, role: candidate.role!, digitorn_user_ref: null };
    if (await attempt(`jamais activé ${row.id}`, () => purgeNeverActivated(ctx, row))) result.neverActivatedPurged++;
  }

  result.digitorn = await processErasures(ctx);
  return result;
}
