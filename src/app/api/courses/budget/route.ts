import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { budgetView } from "@/server/courses/budget";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Budget par rayon (US-163), d'après les tickets enregistrés. `?compare=2025` choisit l'année de comparaison. */
export const GET = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile({ passive: true });
  const raw = new URL(request.url).searchParams.get("compare");
  const year = raw && /^\d{4}$/.test(raw) ? Number(raw) : null;
  return NextResponse.json({ view: await budgetView(ctx, session, year) });
});
