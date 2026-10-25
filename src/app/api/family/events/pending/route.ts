import { NextResponse } from "next/server";
import { listPending } from "@/server/assistant/events";
import { requireProfile } from "@/server/auth/http";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Confirmations en attente de ce profil : rendez-vous provisoires à venir qu'il peut traiter (US-75, US-84). */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ events: await listPending(ctx, session) });
});
