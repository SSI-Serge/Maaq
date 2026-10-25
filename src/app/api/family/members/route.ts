import { NextResponse } from "next/server";
import { z } from "zod";
import { addChild, listFamilyMembers } from "@/server/assistant/family";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

/** Membres du foyer pour l'Assistant Famille : les parents et les enfants. Réservé aux deux parents (D33). */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ members: await listFamilyMembers(ctx, session) });
});

const schema = z.object({ firstName: z.string().max(100), birthDate: z.iso.date().nullable().optional() });

/** Ajoute un enfant au foyer (sans compte). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ member: await addChild(ctx, session, body) }, { status: 201 });
});
