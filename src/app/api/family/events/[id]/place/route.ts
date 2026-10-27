import { NextResponse, after } from "next/server";
import { describeError } from "@/server/safe-log";
import { placeSearchView, requestPlaceSearch, runPlaceSearch } from "@/server/assistant/places";
import { requireProfile } from "@/server/auth/http";
import { handler } from "@/server/http";
import { eventIdOf } from "../../params";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** « Sur place » d'un RDV (US-112 RF8) : l'état de la recherche et le dernier résultat, jusqu'à la fin du RDV. `null` quand le service de recherche est fermé. */
export const GET = handler(async (_request: Request, context: Context) => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ place: await placeSearchView(ctx, session, await eventIdOf(context)) });
});

/**
 * « Où se garer, où manger ? » (US-112 RF1, RF2, RF9, RF12) : demande la recherche, qui compte dans le plafond quotidien du profil, puis la lance aussitôt en arrière-plan, après la réponse.
 * Le planificateur de 5 minutes ne sert que de filet de sécurité (RT5).
 */
export const POST = handler(async (_request: Request, context: Context) => {
  const { session, ctx } = await requireProfile();
  const id = await requestPlaceSearch(ctx, session, await eventIdOf(context), "button");
  after(() => runPlaceSearch(ctx, id).catch((error) => console.error(`Recherche « Sur place » : ${describeError(error)}`)));
  return NextResponse.json({ place: await placeSearchView(ctx, session, await eventIdOf(context)) });
});
