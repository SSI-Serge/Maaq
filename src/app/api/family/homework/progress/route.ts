import { NextResponse } from "next/server";
import { eraseHomeworkProgress } from "@/server/assistant/homework/settings";
import { requireProfile } from "@/server/auth/http";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** « Effacer les progrès de Devoirs » (US-118 RF5) : la confirmation est demandée par l'écran ; l'âge des devoirs de chaque enfant reste (D65). */
export const DELETE = handler(async () => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await eraseHomeworkProgress(ctx, session));
});
