import { NextResponse } from "next/server";
import { z } from "zod";
import { answerQuestion } from "@/server/assistant/anticipation";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({
  answer: z.enum(["done_or_planned", "todo", "remind_later"]),
  remindMonths: z.number().int().optional(),
  assigneeId: z.uuid().nullable().optional(),
});

/** Réponse à une question à trois choix (US-102 RF6) : atomique, sans double création de tâche ; la réponse d'un parent vaut pour la famille. */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) throw new Rejection("not_found", "Cette question n'existe plus.", 404);
  const body = await parseBody(request, schema);
  return NextResponse.json({ result: await answerQuestion(ctx, session, id, body) });
});
