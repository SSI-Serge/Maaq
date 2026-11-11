import { refuseChildChat } from "@/server/assistant/profile-member";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { adjustLater, decideAdjustment, proposeAdjustments } from "@/server/courses/menu-ia/adjust";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("later"), messageId: z.string().regex(/^\d{1,18}$/) }),
  z.object({ action: z.literal("propose"), messageId: z.string().regex(/^\d{1,18}$/) }),
  z.object({ action: z.enum(["accept", "refuse"]), messageId: z.string().regex(/^\d{1,18}$/), key: z.string().regex(/^(dinner|express):\d{1,2}$/) }),
]);

/** Ingrédients manquants après un ticket (CR-58) : « Je l'achèterai plus tard », « Ajuster le menu » (IA), accepter ou garder le plat. */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  // Les tchats des agents sont fermés au profil d'un enfant (S-47) : ses cartes aussi.
  await refuseChildChat(ctx.db, session.user.id);
  const body = await parseBody(request, schema);
  if (body.action === "later") return NextResponse.json({ adjust: await adjustLater(ctx, session, body.messageId) });
  if (body.action === "propose") return NextResponse.json({ adjust: await proposeAdjustments(ctx, session, body.messageId) });
  return NextResponse.json({ adjust: await decideAdjustment(ctx, session, { messageId: body.messageId, key: body.key, accept: body.action === "accept" }) });
});
