import type { Ctx, SessionContext } from "@/server/auth/service";
import { assignTask, getTask, type TaskView } from "@/server/assistant/tasks";
import { cancelHeldAssignment, HANDOVER_HOLD_MS, releaseHeldAssignments } from "@/server/assistant/task-notices";
import { emotionError, requireCouple } from "./couple";

/**
 * « Confier à [prénom] » (US-146, E-02, E-18) : depuis le point, une tâche à soi est réassignée à l'autre parent d'un geste, avec l'assignation existante (US-96) : mêmes droits, mêmes
 * versions, sans acceptation ni refus. La notification « vous a confié » est retenue environ 15 secondes ; « Annuler » (10 secondes) remet la tâche et la fait disparaître.
 */

export const UNDO_MS = 10_000;

export interface HandOverResult {
  task: TaskView;
  /** Prénom de l'autre parent. */
  to: string;
  /** Fin du délai d'annulation. */
  undoUntil: string;
}

async function memberOf(ctx: Ctx, accountId: string, userId: string): Promise<string | null> {
  return (await ctx.db.selectFrom("family_members").select("id").where("account_id", "=", accountId).where("user_id", "=", userId).where("archived_at", "is", null).executeTakeFirst())?.id ?? null;
}

export async function handOverTask(ctx: Ctx, session: SessionContext, taskId: string, version?: number): Promise<HandOverResult> {
  const couple = await requireCouple(ctx, session);
  const mine = await memberOf(ctx, couple.accountId, couple.userId);
  const theirs = await memberOf(ctx, couple.accountId, couple.partner.id);
  if (!mine || !theirs) throw emotionError("forbidden", "Cette fonction est réservée aux deux parents du couple.", 403);
  const task = await getTask(ctx, session, taskId);
  if (task.status !== "todo") throw emotionError("task_settled", "Cette tâche n'est plus à faire.", 409);
  if (task.assignee?.id !== mine) throw emotionError("not_yours", "Seule une tâche qui vous est assignée peut être confiée.", 409);
  const moved = await assignTask(ctx, session, taskId, theirs, { expectedVersion: version, holdNotice: true });
  return { task: moved, to: couple.partner.firstName, undoUntil: new Date(ctx.now.getTime() + UNDO_MS).toISOString() };
}

/** « Annuler » : la tâche revient à celui qui l'avait confiée, et la notification retenue n'est jamais envoyée. */
export async function undoHandOver(ctx: Ctx, session: SessionContext, taskId: string, version?: number): Promise<TaskView> {
  const couple = await requireCouple(ctx, session);
  const mine = await memberOf(ctx, couple.accountId, couple.userId);
  const theirs = await memberOf(ctx, couple.accountId, couple.partner.id);
  if (!mine || !theirs) throw emotionError("forbidden", "Cette fonction est réservée aux deux parents du couple.", 403);
  const task = await getTask(ctx, session, taskId);
  if (task.status !== "todo" || task.assignee?.id !== theirs) throw emotionError("not_handed", "Cette tâche n'a pas été confiée à votre partenaire.", 409);
  const back = await assignTask(ctx, session, taskId, mine, { expectedVersion: version });
  await cancelHeldAssignment(ctx, taskId);
  return back;
}

/** Fin du délai : envoie la notification retenue si l'on n'a pas annulé. Sans danger à relancer ; avant l'échéance, elle ne part pas. */
export async function releaseHandOver(ctx: Ctx, session: SessionContext, taskId: string): Promise<{ sent: number }> {
  await requireCouple(ctx, session);
  // La tâche est celle du foyer du profil : sans ce contrôle, un parent pouvait faire partir la notification retenue d'un autre foyer (revue de sécurité du 13/11/2026).
  await getTask(ctx, session, taskId);
  return { sent: await releaseHeldAssignments(ctx, { taskId }) };
}

export { HANDOVER_HOLD_MS };
