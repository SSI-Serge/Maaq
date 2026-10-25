import { NextResponse } from "next/server";
import { z } from "zod";
import { addChild, familyOverview } from "@/server/assistant/family";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

/** Membres du foyer pour l'Assistant Famille : les actifs, puis les retirés. Réservé aux deux parents (D33). */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json(await familyOverview(ctx, session));
});

const schema = z.object({ firstName: z.string().max(200), birthDate: z.iso.date().nullable().optional() });

/** Ajoute un membre sans compte (US-92). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ member: await addChild(ctx, session, body) }, { status: 201 });
});
