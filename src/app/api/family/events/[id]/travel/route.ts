import { NextResponse } from "next/server";
import { z } from "zod";
import { refreshTravel } from "@/server/assistant/travel";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { eventIdOf } from "../../params";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const schema = z.object({ position: z.object({ lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }).optional() });

/**
 * Écran « Suivi du trajet » (US-107 RF6) : recalcule le trajet avec le trafic depuis la position que l'écran vient de lire, toutes les 3 minutes tant qu'il est ouvert. Répond avec l'heure
 * de départ conseillée, la durée et « Vous êtes arrivé » à moins de 5 minutes du lieu. Service muet : la dernière estimation, marquée `stale`.
 */
export const POST = handler(async (request: Request, context: Context) => {
  const { session, ctx } = await requireProfile();
  const { position } = await parseBody(request, schema);
  return NextResponse.json({ travel: await refreshTravel(ctx, session, await eventIdOf(context), { position }) });
});
