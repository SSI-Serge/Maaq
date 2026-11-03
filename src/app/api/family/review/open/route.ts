import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { openReview } from "@/server/emotions/reviews";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({ id: z.uuid().optional() });

/** Ouvre le bilan (US-143 RF8) : la première fois, rattache et fige les mots du partenaire ; renvoie le contenu du bilan. */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ review: await openReview(ctx, session, body.id) });
});
