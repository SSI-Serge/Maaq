import { sql } from "kysely";
import { createConfirmedEvent, type EventView } from "@/server/assistant/events";
import { open, openOptional, seal, sealOptional } from "@/server/assistant/fields";
import { asProfile } from "@/server/assistant/outings/profile";
import { notifyAfterConfirmation } from "@/server/assistant/notices";
import { dispatch, recipientsOf } from "@/server/assistant/task-notices";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { describeError } from "@/server/safe-log";
import { emotionError, requireCouple, translateEmotionError } from "./couple";

/**
 * « Nos envies » (US-147 à US-151) : une liste simple, partagée par le couple, sans date, sans statut ni rappel. Titre et description chiffrés. Jamais envoyé à l'agent, jamais ajouté par le
 * tchat (E-08), hors calendrier, tâches et carnet de bord (E-09). Le plafond (50, réglable dans la console) et l'accès sont aussi tenus par la base.
 */

export const MAX_WISH_TITLE = 60;
export const MAX_WISH_DESCRIPTION = 200;
export const HORIZONS = { soon: "Bientôt", this_year: "Cette année", someday: "Un jour" } as const;
export type Horizon = keyof typeof HORIZONS;
export const WISHES_URL = "/assistant/envies";
/** Délai pendant lequel « Annuler » remet une envie retirée (US-150 RF2) ; la base la supprime ensuite (`purge_removed_wishes`). */
export const UNDO_WINDOW_MS = 10_000;
/** Un peu plus que le délai de l'écran, pour une annulation qui arrive tard à cause du réseau. */
const UNDO_TOLERANCE_MS = 5_000;

export interface WishView {
  id: string;
  title: string;
  description: string | null;
  horizon: Horizon | null;
  horizonLabel: string | null;
  /** Prénom de qui l'a ajoutée. */
  by: string | null;
  mine: boolean;
  createdAt: string;
}

export interface WishList {
  wishes: WishView[];
  max: number;
  /** Prénom du partenaire. */
  partner: string;
}

export interface WishInput {
  title?: unknown;
  description?: unknown;
  horizon?: unknown;
}

function checkInput(input: WishInput, existing?: { title: string }): { title: string; description: string | null; horizon: Horizon | null } {
  const title = (typeof input.title === "string" ? input.title : (existing?.title ?? "")).trim();
  if (!title) throw emotionError("invalid_title", "Donnez un titre à votre envie.", 422);
  if ([...title].length > MAX_WISH_TITLE) throw emotionError("invalid_title", `Le titre fait ${MAX_WISH_TITLE} caractères au plus.`, 422);
  const description = typeof input.description === "string" ? input.description.trim() : "";
  if ([...description].length > MAX_WISH_DESCRIPTION) throw emotionError("invalid_description", `La description fait ${MAX_WISH_DESCRIPTION} caractères au plus.`, 422);
  const horizon = input.horizon === undefined || input.horizon === null || input.horizon === "" ? null : input.horizon;
  if (horizon !== null && !(typeof horizon === "string" && horizon in HORIZONS)) throw emotionError("invalid_horizon", "Cet horizon n'existe pas.", 422);
  return { title, description: description || null, horizon: horizon as Horizon | null };
}

interface WishRow {
  id: string;
  title: Buffer;
  description: Buffer | null;
  /** Valeur lue en base (texte) : l'application ne l'écrit que parmi les horizons connus. */
  horizon: string | null;
  created_by_user_id: string | null;
  created_at: Date;
}

async function maxWishes(ctx: Ctx): Promise<number> {
  const row = await ctx.db.selectFrom("platform_settings").select("value_text").where("setting_key", "=", "wish_max_per_family").executeTakeFirst();
  const n = Number(row?.value_text);
  return Number.isInteger(n) && n > 0 ? n : 50;
}

export async function listWishes(ctx: Ctx, session: SessionContext): Promise<WishList> {
  const couple = await requireCouple(ctx, session);
  const rows = await asProfile(ctx.db, couple.userId, (trx) =>
    trx.selectFrom("couple_wishes").select(["id", "title", "description", "horizon", "created_by_user_id", "created_at"]).where("account_id", "=", couple.accountId).where("removed_at", "is", null).orderBy("created_at", "desc").orderBy("id").execute(),
  );
  const names = new Map((await ctx.db.selectFrom("users").select(["id", "first_name"]).where("account_id", "=", couple.accountId).execute()).map((u) => [u.id, u.first_name]));
  return { wishes: rows.map((r) => toView(r, couple.userId, names)), max: await maxWishes(ctx), partner: couple.partner.firstName };
}

function toView(r: WishRow, userId: string, names: Map<string, string>): WishView {
  const horizon = r.horizon !== null && r.horizon in HORIZONS ? (r.horizon as Horizon) : null;
  return {
    id: r.id, title: open(r.title), description: openOptional(r.description), horizon, horizonLabel: horizon ? HORIZONS[horizon] : null,
    by: r.created_by_user_id ? (names.get(r.created_by_user_id) ?? null) : null, mine: r.created_by_user_id === userId, createdAt: r.created_at.toISOString(),
  };
}

async function loadWish(ctx: Ctx, userId: string, accountId: string, id: string): Promise<{ row: WishRow; removed_at: Date | null }> {
  const found = await asProfile(ctx.db, userId, (trx) =>
    trx.selectFrom("couple_wishes").select(["id", "title", "description", "horizon", "created_by_user_id", "created_at", "removed_at"]).where("id", "=", id).where("account_id", "=", accountId).executeTakeFirst(),
  );
  if (!found) throw emotionError("not_found", "Cette envie n'existe plus.", 404);
  return { row: found, removed_at: found.removed_at };
}

/** Ajoute une envie et prévient l'autre parent, sans le titre (US-148, US-149). */
export async function addWish(ctx: Ctx, session: SessionContext, input: WishInput): Promise<WishView> {
  const couple = await requireCouple(ctx, session);
  const fields = checkInput(input);
  let row: WishRow;
  try {
    row = await asProfile(ctx.db, couple.userId, (trx) =>
      trx
        .insertInto("couple_wishes")
        .values({ account_id: couple.accountId, title: seal(fields.title), description: sealOptional(fields.description), horizon: fields.horizon, created_by_user_id: couple.userId, created_at: ctx.now, updated_at: ctx.now })
        .returning(["id", "title", "description", "horizon", "created_by_user_id", "created_at"])
        .executeTakeFirstOrThrow(),
    );
  } catch (error) {
    throw translateEmotionError(error);
  }
  await notifyWishAdded(ctx, couple.accountId, row.id, couple.partner.id);
  return toView(row, couple.userId, new Map([[couple.userId, session.user.firstName]]));
}

/** L'un ou l'autre parent modifie une envie (US-148 RF4) ; personne n'est prévenu (US-149 RF3). */
export async function updateWish(ctx: Ctx, session: SessionContext, id: string, input: WishInput): Promise<WishView> {
  const couple = await requireCouple(ctx, session);
  const { row: current, removed_at } = await loadWish(ctx, couple.userId, couple.accountId, id);
  if (removed_at) throw emotionError("not_found", "Cette envie n'existe plus.", 404);
  const fields = checkInput({ title: input.title ?? open(current.title), description: input.description === undefined ? openOptional(current.description) : input.description, horizon: input.horizon === undefined ? current.horizon : input.horizon });
  const row = await asProfile(ctx.db, couple.userId, (trx) =>
    trx
      .updateTable("couple_wishes")
      .set({ title: seal(fields.title), description: sealOptional(fields.description), horizon: fields.horizon, updated_at: ctx.now })
      .where("id", "=", id)
      .where("account_id", "=", couple.accountId)
      .returning(["id", "title", "description", "horizon", "created_by_user_id", "created_at"])
      .executeTakeFirstOrThrow(),
  );
  const names = new Map((await ctx.db.selectFrom("users").select(["id", "first_name"]).where("account_id", "=", couple.accountId).execute()).map((u) => [u.id, u.first_name]));
  return toView(row, couple.userId, names);
}

/** « Retirer » (US-150) : l'envie disparaît aussitôt ; elle peut revenir pendant 10 secondes, puis la base la supprime pour de bon. */
export async function removeWish(ctx: Ctx, session: SessionContext, id: string): Promise<{ id: string; undoUntil: string }> {
  const couple = await requireCouple(ctx, session);
  const { removed_at } = await loadWish(ctx, couple.userId, couple.accountId, id);
  if (!removed_at) await asProfile(ctx.db, couple.userId, (trx) => trx.updateTable("couple_wishes").set({ removed_at: ctx.now, updated_at: ctx.now }).where("id", "=", id).where("account_id", "=", couple.accountId).execute());
  return { id, undoUntil: new Date((removed_at ?? ctx.now).getTime() + UNDO_WINDOW_MS).toISOString() };
}

/** « Annuler » : remet l'envie retirée, tant qu'elle n'est pas supprimée. */
export async function restoreWish(ctx: Ctx, session: SessionContext, id: string): Promise<WishView> {
  const couple = await requireCouple(ctx, session);
  const { row, removed_at } = await loadWish(ctx, couple.userId, couple.accountId, id);
  if (removed_at) {
    if (ctx.now.getTime() - removed_at.getTime() > UNDO_WINDOW_MS + UNDO_TOLERANCE_MS) throw emotionError("undo_expired", "Cette envie a déjà été supprimée.", 409);
    try {
      await asProfile(ctx.db, couple.userId, (trx) => trx.updateTable("couple_wishes").set({ removed_at: null, updated_at: ctx.now }).where("id", "=", id).where("account_id", "=", couple.accountId).execute());
    } catch (error) {
      throw translateEmotionError(error);
    }
  }
  const names = new Map((await ctx.db.selectFrom("users").select(["id", "first_name"]).where("account_id", "=", couple.accountId).execute()).map((u) => [u.id, u.first_name]));
  return toView(row, couple.userId, names);
}

// ---------------------------------------------------------------------------------------------------------------------------
// Notification « [Prénom] a ajouté une envie à deux. » (US-149)
// ---------------------------------------------------------------------------------------------------------------------------

export const wishAddedBody = (firstName: string) => `${firstName} a ajouté une envie à deux.`;

/**
 * Une seule notification par envie, au partenaire, sans le titre (écran verrouillé) : notification sur le téléphone, e-mail à défaut, rien la nuit (reportée à 8 h, comme les autres). Une
 * erreur d'envoi n'empêche jamais d'ajouter l'envie.
 */
async function notifyWishAdded(ctx: Ctx, accountId: string, wishId: string, partnerId: string): Promise<void> {
  try {
    const due = await sql<{ at: Date }>`select shift_to_morning(${accountId}::uuid, ${ctx.now}) as at`.execute(ctx.db);
    const dueAt = new Date(due.rows[0]!.at);
    await ctx.db
      .insertInto("scheduled_notifications")
      .values({ kind: "wish_added", wish_id: wishId, due_at: dueAt, deadline_at: new Date(dueAt.getTime() + 24 * 3_600_000), recipient_user_id: partnerId, status: "scheduled", attempts: 1 })
      .onConflict((oc) => oc.columns(["wish_id", "recipient_user_id"]).where(sql<boolean>`wish_id is not null`).doNothing())
      .execute();
    if (dueAt <= ctx.now) await sendWishNotices(ctx, { wishId });
  } catch (error) {
    console.error(`Notification d'envie non réservée : ${describeError(error)}`);
  }
}

/** Envoie les notifications d'envie dues (immédiates, ou reportées à 8 h après la nuit). Sans danger à relancer. */
export async function sendWishNotices(ctx: Ctx, options: { wishId?: string } = {}): Promise<{ sent: number; failed: number }> {
  const totals = { sent: 0, failed: 0 };
  const due = await ctx.db
    .selectFrom("scheduled_notifications as n")
    .innerJoin("couple_wishes as w", "w.id", "n.wish_id")
    .select(["n.id", "n.wish_id", "n.recipient_user_id", "n.due_at", "w.account_id", "w.created_by_user_id", "w.removed_at"])
    .where("n.kind", "=", "wish_added")
    .where("n.status", "=", "scheduled")
    .where("n.due_at", "<=", ctx.now)
    .$if(Boolean(options.wishId), (qb) => qb.where("n.wish_id", "=", options.wishId!))
    .limit(200)
    .execute();
  for (const n of due) {
    try {
      const recipient = (await recipientsOf(ctx.db, n.account_id)).find((r) => r.id === n.recipient_user_id);
      const by = n.created_by_user_id ? await ctx.db.selectFrom("users").select("first_name").where("id", "=", n.created_by_user_id).executeTakeFirst() : null;
      if (!recipient || !by || n.removed_at) {
        await ctx.db.updateTable("scheduled_notifications").set({ status: "cancelled" }).where("id", "=", n.id).execute();
        continue;
      }
      const body = wishAddedBody(by.first_name);
      const out = await dispatch(ctx, n.account_id, recipient, { kind: "wish_added", userId: recipient.id, wishId: n.wish_id!, dueAt: new Date(n.due_at) }, { body, url: `${WISHES_URL}#${n.wish_id}`, tag: `wish-${n.wish_id}`, subject: body, lines: [body] }, true);
      if (out === "sent") totals.sent += 1;
      else if (out === "failed") totals.failed += 1;
    } catch (error) {
      console.error(`Notification d'envie non envoyée : ${describeError(error)}`);
      totals.failed += 1;
    }
  }
  return totals;
}

// ---------------------------------------------------------------------------------------------------------------------------
// « En faire un RDV » (US-151)
// ---------------------------------------------------------------------------------------------------------------------------

export interface WishForm {
  title: string;
  notes: string | null;
  place: string;
  type: "family";
  memberId: string | null;
  members: { id: string; firstName: string }[];
  /** Ni date suggérée ni avertissement de visibilité : un RDV ordinaire suit les règles habituelles (RF3). */
  suggestedDate: string;
  visibleTo: string[];
  warning: string | null;
  help: string;
}

/** Formulaire de RDV prérempli : le titre de l'envie, sa description dans les notes ; la date et l'heure restent à choisir (RF1). */
export async function wishForm(ctx: Ctx, session: SessionContext, id: string): Promise<WishForm> {
  const couple = await requireCouple(ctx, session);
  const { row, removed_at } = await loadWish(ctx, couple.userId, couple.accountId, id);
  if (removed_at) throw emotionError("not_found", "Cette envie n'existe plus.", 404);
  const members = await ctx.db.selectFrom("family_members").select(["id", "first_name", "user_id"]).where("account_id", "=", couple.accountId).where("archived_at", "is", null).where("role", "in", ["parent", "child"]).orderBy("role").orderBy("alias_number").execute();
  return {
    title: open(row.title), notes: openOptional(row.description), place: "", type: "family", memberId: members.find((m) => m.user_id === couple.userId)?.id ?? null,
    members: members.map((m) => ({ id: m.id, firstName: m.first_name ?? "" })),
    suggestedDate: "", visibleTo: [], warning: null, help: "Choisissez la date et l'heure : l'envie disparaît de la liste quand le RDV est enregistré.",
  };
}

export interface WishEventInput {
  title: string;
  place: string | null;
  notes: string | null;
  type: "school" | "medical" | "work" | "family" | "personal" | "admin";
  memberIds: string[];
  start: string;
  end: string;
  allowConflict?: boolean;
}

/**
 * Enregistre le RDV issu d'une envie et fait disparaître l'envie dans la même transaction (RF2) : un double envoi ne laisse ni RDV en double ni envie fantôme. Le RDV est ordinaire
 * (source « tchat » dans la base) : l'autre parent est prévenu comme pour tout RDV ajouté (RF3). L'agent n'intervient pas (RF4).
 */
export async function addWishToCalendar(ctx: Ctx, session: SessionContext, id: string, input: WishEventInput): Promise<EventView> {
  const couple = await requireCouple(ctx, session);
  const { removed_at } = await loadWish(ctx, couple.userId, couple.accountId, id);
  if (removed_at) throw emotionError("not_found", "Cette envie n'existe plus.", 404);
  const event = await createConfirmedEvent(ctx, session, { ...input, source: "typed" }, async (trx) => {
    await sql`select set_config('app.user_id', ${couple.userId}, true)`.execute(trx);
    const done = await trx.deleteFrom("couple_wishes").where("id", "=", id).where("account_id", "=", couple.accountId).executeTakeFirst();
    if (Number(done.numDeletedRows) === 0) throw emotionError("not_found", "Cette envie n'existe plus.", 404);
  });
  await notifyAfterConfirmation(ctx, event.id);
  return event;
}
