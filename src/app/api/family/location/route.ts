import { NextResponse } from "next/server";
import { z } from "zod";
import { saveLastPosition } from "@/server/assistant/location-consent";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  eventId: z.uuid().optional(),
});

/**
 * Garde la dernière position de cet appareil, lue par l'écran « Suivi du trajet » ou à l'ouverture de l'application (US-107 RF11, RF12). Refusée (403) sans autorisation active.
 * Il n'existe aucune route de lecture : la position n'est jamais montrée, pas même à son propriétaire, et jamais à un autre profil.
 */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const { eventId, ...point } = await parseBody(request, schema);
  return NextResponse.json({ saved: await saveLastPosition(ctx, session, point, { eventId }) });
});
