import { messenger } from "@/server/adapters/messaging";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { processChatErasure } from "@/server/auth/service";
import type { DeviceKind } from "@/server/auth/format";
import { formatDateTime } from "@/server/auth/format";
import { Rejection } from "@/server/http";

/** Appareils connectés et révocation (US-53). */

export interface DeviceView {
  id: string;
  type: DeviceKind;
  browser: string | null;
  ownerFirstName: string;
  firstConnectedAt: string;
  lastActivityAt: string;
  /** L'appareil en cours d'utilisation (US-53 RF1). */
  current: boolean;
  /** Activité dans les 5 dernières minutes : « Actif maintenant ». */
  active: boolean;
}

export interface DevicesView {
  mine: DeviceView[];
  guests: { guestId: string; firstName: string; devices: DeviceView[] }[];
}

const TYPE_NAME: Record<DeviceKind, string> = { iphone: "iPhone", android: "Android", desktop: "Ordinateur", other: "Appareil" };

/** « iPhone de Camille » : type de l'appareil et propriétaire, comme sur la maquette. */
export function deviceName(device: Pick<DeviceView, "type" | "ownerFirstName">): string {
  return `${TYPE_NAME[device.type]} de ${device.ownerFirstName}`;
}

async function devicesOf(ctx: Ctx, userIds: string[], currentId: string | null) {
  if (userIds.length === 0) return [];
  const rows = await ctx.db
    .selectFrom("devices as d")
    .innerJoin("users as u", "u.id", "d.user_id")
    .select(["d.id", "d.user_id", "d.device_type", "d.browser", "d.first_connected_at", "d.last_activity_at", "u.first_name"])
    .where("d.user_id", "in", userIds)
    .where("d.revoked_at", "is", null)
    .orderBy("d.last_activity_at", "desc")
    .execute();
  return rows.map((d) => ({
    userId: d.user_id,
    view: {
      id: d.id,
      type: d.device_type,
      browser: d.browser,
      ownerFirstName: d.first_name,
      firstConnectedAt: new Date(d.first_connected_at).toISOString(),
      lastActivityAt: new Date(d.last_activity_at).toISOString(),
      current: d.id === currentId,
      active: d.id === currentId || ctx.now.getTime() - new Date(d.last_activity_at).getTime() < 5 * 60_000,
    } satisfies DeviceView,
  }));
}

/** Appareils du compte : les miens et ceux de mes invités, réservé à l'utilisateur principal (RF1, RF6). */
export async function listDevices(ctx: Ctx, session: SessionContext): Promise<DevicesView> {
  if (session.user.role !== "primary_user" || !session.user.accountId) {
    throw new Rejection("forbidden", "Seul l'utilisateur principal gère les appareils.", 403);
  }
  const guests = await ctx.db
    .selectFrom("users")
    .select(["id", "first_name"])
    .where("account_id", "=", session.user.accountId)
    .where("role", "=", "guest")
    .where("status", "in", ["pending_activation", "active"])
    .orderBy("created_at")
    .execute();
  const all = await devicesOf(ctx, [session.user.id, ...guests.map((g) => g.id)], session.device.id);
  return {
    mine: all.filter((d) => d.userId === session.user.id).map((d) => d.view),
    guests: guests
      .map((g) => ({ guestId: g.id, firstName: g.first_name, devices: all.filter((d) => d.userId === g.id).map((d) => d.view) }))
      .filter((g) => g.devices.length > 0),
  };
}

/** Appareils d'un compte, pour l'administrateur qui le consulte (RF7). */
export async function listAccountDevices(ctx: Ctx, accountId: string): Promise<{ userId: string; firstName: string; lastName: string; role: "primary_user" | "guest"; devices: DeviceView[] }[]> {
  const people = await ctx.db
    .selectFrom("users")
    .select(["id", "first_name", "last_name", "role"])
    .where("account_id", "=", accountId)
    .where("status", "in", ["pending_activation", "active", "grace_period"])
    .orderBy("role")
    .orderBy("created_at")
    .execute();
  const all = await devicesOf(ctx, people.map((p) => p.id), null);
  return people.map((p) => ({
    userId: p.id,
    firstName: p.first_name,
    lastName: p.last_name,
    role: p.role as "primary_user" | "guest",
    devices: all.filter((d) => d.userId === p.id).map((d) => d.view),
  }));
}

export interface RevokeActor {
  userId: string;
  role: "primary_user" | "admin";
  accountId: string | null;
  /** Appareil en cours d'utilisation par l'auteur, pour reconnaître la révocation de « Cet appareil ». */
  currentDeviceId: string | null;
}

export function actorOf(session: SessionContext): RevokeActor {
  if (session.user.role === "guest") throw new Rejection("forbidden", "Seul l'utilisateur principal gère les appareils.", 403);
  return { userId: session.user.id, role: session.user.role, accountId: session.user.accountId, currentDeviceId: session.device.id };
}

/**
 * Révoque un appareil : ses sessions sont fermées aussitôt, il devra repasser par la vérification
 * d'identité (RF3, RT1). Le profil concerné est prévenu par email (RF5), l'événement est journalisé avec
 * son auteur (RT2), et l'historique de ses tchats est effacé comme à une déconnexion (RF4).
 */
export async function revokeDevice(ctx: Ctx, actor: RevokeActor, deviceId: string): Promise<{ revokedCurrent: boolean }> {
  const target = await ctx.db
    .selectFrom("devices as d")
    .innerJoin("users as u", "u.id", "d.user_id")
    .select(["d.id", "d.device_type", "d.user_id", "u.account_id", "u.role", "u.email", "u.first_name"])
    .where("d.id", "=", deviceId)
    .where("d.revoked_at", "is", null)
    .executeTakeFirst();
  if (!target) throw new Rejection("not_found", "Cet appareil n'existe plus ou a déjà été révoqué.", 404);

  const allowed =
    target.role !== "admin" &&
    (actor.role === "admin" || target.user_id === actor.userId || (target.role === "guest" && target.account_id !== null && target.account_id === actor.accountId));
  if (!allowed) throw new Rejection("forbidden", "Vous ne pouvez pas révoquer cet appareil.", 403);

  const erasure = await ctx.db.transaction().execute(async (trx) => {
    const revoked = await trx
      .updateTable("devices")
      .set({ revoked_at: ctx.now, revoked_by_user_id: actor.userId, updated_at: ctx.now })
      .where("id", "=", deviceId)
      .where("revoked_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    if (!revoked) return null; // révoqué entre-temps (double envoi)
    await trx.updateTable("sessions").set({ revoked_at: ctx.now, revoked_reason: "device_revoked" }).where("device_id", "=", deviceId).where("revoked_at", "is", null).execute();
    await trx
      .insertInto("security_events")
      .values({ user_id: target.user_id, actor_user_id: actor.userId, device_id: deviceId, event_type: "device_revoked", occurred_at: ctx.now, details: JSON.stringify({ device_type: target.device_type }) })
      .execute();
    return trx.insertInto("chat_erasure_requests").values({ user_id: target.user_id, reason: "device_revoked", requested_at: ctx.now }).returning("id").executeTakeFirstOrThrow();
  });
  if (!erasure) return { revokedCurrent: deviceId === actor.currentDeviceId };

  await processChatErasure(ctx, erasure.id);
  try {
    await messenger().sendEmail({
      to: target.email,
      subject: "Un appareil a perdu l'accès à MAAQ",
      text:
        `Bonjour ${target.first_name},\n\n` +
        `L'accès d'un de vos appareils (${TYPE_NAME[target.device_type]}) à MAAQ a été révoqué le ${formatDateTime(ctx.now, "Europe/Paris")}.\n` +
        `Pour vous reconnecter depuis cet appareil, vous devrez de nouveau vérifier votre identité.\n\n` +
        `Si vous n'êtes pas à l'origine de cette demande, contactez le support depuis les Réglages.\n\nL'équipe MAAQ`,
    });
  } catch (error) {
    console.error("Révocation enregistrée mais email non envoyé :", error);
  }
  return { revokedCurrent: deviceId === actor.currentDeviceId };
}
