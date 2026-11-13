import { refuseChildChat } from "@/server/assistant/profile-member";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { validateWeekMenu } from "@/server/courses/menu-ia/after-validation";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const schema = z.object({ messageId: z.string().regex(/^\d{1,18}$/) });

/** « Valider le menu » : enregistre le menu de la carte du tchat et remplit la liste de courses (US-156 RF9 à RF12). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  // Les tchats des agents sont fermés au profil d'un enfant (S-47) : ses cartes aussi.
  await refuseChildChat(ctx.db, session.user.id);
  const body = await parseBody(request, schema);
  return NextResponse.json({ result: await validateWeekMenu(ctx, session, body.messageId) });
});
