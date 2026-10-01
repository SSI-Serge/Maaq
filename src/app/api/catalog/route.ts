import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { listCatalog, visibleCategories, type CategoryCode } from "@/server/catalog/service";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

const CATEGORIES: CategoryCode[] = ["pro", "perso", "contracts"];

/**
 * Catalogue d'une rubrique, chargé rubrique par rubrique (US-23 RT1), ou résultats de recherche
 * toutes rubriques confondues (US-25) avec ?q=.
 */
export const GET = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const params = new URL(request.url).searchParams;
  const category = CATEGORIES.find((c) => c === params.get("categorie"));
  const agents = await listCatalog(ctx, session, { category, query: params.get("q") ?? "" });
  return NextResponse.json({ categories: visibleCategories(session), agents });
});
