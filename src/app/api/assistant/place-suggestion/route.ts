import { NextResponse, after } from "next/server";
import { z } from "zod";
import { answerPlaceSuggestion, runPlaceSearch } from "@/server/assistant/places";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { describeError } from "@/server/safe-log";

export const dynamic = "force-dynamic";

const schema = z.object({ eventId: z.uuid(), answer: z.enum(["accepted", "declined"]) });

/**
 * Réponse à « Voulez-vous que je cherche où se garer et où manger près de [lieu] ? » (US-112 RF3) : « Oui » lance la recherche aussitôt en arrière-plan, « Non, merci » est mémorisé
 * (la suggestion n'est jamais répétée) et l'assistant répond dans le tchat. Une seule réponse par suggestion.
 */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const { eventId, answer } = await parseBody(request, schema);
  const { searchId } = await answerPlaceSuggestion(ctx, session, eventId, answer);
  if (searchId) after(() => runPlaceSearch(ctx, searchId).catch((error) => console.error(`Recherche « Sur place » : ${describeError(error)}`)));
  return NextResponse.json({ answer, searchId });
});
