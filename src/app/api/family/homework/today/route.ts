import { NextResponse } from "next/server";
import { homeworkToday } from "@/server/assistant/homework/weeks";
import { requireProfile } from "@/server/auth/http";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Planning du jour de la tâche « Préparer les devoirs » (US-119 RF1) : chaque enfant pour un parent, le sien seul pour le profil d'un enfant (D73 S-40). */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ today: await homeworkToday(ctx, session) });
});
