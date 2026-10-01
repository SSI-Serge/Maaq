import { cookies, headers } from "next/headers";
import { db } from "@/server/db/client";
import { Rejection } from "@/server/http";
import { safeTimezone } from "./format";
import { IDLE_LOCK_MINUTES, PENDING_FLOW_MINUTES } from "./rules";
import { getSession, type Ctx, type PendingVerification, type SessionContext } from "./service";
import { signToken, verifyToken } from "./tokens";

/**
 * Cookies de connexion (tous httpOnly, inaccessibles au JavaScript de la page) :
 *  - maaq_session : session mémorisée 3 mois (US-6 RT3) ;
 *  - maaq_unlock  : session déverrouillée, valable 5 minutes et prolongée à chaque activité (US-52) ;
 *  - maaq_devices : identifiants des appareils reconnus sur ce navigateur (US-51 RT1) ;
 *  - maaq_pending : vérification d'appareil en cours (US-51) ;
 *  - maaq_grant   : droit de recréer son schéma ou son mot de passe après un code correct (US-8, US-66).
 */
const SESSION = "maaq_session";
const UNLOCK = "maaq_unlock";
const DEVICES = "maaq_devices";
const PENDING = "maaq_pending";
const GRANT = "maaq_grant";

const MAX_REMEMBERED_DEVICES = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function baseOptions() {
  return { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/" };
}

export function ctx(): Ctx {
  return { db: db(), now: new Date() };
}

export async function requestTimezone(body?: { timezone?: unknown }): Promise<string> {
  return safeTimezone(body?.timezone ?? (await headers()).get("x-timezone"));
}

export async function userAgent(): Promise<string | null> {
  return (await headers()).get("user-agent");
}

// --- Appareils reconnus -----------------------------------------------------

export async function knownDeviceIds(): Promise<string[]> {
  const raw = (await cookies()).get(DEVICES)?.value ?? "";
  return raw.split(",").filter((id) => UUID.test(id));
}

export async function rememberDevice(deviceId: string): Promise<void> {
  const ids = [deviceId, ...(await knownDeviceIds()).filter((id) => id !== deviceId)].slice(0, MAX_REMEMBERED_DEVICES);
  (await cookies()).set(DEVICES, ids.join(","), { ...baseOptions(), maxAge: 400 * 24 * 3600 });
}

// --- Session et déverrouillage ---------------------------------------------

export async function openSession(token: string, expiresAt: Date, sessionId: string, now: Date): Promise<void> {
  (await cookies()).set(SESSION, token, { ...baseOptions(), expires: expiresAt });
  await markUnlocked(sessionId, now);
}

export async function markUnlocked(sessionId: string, now: Date): Promise<void> {
  const token = signToken({ sid: sessionId, exp: now.getTime() + IDLE_LOCK_MINUTES * 60_000 });
  (await cookies()).set(UNLOCK, token, baseOptions());
}

export async function lockSession(): Promise<void> {
  (await cookies()).delete(UNLOCK);
}

export async function closeSessionCookies(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION);
  jar.delete(UNLOCK);
}

export async function currentSession(context: Ctx = ctx()): Promise<SessionContext | null> {
  return getSession(context, (await cookies()).get(SESSION)?.value);
}

export async function isUnlocked(session: SessionContext, now: Date): Promise<boolean> {
  const token = verifyToken<{ sid: string; exp: number }>((await cookies()).get(UNLOCK)?.value, now);
  return token?.sid === session.sessionId;
}

/**
 * Garde des routes protégées : session valide ET déverrouillée. Prolonge le déverrouillage
 * (5 minutes glissantes). Refus 401 sans session, 423 si l'application est verrouillée.
 */
export async function requireProfile(options: { allowGrace?: boolean } = {}): Promise<{ session: SessionContext; ctx: Ctx }> {
  const context = ctx();
  const session = await currentSession(context);
  if (!session) throw new Rejection("unauthenticated", "Votre session a expiré. Reconnectez-vous.", 401);
  if (!(await isUnlocked(session, context.now))) throw new Rejection("locked", "MAAQ est verrouillé.", 423);
  if (session.user.inGracePeriod && !options.allowGrace) {
    throw new Rejection("grace_period", "Votre compte est en cours de suppression.", 403);
  }
  await markUnlocked(session.sessionId, context.now);
  return { session, ctx: context };
}

/** Garde de la console : profil administrateur connecté et déverrouillé. */
export async function requireAdmin(): Promise<{ session: SessionContext; ctx: Ctx }> {
  const guarded = await requireProfile();
  if (guarded.session.user.role !== "admin") throw new Rejection("forbidden", "Accès réservé à l'administration.", 403);
  return guarded;
}

// --- Parcours en attente ----------------------------------------------------

export async function setPending(pending: PendingVerification, now: Date): Promise<void> {
  const token = signToken({ ...pending, exp: now.getTime() + PENDING_FLOW_MINUTES * 60_000 });
  (await cookies()).set(PENDING, token, baseOptions());
}

export async function readPending(now: Date): Promise<PendingVerification | null> {
  const token = verifyToken<PendingVerification & { exp: number }>((await cookies()).get(PENDING)?.value, now);
  return token ? { userId: token.userId, deviceIdentifier: token.deviceIdentifier, timezone: token.timezone } : null;
}

export async function clearPending(): Promise<void> {
  (await cookies()).delete(PENDING);
}

export type GrantPurpose = "pattern_recovery" | "password_reset" | "pattern_after_reset";

export interface Grant {
  userId: string;
  deviceId: string | null;
  purpose: GrantPurpose;
}

export async function setGrant(grant: Grant, now: Date): Promise<void> {
  const token = signToken({ ...grant, exp: now.getTime() + PENDING_FLOW_MINUTES * 60_000 });
  (await cookies()).set(GRANT, token, baseOptions());
}

export async function readGrant(now: Date): Promise<Grant | null> {
  const token = verifyToken<Grant & { exp: number }>((await cookies()).get(GRANT)?.value, now);
  return token ? { userId: token.userId, deviceId: token.deviceId, purpose: token.purpose } : null;
}

export async function clearGrant(): Promise<void> {
  (await cookies()).delete(GRANT);
}
