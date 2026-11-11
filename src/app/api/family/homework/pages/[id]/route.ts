import { NextResponse } from "next/server";
import { deleteExercisePage, getExercisePage } from "@/server/assistant/homework/pages";
import { requireProfile } from "@/server/auth/http";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Une page d'exercices (US-180 RF5, RF7) : l'énoncé ; la fiche réponse et le barème pour un parent seulement (S-36). */
export const GET = handler(async (_request: Request, context: Context) => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ page: await getExercisePage(ctx, session, (await context.params).id) });
});

/** Un parent supprime une page, après confirmation à l'écran (RF7). */
export const DELETE = handler(async (_request: Request, context: Context) => {
  const { session, ctx } = await requireProfile();
  await deleteExercisePage(ctx, session, (await context.params).id);
  return NextResponse.json({ deleted: true });
});
