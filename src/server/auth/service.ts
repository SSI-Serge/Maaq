import { randomUUID } from "node:crypto";
import type { Kysely, Transaction } from "kysely";
import { digitorn } from "@/server/adapters/digitorn";
import type { DB, SecurityEventType } from "@/server/db/schema.generated";
import { randomToken, sha256 } from "@/server/security/crypto";
import { hashSecret, isStrongPassword, verifySecret } from "@/server/security/password";
import { checkCode, issueCode, type CheckResult } from "./codes";
import {
  sendCode,
  sendNewDeviceAlert,
  sendPasswordChangedConfirmation,
  sendPatternChangedConfirmation,
  sendPatternLockedAlert,
} from "./emails";
import { describeDevice, maskEmail, maskPhone, type DeviceKind } from "./format";
import {
  CODE_TTL_MINUTES,
  LOGIN_LOCK_MINUTES,
  LOGIN_MAX_FAILURES,
  PATTERN_MAX_FAILURES,
  PATTERN_MIN_POINTS,
  SESSION_MONTHS,
} from "./rules";
import { secretDigest } from "./tokens";

export interface Ctx {
  db: Kysely<DB>;
  now: Date;
}

type Db = Kysely<DB> | Transaction<DB>;

export type Role = "admin" | "primary_user" | "guest";

/** Profil connecté, tel que vu par les écrans et les routes protégées. */
export interface SessionContext {
  sessionId: string;
  user: {
    id: string;
    accountId: string | null;
    role: Role;
    guestRank: "core" | "secondary" | null;
    firstName: string;
    lastName: string;
    email: string;
    setupCompleted: boolean;
    inGracePeriod: boolean;
  };
  device: {
    id: string;
    type: DeviceKind;
    timezone: string;
    hasPattern: boolean;
    patternLocked: boolean;
  };
}

// ---------------------------------------------------------------------------
// Profils et sessions
// ---------------------------------------------------------------------------

function findUserByEmail(db: Db, email: string) {
  return db
    .selectFrom("users as u")
    .leftJoin("accounts as a", "a.id", "u.account_id")
    .select([
      "u.id",
      "u.account_id",
      "u.role",
      "u.first_name",
      "u.email",
      "u.phone",
      "u.password_hash",
      "u.status",
      "u.failed_login_count",
      "u.login_locked_until",
      "a.status as account_status",
    ])
    .where("u.email", "=", email.trim())
    .where("u.status", "<>", "removed")
    .executeTakeFirst();
}

type FoundUser = NonNullable<Awaited<ReturnType<typeof findUserByEmail>>>;

/** Profil qui peut se connecter (actif, ou en délai de grâce : US-3 RF11). */
function canSignIn(user: FoundUser): boolean {
  return Boolean(user.password_hash) && (user.status === "active" || user.status === "grace_period");
}

/** Profil qui peut recevoir un code de récupération (US-66 RF11 : ni délai de grâce, ni supprimé). */
function canRecover(user: FoundUser): boolean {
  return user.status === "active" && user.account_status !== "grace_period" && Boolean(user.password_hash);
}

/** Écran d'arrivée après connexion ou déverrouillage (US-3 RF6, RF7, RF11 ; US-7 RF4). */
export function homeFor(session: SessionContext): string {
  if (session.user.inGracePeriod) return "/reprise-compte";
  if (session.user.role !== "admin" && (!session.device.hasPattern || session.device.patternLocked)) return "/schema/creer";
  if (session.user.role === "admin") return "/admin";
  if (session.user.role === "primary_user" && !session.user.setupCompleted) return "/configuration";
  return "/accueil";
}

export async function createSession(db: Db, userId: string, deviceId: string, now: Date) {
  const token = randomToken();
  const expiresAt = new Date(now);
  expiresAt.setMonth(expiresAt.getMonth() + SESSION_MONTHS);
  // Une seule session ouverte par profil et par appareil.
  await db
    .updateTable("sessions")
    .set({ revoked_at: now, revoked_reason: "logout" })
    .where("user_id", "=", userId)
    .where("device_id", "=", deviceId)
    .where("revoked_at", "is", null)
    .execute();
  const row = await db
    .insertInto("sessions")
    .values({ user_id: userId, device_id: deviceId, token_hash: sha256(token), expires_at: expiresAt, created_at: now, last_seen_at: now })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { token, sessionId: row.id, expiresAt };
}

/** Session valide correspondant au jeton du cookie, ou null. */
export async function getSession(ctx: Ctx, token: string | undefined): Promise<SessionContext | null> {
  if (!token) return null;
  const row = await ctx.db
    .selectFrom("sessions as s")
    .innerJoin("users as u", "u.id", "s.user_id")
    .innerJoin("devices as d", "d.id", "s.device_id")
    .leftJoin("accounts as a", "a.id", "u.account_id")
    .select([
      "s.id as session_id",
      "s.last_seen_at",
      "u.id as user_id",
      "u.account_id",
      "u.role",
      "u.guest_rank",
      "u.first_name",
      "u.last_name",
      "u.email",
      "u.status",
      "u.initial_setup_step",
      "a.status as account_status",
      "d.id as device_id",
      "d.device_type",
      "d.timezone",
      "d.pattern_hash",
      "d.pattern_locked_at",
    ])
    .where("s.token_hash", "=", sha256(token))
    .where("s.revoked_at", "is", null)
    .where("s.expires_at", ">", ctx.now)
    .where("d.revoked_at", "is", null)
    .where("u.status", "in", ["active", "grace_period"])
    .executeTakeFirst();
  if (!row) return null;

  // Dernière activité, mise à jour au plus une fois par minute.
  if (ctx.now.getTime() - new Date(row.last_seen_at).getTime() > 60_000) {
    await ctx.db.updateTable("sessions").set({ last_seen_at: ctx.now }).where("id", "=", row.session_id).execute();
    await ctx.db.updateTable("devices").set({ last_activity_at: ctx.now }).where("id", "=", row.device_id).execute();
  }

  return {
    sessionId: row.session_id,
    user: {
      id: row.user_id,
      accountId: row.account_id,
      role: row.role,
      guestRank: row.guest_rank,
      firstName: row.first_name,
      lastName: row.last_name,
      email: row.email,
      setupCompleted: row.initial_setup_step === null || row.initial_setup_step === "completed",
      inGracePeriod: row.status === "grace_period" || row.account_status === "grace_period",
    },
    device: {
      id: row.device_id,
      type: row.device_type,
      timezone: row.timezone,
      hasPattern: row.pattern_hash !== null,
      patternLocked: row.pattern_locked_at !== null,
    },
  };
}

async function logSecurityEvent(
  db: Db,
  event: { userId: string | null; type: SecurityEventType; deviceId?: string | null; now: Date; details?: Record<string, unknown> },
) {
  await db
    .insertInto("security_events")
    .values({
      user_id: event.userId,
      device_id: event.deviceId ?? null,
      event_type: event.type,
      occurred_at: event.now,
      details: event.details ? JSON.stringify(event.details) : null,
    })
    .execute();
}

// ---------------------------------------------------------------------------
// Connexion par mot de passe (US-3)
// ---------------------------------------------------------------------------

let dummyHash: Promise<string> | undefined;
/** Vérification factice pour un email inconnu : même durée de réponse qu'un vrai compte. */
function burnTime(password: string) {
  dummyHash ??= hashSecret("maaq-mot-de-passe-factice-1");
  return dummyHash.then((h) => verifySecret(h, password));
}

export type PasswordCheck = { kind: "ok" } | { kind: "invalid" } | { kind: "locked"; until: Date };

/** Vérifie le mot de passe et tient le compteur d'échecs côté serveur (US-3 RF4, RT2). */
async function checkPassword(ctx: Ctx, user: FoundUser, password: string): Promise<PasswordCheck> {
  if (user.login_locked_until && new Date(user.login_locked_until) > ctx.now) {
    return { kind: "locked", until: new Date(user.login_locked_until) };
  }
  if (await verifySecret(user.password_hash!, password)) {
    if (user.failed_login_count > 0 || user.login_locked_until) {
      await ctx.db
        .updateTable("users")
        .set({ failed_login_count: 0, login_locked_until: null })
        .where("id", "=", user.id)
        .execute();
    }
    return { kind: "ok" };
  }

  return ctx.db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom("users")
      .select(["failed_login_count"])
      .where("id", "=", user.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const failures = current.failed_login_count + 1;
    if (failures >= LOGIN_MAX_FAILURES) {
      const until = new Date(ctx.now.getTime() + LOGIN_LOCK_MINUTES * 60_000);
      await trx.updateTable("users").set({ failed_login_count: 0, login_locked_until: until }).where("id", "=", user.id).execute();
      await logSecurityEvent(trx, { userId: user.id, type: "login_locked", now: ctx.now });
      return { kind: "locked" as const, until };
    }
    await trx.updateTable("users").set({ failed_login_count: failures }).where("id", "=", user.id).execute();
    return { kind: "invalid" as const };
  });
}

export interface LoginInput {
  email: string;
  password: string;
  /** Identifiants d'appareils conservés par ce navigateur (cookie). */
  knownDeviceIds: string[];
  timezone: string;
}

export type LoginResult =
  | { kind: "invalid" }
  | { kind: "locked"; until: Date }
  | { kind: "verify"; userId: string; deviceIdentifier: string }
  | { kind: "session"; token: string; sessionId: string; expiresAt: Date; deviceId: string; next: string };

export async function login(ctx: Ctx, input: LoginInput): Promise<LoginResult> {
  const user = await findUserByEmail(ctx.db, input.email);
  if (!user || !canSignIn(user)) {
    await burnTime(input.password);
    return { kind: "invalid" };
  }
  const check = await checkPassword(ctx, user, input.password);
  if (check.kind !== "ok") return check;

  const device = await recognizedDevice(ctx.db, user.id, input.knownDeviceIds);
  if (!device) {
    // Appareil inconnu : vérification d'identité avant tout accès (US-3 RF5, US-51).
    return { kind: "verify", userId: user.id, deviceIdentifier: randomUUID() };
  }

  await ctx.db.updateTable("devices").set({ timezone: input.timezone, last_activity_at: ctx.now }).where("id", "=", device).execute();
  const session = await createSession(ctx.db, user.id, device, ctx.now);
  const context = await getSession(ctx, session.token);
  return { kind: "session", ...session, deviceId: device, next: homeFor(context!) };
}

async function recognizedDevice(db: Db, userId: string, knownDeviceIds: string[]): Promise<string | null> {
  if (knownDeviceIds.length === 0) return null;
  const row = await db
    .selectFrom("devices")
    .select("id")
    .where("user_id", "=", userId)
    .where("id", "in", knownDeviceIds)
    .where("revoked_at", "is", null)
    .orderBy("last_activity_at", "desc")
    .executeTakeFirst();
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// Vérification d'un nouvel appareil (US-51)
// ---------------------------------------------------------------------------

export interface PendingVerification {
  userId: string;
  deviceIdentifier: string;
  timezone: string;
}

export async function verificationTargets(ctx: Ctx, pending: PendingVerification) {
  const user = await ctx.db
    .selectFrom("users")
    .select(["email", "phone"])
    .where("id", "=", pending.userId)
    .executeTakeFirst();
  if (!user) return null;
  return { maskedEmail: maskEmail(user.email), maskedPhone: user.phone ? maskPhone(user.phone) : null };
}

export type SendCodeResult =
  | { kind: "sent"; resendAvailableAt: Date }
  | { kind: "cooldown" | "rate_limited"; retryAt: Date }
  | { kind: "no_phone" }
  | { kind: "unknown" };

export async function sendDeviceCode(ctx: Ctx, pending: PendingVerification, channel: "email" | "sms"): Promise<SendCodeResult> {
  const user = await ctx.db
    .selectFrom("users")
    .select(["id", "first_name", "email", "phone", "status"])
    .where("id", "=", pending.userId)
    .executeTakeFirst();
  if (!user || (user.status !== "active" && user.status !== "grace_period")) return { kind: "unknown" };
  if (channel === "sms" && !user.phone) return { kind: "no_phone" };

  const target = channel === "sms" ? user.phone! : user.email;
  const issued = await issueCode(ctx.db, {
    userId: user.id,
    purpose: "device_verification",
    channel,
    target,
    deviceIdentifier: pending.deviceIdentifier,
    now: ctx.now,
  });
  if (!issued.ok) return { kind: issued.reason, retryAt: issued.retryAt };
  await sendCode({
    channel,
    to: target,
    firstName: user.first_name,
    code: issued.code,
    ttlMinutes: CODE_TTL_MINUTES.device_verification,
    reason: "device",
  });
  return { kind: "sent", resendAvailableAt: issued.resendAvailableAt };
}

export type VerifyDeviceResult =
  | { kind: Exclude<CheckResult, "ok"> }
  | { kind: "session"; token: string; sessionId: string; expiresAt: Date; deviceId: string; next: string };

export async function verifyDevice(
  ctx: Ctx,
  pending: PendingVerification,
  code: string,
  userAgent: string | null,
): Promise<VerifyDeviceResult> {
  const result = await checkCode(ctx.db, {
    userId: pending.userId,
    purpose: "device_verification",
    code,
    deviceIdentifier: pending.deviceIdentifier,
    now: ctx.now,
  });
  if (result !== "ok") return { kind: result };

  const { type, browser } = describeDevice(userAgent);
  const user = await ctx.db
    .selectFrom("users")
    .select(["email", "first_name"])
    .where("id", "=", pending.userId)
    .executeTakeFirstOrThrow();

  const session = await ctx.db.transaction().execute(async (trx) => {
    await trx
      .insertInto("devices")
      .values({
        id: pending.deviceIdentifier,
        user_id: pending.userId,
        device_type: type,
        browser,
        timezone: pending.timezone,
        first_connected_at: ctx.now,
        last_activity_at: ctx.now,
      })
      .execute();
    await logSecurityEvent(trx, {
      userId: pending.userId,
      type: "device_verified",
      deviceId: pending.deviceIdentifier,
      now: ctx.now,
      details: { device_type: type, browser },
    });
    return createSession(trx, pending.userId, pending.deviceIdentifier, ctx.now);
  });

  await sendNewDeviceAlert(user.email, user.first_name, type, ctx.now, pending.timezone);
  const context = await getSession(ctx, session.token);
  return { kind: "session", ...session, deviceId: pending.deviceIdentifier, next: homeFor(context!) };
}

// ---------------------------------------------------------------------------
// Schéma tactile (US-6, US-7, US-8)
// ---------------------------------------------------------------------------

/** Schéma valide : points 0 à 8 de la grille 3 × 3, sans doublon, au moins 4 points. */
export function isValidPattern(points: unknown): points is number[] {
  return (
    Array.isArray(points) &&
    points.length >= PATTERN_MIN_POINTS &&
    points.length <= 9 &&
    points.every((p) => Number.isInteger(p) && p >= 0 && p <= 8) &&
    new Set(points).size === points.length
  );
}

function patternSecret(userId: string, points: number[]): string {
  return secretDigest("pattern", userId, points.join("-")).toString("base64");
}

export type PatternMode = "first" | "recovery" | "after_reset";

/**
 * Enregistre le schéma de ce profil sur cet appareil. Lève le verrouillage et remet le compteur
 * d'échecs à zéro (US-8 RF5, US-66 RF7).
 */
export async function setPattern(
  ctx: Ctx,
  input: { userId: string; deviceId: string; points: number[]; mode: PatternMode },
): Promise<boolean> {
  const device = await ctx.db
    .selectFrom("devices as d")
    .innerJoin("users as u", "u.id", "d.user_id")
    .select(["d.id", "d.timezone", "u.role", "u.email", "u.first_name"])
    .where("d.id", "=", input.deviceId)
    .where("d.user_id", "=", input.userId)
    .where("d.revoked_at", "is", null)
    .executeTakeFirst();
  if (!device || device.role === "admin") return false; // l'administrateur n'a pas de schéma (US-6 RF12)

  const patternHash = await hashSecret(patternSecret(input.userId, input.points));
  await ctx.db.transaction().execute(async (trx) => {
    await trx
      .updateTable("devices")
      .set({ pattern_hash: patternHash, pattern_set_at: ctx.now, pattern_failed_count: 0, pattern_locked_at: null, updated_at: ctx.now })
      .where("id", "=", input.deviceId)
      .execute();
    if (input.mode === "recovery") {
      await logSecurityEvent(trx, { userId: input.userId, type: "pattern_recovered", deviceId: input.deviceId, now: ctx.now });
    }
  });
  if (input.mode === "recovery") {
    await sendPatternChangedConfirmation(device.email, device.first_name, ctx.now, device.timezone);
  }
  return true;
}

export type PatternUnlockResult =
  | { kind: "ok" }
  | { kind: "incorrect"; remaining: number }
  | { kind: "locked" }
  | { kind: "no_pattern" };

/** Déverrouillage par schéma, vérifié côté serveur, compteur par profil et par appareil (US-6 RT1, RT2). */
export async function unlockWithPattern(ctx: Ctx, session: SessionContext, points: number[]): Promise<PatternUnlockResult> {
  const device = await ctx.db
    .selectFrom("devices")
    .select(["pattern_hash", "pattern_locked_at", "pattern_failed_count", "device_type", "timezone"])
    .where("id", "=", session.device.id)
    .executeTakeFirstOrThrow();
  if (device.pattern_locked_at) return { kind: "locked" };
  if (!device.pattern_hash) return { kind: "no_pattern" };

  if (isValidPattern(points) && (await verifySecret(device.pattern_hash, patternSecret(session.user.id, points)))) {
    if (device.pattern_failed_count > 0) {
      await ctx.db.updateTable("devices").set({ pattern_failed_count: 0 }).where("id", "=", session.device.id).execute();
    }
    return { kind: "ok" };
  }

  const outcome = await ctx.db.transaction().execute(async (trx) => {
    const current = await trx
      .selectFrom("devices")
      .select(["pattern_failed_count", "pattern_locked_at"])
      .where("id", "=", session.device.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    if (current.pattern_locked_at) return { kind: "locked" as const, newlyLocked: false };
    const failures = current.pattern_failed_count + 1;
    if (failures >= PATTERN_MAX_FAILURES) {
      await trx
        .updateTable("devices")
        .set({ pattern_failed_count: PATTERN_MAX_FAILURES, pattern_locked_at: ctx.now })
        .where("id", "=", session.device.id)
        .execute();
      await logSecurityEvent(trx, { userId: session.user.id, type: "pattern_locked", deviceId: session.device.id, now: ctx.now });
      return { kind: "locked" as const, newlyLocked: true };
    }
    await trx.updateTable("devices").set({ pattern_failed_count: failures }).where("id", "=", session.device.id).execute();
    return { kind: "incorrect" as const, remaining: PATTERN_MAX_FAILURES - failures };
  });

  if (outcome.kind === "locked") {
    if (outcome.newlyLocked) {
      await sendPatternLockedAlert(session.user.email, session.user.firstName, device.device_type, ctx.now, device.timezone);
    }
    return { kind: "locked" };
  }
  return outcome;
}

/** Déverrouillage de l'administrateur, par mot de passe (US-52 RF8). */
export async function unlockWithPassword(ctx: Ctx, session: SessionContext, password: string): Promise<PasswordCheck> {
  const user = await findUserByEmail(ctx.db, session.user.email);
  if (!user || !canSignIn(user)) return { kind: "invalid" };
  return checkPassword(ctx, user, password);
}

// ---------------------------------------------------------------------------
// Codes de récupération : schéma oublié (US-8) et mot de passe oublié (US-66)
// ---------------------------------------------------------------------------

export type RecoveryPurpose = "access_recovery" | "password_reset";

/**
 * Envoie un code si l'adresse correspond à un profil autorisé. La réponse affichée est toujours
 * la même, qu'un compte existe ou non (US-8 RF3, US-66 RF3).
 */
export async function requestRecoveryCode(ctx: Ctx, email: string, purpose: RecoveryPurpose): Promise<void> {
  const user = await findUserByEmail(ctx.db, email);
  if (!user || !canRecover(user)) return;
  if (purpose === "access_recovery" && user.role === "admin") return; // pas de schéma pour l'administrateur
  const issued = await issueCode(ctx.db, { userId: user.id, purpose, channel: "email", target: user.email, now: ctx.now });
  if (!issued.ok) return; // limites d'envoi : rien n'est envoyé, le message reste neutre
  await sendCode({
    channel: "email",
    to: user.email,
    firstName: user.first_name,
    code: issued.code,
    ttlMinutes: CODE_TTL_MINUTES[purpose],
    reason: purpose === "access_recovery" ? "recovery" : "password",
  });
}

export type RecoveryCheckResult =
  | { kind: Exclude<CheckResult, "ok"> }
  | { kind: "ok"; userId: string; deviceId: string | null; role: Role };

export async function verifyRecoveryCode(
  ctx: Ctx,
  input: { email: string; code: string; purpose: RecoveryPurpose; knownDeviceIds: string[] },
): Promise<RecoveryCheckResult> {
  const user = await findUserByEmail(ctx.db, input.email);
  if (!user || !canRecover(user)) return { kind: "incorrect" };
  const result = await checkCode(ctx.db, { userId: user.id, purpose: input.purpose, code: input.code, now: ctx.now });
  if (result !== "ok") return { kind: result };
  return {
    kind: "ok",
    userId: user.id,
    role: user.role,
    deviceId: await recognizedDevice(ctx.db, user.id, input.knownDeviceIds),
  };
}

export type PasswordResetResult = { kind: "weak" } | { kind: "mismatch" } | { kind: "ok"; offerPattern: boolean };

/** Nouveau mot de passe après un code correct (US-66 RF6 à RF10). */
export async function completePasswordReset(
  ctx: Ctx,
  input: { userId: string; deviceId: string | null; password: string; confirmation: string; timezone: string },
): Promise<PasswordResetResult> {
  if (!isStrongPassword(input.password)) return { kind: "weak" };
  if (input.password !== input.confirmation) return { kind: "mismatch" };

  const passwordHash = await hashSecret(input.password);
  const user = await ctx.db.transaction().execute(async (trx) => {
    const updated = await trx
      .updateTable("users")
      .set({ password_hash: passwordHash, failed_login_count: 0, login_locked_until: null, updated_at: ctx.now })
      .where("id", "=", input.userId)
      .returning(["email", "first_name", "role"])
      .executeTakeFirstOrThrow();
    // Les sessions des autres appareils sont fermées (US-66 RF9).
    let revoke = trx
      .updateTable("sessions")
      .set({ revoked_at: ctx.now, revoked_reason: "logout" })
      .where("user_id", "=", input.userId)
      .where("revoked_at", "is", null);
    if (input.deviceId) revoke = revoke.where("device_id", "<>", input.deviceId);
    await revoke.execute();
    await logSecurityEvent(trx, { userId: input.userId, type: "password_changed", deviceId: input.deviceId, now: ctx.now });
    return updated;
  });

  await sendPasswordChangedConfirmation(user.email, user.first_name, ctx.now, input.timezone);
  return { kind: "ok", offerPattern: user.role !== "admin" && input.deviceId !== null };
}

// ---------------------------------------------------------------------------
// Déconnexion (US-9)
// ---------------------------------------------------------------------------

/**
 * Ferme la session côté serveur puis demande l'effacement des tchats du profil chez Digitorn
 * (US-9 RF4, RT2). Un effacement qui échoue reste en attente et sera réessayé (US-43).
 */
export async function logout(ctx: Ctx, session: SessionContext): Promise<void> {
  const request = await ctx.db.transaction().execute(async (trx) => {
    await trx
      .updateTable("sessions")
      .set({ revoked_at: ctx.now, revoked_reason: "logout" })
      .where("id", "=", session.sessionId)
      .where("revoked_at", "is", null)
      .execute();
    if (session.user.role === "admin") return null; // pas de tchat pour l'administrateur
    return trx
      .insertInto("chat_erasure_requests")
      .values({ user_id: session.user.id, reason: "logout", requested_at: ctx.now })
      .returning("id")
      .executeTakeFirstOrThrow();
  });
  if (request) await processChatErasure(ctx, request.id);
}

/** Efface chez Digitorn les tchats visés par une demande ; trace l'échec pour une reprise. */
export async function processChatErasure(ctx: Ctx, requestId: string): Promise<void> {
  const request = await ctx.db
    .selectFrom("chat_erasure_requests as r")
    .innerJoin("users as u", "u.id", "r.user_id")
    .select(["r.id", "r.user_id", "r.agent_id", "r.attempts", "u.digitorn_user_ref"])
    .where("r.id", "=", requestId)
    .where("r.status", "<>", "done")
    .executeTakeFirst();
  if (!request) return;

  try {
    if (request.digitorn_user_ref) {
      let agents = ctx.db
        .selectFrom("profile_agents as pa")
        .innerJoin("agents as a", "a.id", "pa.agent_id")
        .select("a.digitorn_agent_ref")
        .where("pa.user_id", "=", request.user_id);
      if (request.agent_id !== null) agents = agents.where("pa.agent_id", "=", request.agent_id);
      for (const agent of await agents.execute()) {
        await digitorn().eraseConversation(request.digitorn_user_ref, agent.digitorn_agent_ref);
      }
    }
    await ctx.db
      .updateTable("chat_erasure_requests")
      .set({ status: "done", completed_at: ctx.now, attempts: request.attempts + 1, last_attempt_at: ctx.now, last_error: null })
      .where("id", "=", request.id)
      .execute();
  } catch (error) {
    await ctx.db
      .updateTable("chat_erasure_requests")
      .set({
        status: "failed",
        attempts: request.attempts + 1,
        last_attempt_at: ctx.now,
        last_error: (error as Error).message.slice(0, 500),
      })
      .where("id", "=", request.id)
      .execute();
  }
}
