import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { courseError } from "@/server/courses/household/settings";
import { menuFromTicket } from "@/server/courses/tickets/service";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Plats à partir de ce que le ticket a permis d'acheter, avec ce qui reste à acheter (US-160). `?ticket=<identifiant>`. */
export const GET = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile({ passive: true });
  const id = new URL(request.url).searchParams.get("ticket") ?? "";
  if (!/^[0-9a-f-]{36}$/.test(id)) throw courseError("invalid_ticket", "Ticket non valide.", 422);
  return NextResponse.json({ ideas: await menuFromTicket(ctx, session, id) });
});
