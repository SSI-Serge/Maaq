import { NextResponse } from "next/server";
import { getAnticipation } from "@/server/assistant/anticipation";
import { requireProfile } from "@/server/auth/http";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** La section « À anticiper » (US-102) : questions de la semaine, cartes de naissance, questionnaire de situation. Parents seulement. */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ anticipation: await getAnticipation(ctx, session) });
});
