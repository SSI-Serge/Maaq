import type { Kysely } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { loadCalendarEvent } from "@/server/assistant/calendar";
import { emotionError, partnerOf, requireCouple, translateEmotionError } from "./couple";

/**
 * Le cœur de remerciement (US-141). Un cœur se pose sur une tâche cochée par l'autre parent, ou sur un RDV confirmé, terminé et créé par l'autre parent (E-04, E-25). Réservé au
 * couple, sans notification, hors carnet de bord. Les gardes sont celles de la base (déclencheurs `appreciation_heart_*`) ; ici, la présentation et des messages clairs.
 */

export interface HeartView {
  /** Le profil peut poser (ou retirer) son cœur sur cet élément. */
  canGive: boolean;
  /** Le cœur est posé, par ce profil. */
  given: boolean;
  /** Prénom du partenaire qui a remercié ce profil pour son action (« Julien vous remercie »). */
  thanksFrom: string | null;
}

type Db = Kysely<DB>;

/** Cœurs des tâches d'une liste, pour le profil qui les lit. Une entrée seulement pour une tâche cochée par ce profil ou par son partenaire. */
export async function heartsOfTasks(db: Db, viewerId: string, rows: { id: string; status: string; done_by_member_id: string | null }[]): Promise<Map<string, HeartView>> {
  const views = new Map<string, HeartView>();
  const done = rows.filter((r) => r.status === "done" && r.done_by_member_id);
  if (!done.length) return views;
  const partner = await partnerOf(db, viewerId);
  if (!partner) return views;
  const memberIds = [...new Set(done.map((r) => r.done_by_member_id!))];
  const users = new Map((await db.selectFrom("family_members").select(["id", "user_id"]).where("id", "in", memberIds).execute()).map((m) => [m.id, m.user_id]));
  const ids = done.map((r) => r.id);
  const hearts = new Map((await db.selectFrom("appreciation_hearts").select(["task_id", "author_user_id"]).where("task_id", "in", ids).execute()).map((h) => [h.task_id!, h.author_user_id]));
  for (const r of done) {
    const doneBy = users.get(r.done_by_member_id!) ?? null;
    const author = hearts.get(r.id) ?? null;
    if (doneBy === partner.id) views.set(r.id, { canGive: true, given: author === viewerId, thanksFrom: null });
    else if (doneBy === viewerId && author === partner.id) views.set(r.id, { canGive: false, given: false, thanksFrom: partner.firstName });
  }
  return views;
}

/** Cœur d'un RDV pour le profil qui le lit ; vide tant que le RDV n'est pas confirmé et terminé, ou s'il n'a pas été créé par l'un des deux parents. */
export async function heartOfEvent(db: Db, viewerId: string, event: { id: string; status: string; endsAt: Date; createdByUserId: string | null }, now: Date): Promise<HeartView | null> {
  if (event.status !== "confirmed" || event.endsAt > now || !event.createdByUserId) return null;
  const partner = await partnerOf(db, viewerId);
  if (!partner) return null;
  const heart = await db.selectFrom("appreciation_hearts").select("author_user_id").where("event_id", "=", event.id).executeTakeFirst();
  if (event.createdByUserId === partner.id) return { canGive: true, given: heart?.author_user_id === viewerId, thanksFrom: null };
  if (event.createdByUserId === viewerId && heart?.author_user_id === partner.id) return { canGive: false, given: false, thanksFrom: partner.firstName };
  return null;
}

export type HeartTarget = { kind: "task" | "event"; id: string };

/** Pose ou retire le cœur de ce profil sur une tâche ou un RDV. Un second appui retire (US-141 RF2). Idempotent. */
export async function setHeart(ctx: Ctx, session: SessionContext, target: HeartTarget, on: boolean): Promise<HeartView> {
  const couple = await requireCouple(ctx, session);
  const notFound = () => emotionError("not_found", "Cet élément n'existe plus ou ne vous est pas accessible.", 404);
  if (target.kind === "task") {
    const task = await ctx.db.selectFrom("family_tasks").select(["id", "status", "done_by_member_id"]).where("id", "=", target.id).where("account_id", "=", couple.accountId).executeTakeFirst();
    if (!task) throw notFound();
    const view = (await heartsOfTasks(ctx.db, couple.userId, [task])).get(task.id);
    if (!view?.canGive) throw emotionError("heart_not_allowed", "Vous pouvez remercier une tâche faite par votre partenaire, pas la vôtre.", 409);
    try {
      if (on) await ctx.db.insertInto("appreciation_hearts").values({ account_id: couple.accountId, task_id: task.id, author_user_id: couple.userId }).onConflict((oc) => oc.column("task_id").where("task_id", "is not", null).doNothing()).execute();
      else await ctx.db.deleteFrom("appreciation_hearts").where("task_id", "=", task.id).where("author_user_id", "=", couple.userId).execute();
    } catch (error) {
      throw translateEmotionError(error);
    }
    return (await heartsOfTasks(ctx.db, couple.userId, [task])).get(task.id)!;
  }
  const event = await loadCalendarEvent(ctx.db, couple.accountId, target.id);
  if (!event) throw notFound();
  const current = await heartOfEvent(ctx.db, couple.userId, event, ctx.now);
  if (!current?.canGive) throw emotionError("heart_not_allowed", "Vous pouvez remercier un RDV passé, confirmé et créé par votre partenaire.", 409);
  try {
    if (on) await ctx.db.insertInto("appreciation_hearts").values({ account_id: couple.accountId, event_id: event.id, author_user_id: couple.userId }).onConflict((oc) => oc.column("event_id").where("event_id", "is not", null).doNothing()).execute();
    else await ctx.db.deleteFrom("appreciation_hearts").where("event_id", "=", event.id).where("author_user_id", "=", couple.userId).execute();
  } catch (error) {
    throw translateEmotionError(error);
  }
  return (await heartOfEvent(ctx.db, couple.userId, event, ctx.now))!;
}
