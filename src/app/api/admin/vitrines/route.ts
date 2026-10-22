import { NextResponse } from "next/server";
import { listStorefronts, marketplaceCounters, type StorefrontFilter } from "@/server/admin/storefronts";
import { requireAdmin } from "@/server/auth/http";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

const FILTERS: StorefrontFilter[] = ["all", "reported", "published", "draft", "paused", "suspended"];

/** Admin › Vitrines : liste filtrée (signalées d'abord) et compteurs (US-17). */
export const GET = handler(async (request: Request) => {
  const { ctx } = await requireAdmin();
  const params = new URL(request.url).searchParams;
  const filter = (FILTERS.find((f) => f === params.get("filtre")) ?? "all") as StorefrontFilter;
  const [storefronts, counters] = await Promise.all([listStorefronts(ctx, filter, params.get("q") ?? ""), marketplaceCounters(ctx)]);
  return NextResponse.json({ storefronts, counters });
});
