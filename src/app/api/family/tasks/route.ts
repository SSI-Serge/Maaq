import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody, Rejection } from "@/server/http";
import { mondayOf, shouldOfferHomework } from "@/server/assistant/homework/weeks";
import { createTask, listTasks, listTasksBetween } from "@/server/assistant/tasks";
import { repetitionSchema } from "./schemas";

export const dynamic = "force-dynamic";

const range = z.object({ from: z.iso.date(), to: z.iso.date() });

/**
 * Les tâches que ce profil a le droit de voir. Sans période : l'écran « Tâches » (en retard, aujourd'hui, à venir, faites ; `?mine=1` pour « Mes tâches », US-110 RF6).
 * Avec `from` et `to` : les tâches dont l'échéance tombe dans la période, pour la vue Jour et le nombre de tâches des vues Semaine et Mois (AT-5).
 */
export const GET = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile({ passive: true });
  const url = new URL(request.url);
  if (url.searchParams.has("from") || url.searchParams.has("to")) {
    const parsed = range.safeParse({ from: url.searchParams.get("from"), to: url.searchParams.get("to") });
    if (!parsed.success) throw new Rejection("invalid_range", "La période demandée est invalide.", 422);
    return NextResponse.json({ tasks: await listTasksBetween(ctx, session, parsed.data) });
  }
  return NextResponse.json({ lists: await listTasks(ctx, session, { mine: url.searchParams.get("mine") === "1" }) });
});

const schema = z.object({
  title: z.string().max(300),
  note: z.string().max(5000).nullable().optional(),
  due: z.string().max(10),
  dueTime: z.string().max(5).nullable().optional(),
  assigneeId: z.uuid().nullable().optional(),
  repetition: repetitionSchema.nullable().optional(),
});

/**
 * Crée une tâche seule ou récurrente (US-110 RF1, RF3). Quand le titre parle de devoirs et que l'aide Devoirs est activée sans semaine déjà préparée pour la semaine de l'échéance,
 * la réponse porte `homeworkOffer` : l'écran propose alors de préparer la semaine (US-119 RF1). La tâche est enregistrée dans tous les cas.
 */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  const task = await createTask(ctx, session, body);
  const offer = await shouldOfferHomework(ctx, session, { title: body.title, due: body.due }).catch(() => false);
  return NextResponse.json({ task, homeworkOffer: offer ? { weekStart: mondayOf(body.due) } : null }, { status: 201 });
});
