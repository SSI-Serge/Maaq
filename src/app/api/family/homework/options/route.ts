import { NextResponse } from "next/server";
import { z } from "zod";
import { homeworkOptionsFor } from "@/server/assistant/homework/weeks";
import { requireProfile } from "@/server/auth/http";
import { handler, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

const query = z.object({ member: z.uuid(), week: z.iso.date().nullable() });

/** Ce que l'aide propose pour un enfant : blocs d'exercices de son niveau et activités de chaque catégorie à son âge des devoirs (US-119 RF2). */
export const GET = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile({ passive: true });
  const url = new URL(request.url);
  const parsed = query.safeParse({ member: url.searchParams.get("member"), week: url.searchParams.get("week") });
  if (!parsed.success) throw new Rejection("invalid_query", "La demande est incomplète.", 422);
  return NextResponse.json(await homeworkOptionsFor(ctx, session, parsed.data.member, parsed.data.week));
});
