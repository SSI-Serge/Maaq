import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { validateMenuCard } from "@/server/courses/menu-ia/validate";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({ messageId: z.string().regex(/^\d{1,18}$/) });

/** « Valider le menu » : enregistre le menu de la carte du tchat et remplit la liste de courses (US-156 RF9 à RF12). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ result: await validateMenuCard(ctx, session, body.messageId) });
});
