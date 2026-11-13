import { NextResponse } from "next/server";
import { getChoresSetting } from "@/server/assistant/chores";
import { requireProfile } from "@/server/auth/http";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Tâches ménagères guidées du foyer (US-181) : lisibles par tout profil de la famille, modifiables par les deux parents. */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ setting: await getChoresSetting(ctx, session) });
});
