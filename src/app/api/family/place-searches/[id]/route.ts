import { NextResponse } from "next/server";
import { z } from "zod";
import { placeSearchById } from "@/server/assistant/places";
import { requireProfile } from "@/server/auth/http";
import { handler, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** L'état d'une recherche « Sur place » et son résultat, pour la carte du tchat qui se met à jour pendant la recherche (US-112 RF4). Réservé aux profils qui voient le RDV. */
export const GET = handler(async (_request: Request, context: Context) => {
  const { session, ctx } = await requireProfile({ passive: true });
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) throw new Rejection("not_found", "Cette recherche n'existe plus.", 404);
  return NextResponse.json({ search: await placeSearchById(ctx, session, id) });
});
