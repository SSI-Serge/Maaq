import { refuseChildChat } from "@/server/assistant/profile-member";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { replaceDish, replaceOptions } from "@/server/courses/menu-ia/replace";
import { handler, parseBody, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

const kind = z.enum(["dinner", "express"]);

/** Plats que « Remplacer » propose pour un plat de la carte (CR-57) : express du menu, autres dîners, Mes plats. */
export const GET = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile({ passive: true });
  // Les tchats des agents sont fermés au profil d'un enfant (S-47) : ses cartes aussi.
  await refuseChildChat(ctx.db, session.user.id);
  const url = new URL(request.url);
  const parsed = z.object({ messageId: z.string().regex(/^\d{1,18}$/), kind, index: z.coerce.number().int().min(0).max(10) }).safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) throw new Rejection("invalid_request", "Demande invalide.", 422);
  return NextResponse.json({ options: await replaceOptions(ctx, session, parsed.data) });
});

const choice = z.discriminatedUnion("group", [
  z.object({ group: z.literal("express"), index: z.number().int().min(0).max(10) }),
  z.object({ group: z.literal("dinners"), index: z.number().int().min(0).max(10) }),
  z.object({ group: z.literal("own"), dishId: z.string().min(1).max(60) }),
]);

/** Remplace un plat de la carte sans IA, hors limite de menus. */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  // Les tchats des agents sont fermés au profil d'un enfant (S-47) : ses cartes aussi.
  await refuseChildChat(ctx.db, session.user.id);
  const body = await parseBody(request, z.object({ messageId: z.string().regex(/^\d{1,18}$/), kind, index: z.number().int().min(0).max(10), choice }));
  return NextResponse.json({ card: await replaceDish(ctx, session, body) });
});
