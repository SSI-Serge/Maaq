import { sql } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { Rejection } from "@/server/http";
import { parsePoint, sealPoint, type PlacePoint } from "./address";
import { requireFamilyProfile } from "./family";
import { open } from "./fields";

/**
 * Consentement à la position et dernière position connue d'un appareil (US-107 RF11, RF12, RT3, RT5).
 * Une application web ne lit la position que lorsqu'elle est ouverte au premier plan : MAAQ ne la lit que sur l'écran « Suivi du trajet » ou à l'ouverture de l'application.
 * Le consentement est propre à chaque appareil, retirable à tout moment ; chaque accord et chaque retrait sont inscrits au journal par la base (preuve du consentement, 5 ans,
 * décision du DPO). La dernière position est chiffrée, gardée 3 heures au plus et jamais au-delà de la fin du RDV suivi, effacée au retrait, à la révocation de l'appareil
 * et à la déconnexion (triggers). Aucune route ne la lit : seul le serveur s'en sert, pour l'estimation du trajet de son propre profil.
 */
export const LOCATION_NOTICE_VERSION = "2026-10";
export const LOCATION_NOTICE =
  "MAAQ lit votre position seulement quand l'application est ouverte, pour estimer votre trajet avant un RDV que vous suivez. Votre dernière position est gardée au plus 3 heures.";
export const LOCATION_NOTICE_WITHDRAW = "Vous pouvez retirer cette autorisation à tout moment dans les réglages.";
const KEEP_MS = 3 * 3_600_000;

export interface LocationConsentView {
  /** `none` : jamais demandée sur cet appareil ; `active` ; `withdrawn` ; `outdated` : accordée pour un ancien texte, à redemander. */
  status: "none" | "active" | "withdrawn" | "outdated";
  grantedAt: string | null;
  notice: { version: string; text: string; withdraw: string };
}

const noticeOf = () => ({ version: LOCATION_NOTICE_VERSION, text: LOCATION_NOTICE, withdraw: LOCATION_NOTICE_WITHDRAW });

export async function getLocationConsent(ctx: Ctx, session: SessionContext): Promise<LocationConsentView> {
  requireFamilyProfile(session);
  const row = await ctx.db.selectFrom("device_location_consents").select(["granted_at", "withdrawn_at", "notice_version"]).where("device_id", "=", session.device.id).executeTakeFirst();
  if (!row) return { status: "none", grantedAt: null, notice: noticeOf() };
  const status = row.withdrawn_at ? "withdrawn" : row.notice_version === LOCATION_NOTICE_VERSION ? "active" : "outdated";
  return { status, grantedAt: status === "active" || status === "outdated" ? row.granted_at.toISOString() : null, notice: noticeOf() };
}

/**
 * Enregistre l'accord de cet appareil pour la version courante du texte (la base l'inscrit au journal). Sans effet quand il est déjà accordé pour cette version.
 * `noticeVersion` est celle que l'écran a montrée : si le texte a changé entre-temps, l'accord est refusé et l'écran se recharge.
 */
export async function grantLocationConsent(ctx: Ctx, session: SessionContext, noticeVersion: string): Promise<LocationConsentView> {
  requireFamilyProfile(session);
  if (noticeVersion !== LOCATION_NOTICE_VERSION) throw new Rejection("notice_changed", "Le texte d'information a changé : relisez-le avant d'autoriser.", 409);
  const current = await getLocationConsent(ctx, session);
  if (current.status !== "active") {
    await sql`
      insert into device_location_consents (device_id, notice_version) values (${session.device.id}::uuid, ${LOCATION_NOTICE_VERSION})
      on conflict (device_id) do update set withdrawn_at = null, granted_at = now(), notice_version = excluded.notice_version`.execute(ctx.db);
  }
  return getLocationConsent(ctx, session);
}

/** Retire l'accord de cet appareil : la dernière position est effacée aussitôt (trigger) et le retrait est inscrit au journal. */
export async function withdrawLocationConsent(ctx: Ctx, session: SessionContext): Promise<LocationConsentView> {
  requireFamilyProfile(session);
  await ctx.db.updateTable("device_location_consents").set({ withdrawn_at: sql<Date>`now()` }).where("device_id", "=", session.device.id).where("withdrawn_at", "is", null).execute();
  return getLocationConsent(ctx, session);
}

/**
 * Garde la dernière position connue de cet appareil (une ligne, remplacée à chaque lecture). Refusée sans accord actif pour le texte courant. Conservée 3 heures au plus,
 * et jamais au-delà de la fin du RDV suivi (`eventId`, un RDV que ce profil voit). Retourne faux quand rien n'est gardé parce que le RDV suivi est terminé.
 */
export async function saveLastPosition(ctx: Ctx, session: SessionContext, point: unknown, options: { eventId?: string } = {}): Promise<boolean> {
  requireFamilyProfile(session);
  const place: PlacePoint | null = parsePoint(point);
  if (!place) throw new Rejection("invalid_position", "La position reçue est invalide.", 422);
  if ((await getLocationConsent(ctx, session)).status !== "active") throw new Rejection("no_location_consent", "La position n'est pas autorisée sur cet appareil.", 403);
  let expires = new Date(ctx.now.getTime() + KEEP_MS);
  if (options.eventId) {
    const event = await sql<{ ends_at: Date }>`select ends_at from family_events_visible_to(${session.user.id}::uuid) where id = ${options.eventId}::uuid`.execute(ctx.db);
    if (!event.rows[0]) throw new Rejection("not_found", "Ce rendez-vous n'existe plus ou ne vous est pas accessible.", 404);
    if (event.rows[0].ends_at < expires) expires = event.rows[0].ends_at;
  }
  if (expires <= ctx.now) return false;
  await ctx.db
    .insertInto("device_last_positions")
    .values({ device_id: session.device.id, position_encrypted: sealPoint(place), captured_at: ctx.now, expires_at: expires })
    .onConflict((oc) => oc.column("device_id").doUpdateSet({ position_encrypted: sealPoint(place), captured_at: ctx.now, expires_at: expires }))
    .execute();
  return true;
}

/** La dernière position de cet appareil, si elle n'est pas échue et si l'accord est actif (règle de la base). Réservée au serveur : aucune route ne l'expose. */
export async function readLastPosition(ctx: Ctx, session: SessionContext): Promise<PlacePoint | null> {
  requireFamilyProfile(session);
  const { rows } = await sql<{ p: Buffer | null }>`select device_last_position(${session.device.id}::uuid) as p`.execute(ctx.db);
  return rows[0]?.p ? parsePoint(JSON.parse(open(rows[0].p))) : null;
}
