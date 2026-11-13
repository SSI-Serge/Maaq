import { NextResponse } from "next/server";
import { z } from "zod";
import { childLinkCandidates, setChildProfile } from "@/server/assistant/family";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

/** Profils d'invités secondaires déjà créés, pas encore reliés à une fiche enfant (S-56, rattrapage). Réservé aux parents. */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ candidates: await childLinkCandidates(ctx, session) });
});

const schema = z.object({ userId: z.uuid(), memberId: z.uuid() });

/** « Relier à [fiche] » : le profil devient celui de l'enfant ; ses RDV et ses tâches passent sur la fiche enfant (S-49). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  const member = await setChildProfile(ctx, session, body.memberId, body.userId);
  return NextResponse.json({ member });
});
