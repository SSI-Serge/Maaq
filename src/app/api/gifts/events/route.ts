import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { createEvent, eventInputSchema } from "@/server/gifts/calendar";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

/** Ajoute une occasion (Noël, fête, anniversaire de mariage…), chaque année ou à une date unique. */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await createEvent(ctx, session, await parseBody(request, eventInputSchema)), { status: 201 });
});
