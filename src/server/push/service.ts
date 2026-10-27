import type { Kysely } from "kysely";
import { createHash } from "node:crypto";
import webpush from "web-push";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { seal, open } from "@/server/assistant/fields";
import { Rejection } from "@/server/http";

/**
 * Notifications web (US-94, US-81 RF6, RT3, RT4). Chaque appareil qui a autorisé les notifications est inscrit avec l'adresse que son navigateur
 * lui a donnée ; le serveur y envoie des messages chiffrés pour cet appareil seul. Sans clés VAPID, rien ne part : les rappels passent par email.
 */

export interface PushPayload {
  title: string;
  body: string;
  /** Écran ouvert au toucher. */
  url: string;
  /** Une notification de même étiquette remplace la précédente. */
  tag: string;
  /** Nombre de confirmations en attente, pour le badge de l'icône (US-84 RT2). */
  badge: number;
}

export interface SubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

type Db = Kysely<DB>;

/**
 * Services de notification des navigateurs. Le serveur envoie vers l'adresse fournie par l'appareil : sans liste blanche, un profil pourrait lui
 * faire appeler n'importe quelle adresse (SSRF).
 */
const PUSH_HOSTS = ["fcm.googleapis.com", "android.googleapis.com", "push.services.mozilla.com", "push.apple.com", "notify.windows.com"];

export function isPushEndpoint(value: string): boolean {
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && PUSH_HOSTS.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

export function pushConfigured(): boolean {
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = env();
  return Boolean(VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY);
}

export function vapidPublicKey(): string | null {
  return env().VAPID_PUBLIC_KEY ?? null;
}

let configured = false;
function configure(): void {
  if (configured) return;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT } = env();
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY!, VAPID_PRIVATE_KEY!);
  configured = true;
}

const BASE64URL = /^[A-Za-z0-9_-]{16,200}={0,2}$/;

/** Inscrit l'appareil en cours aux notifications (US-94 RF4). Une même adresse appartient à un seul appareil : elle passe à l'appareil qui l'envoie. */
export async function saveSubscription(ctx: Ctx, session: SessionContext, input: SubscriptionInput): Promise<void> {
  if (!pushConfigured()) throw new Rejection("push_unavailable", "Les notifications ne sont pas disponibles pour le moment.", 503);
  if (!isPushEndpoint(input.endpoint) || !BASE64URL.test(input.keys.p256dh) || !BASE64URL.test(input.keys.auth)) {
    throw new Rejection("invalid_subscription", "Cet abonnement aux notifications n'est pas valide.", 422);
  }
  // L'adresse et les clés sont des secrets : chiffrées, avec l'empreinte de l'adresse pour la retrouver. Un appareil n'a qu'un abonnement, et une adresse
  // n'appartient qu'à un appareil : l'ancien abonnement de l'appareil et l'ancien propriétaire de l'adresse sont remplacés.
  const hash = endpointHash(input.endpoint);
  await ctx.db.transaction().execute(async (trx) => {
    await trx.deleteFrom("push_subscriptions").where((eb) => eb.or([eb("device_id", "=", session.device.id), eb("endpoint_hash", "=", hash)])).execute();
    await trx
      .insertInto("push_subscriptions")
      .values({ device_id: session.device.id, endpoint_encrypted: seal(input.endpoint), endpoint_hash: hash, p256dh_encrypted: seal(input.keys.p256dh), auth_encrypted: seal(input.keys.auth), created_at: ctx.now })
      .execute();
  });
}

/** Empreinte de l'adresse d'un abonnement : sert à la retrouver sans la lire. */
export const endpointHash = (endpoint: string): Buffer => createHash("sha256").update(endpoint).digest();

/** Désinscrit l'appareil en cours. */
export async function removeSubscription(ctx: Ctx, session: SessionContext): Promise<void> {
  await removeDeviceSubscriptions(ctx.db, session.device.id);
}

/** À la déconnexion et à la révocation d'un appareil, il n'est plus inscrit (US-94 RF9). */
export async function removeDeviceSubscriptions(db: Db, deviceId: string): Promise<void> {
  await db.deleteFrom("push_subscriptions").where("device_id", "=", deviceId).execute();
}

export async function pushStatus(ctx: Ctx, session: SessionContext): Promise<{ configured: boolean; publicKey: string | null; subscribed: boolean }> {
  const row = await ctx.db.selectFrom("push_subscriptions").select("id").where("device_id", "=", session.device.id).limit(1).executeTakeFirst();
  return { configured: pushConfigured(), publicKey: vapidPublicKey(), subscribed: Boolean(row) };
}

const TTL_SECONDS = 12 * 3600;

interface Failure {
  statusCode?: number;
}

/** 404 et 410 : l'appareil n'existe plus pour ce service. Les autres refus (400, 401, 403) tiennent à notre configuration, pas à l'appareil. */
const gone = (status: number | undefined) => status === 404 || status === 410;
const temporary = (status: number | undefined) => status === undefined || status === 429 || status >= 500;

/**
 * Envoie la notification à chaque appareil autorisé du profil (US-81 RF6, US-94 RF8). Un abonnement disparu est supprimé ; une erreur
 * temporaire est retentée une fois, sans désinscrire (US-81 RT4). Retourne le nombre d'appareils joints : zéro veut dire « passer par email ».
 */
export async function sendPush(ctx: Ctx, userId: string, payload: PushPayload): Promise<{ attempted: number; delivered: number }> {
  if (!pushConfigured()) return { attempted: 0, delivered: 0 };
  const subscriptions = await ctx.db
    .selectFrom("push_subscriptions as s")
    .innerJoin("devices as d", "d.id", "s.device_id")
    .select(["s.id", "s.endpoint_encrypted", "s.p256dh_encrypted", "s.auth_encrypted"])
    .where("d.user_id", "=", userId)
    .where("d.revoked_at", "is", null)
    .execute();
  configure();
  const body = JSON.stringify(payload);
  let delivered = 0;
  for (const sub of subscriptions) {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        await webpush.sendNotification({ endpoint: open(sub.endpoint_encrypted), keys: { p256dh: open(sub.p256dh_encrypted), auth: open(sub.auth_encrypted) } }, body, { TTL: TTL_SECONDS, urgency: "high", timeout: 10_000 });
        delivered += 1;
        await ctx.db.updateTable("push_subscriptions").set({ last_success_at: ctx.now }).where("id", "=", sub.id).execute();
        break;
      } catch (error) {
        const status = (error as Failure).statusCode;
        if (gone(status)) {
          await ctx.db.deleteFrom("push_subscriptions").where("id", "=", sub.id).execute();
          break;
        }
        if (!temporary(status) || attempt === 2) {
          console.error("Notification non envoyée :", status ?? error);
          break;
        }
      }
    }
  }
  return { attempted: subscriptions.length, delivered };
}
