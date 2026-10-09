import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { prefsStore } from "@/server/gifts/service";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const schema = z.object({
  reminderChannel: z.enum(["app", "whatsapp", "both"]).optional(),
  quietHoursStart: z.string().regex(TIME).optional(),
  quietHoursEnd: z.string().regex(TIME).optional(),
  timezone: z.string().min(1).optional(),
});

/** Préférences de rappel du profil : canal, heures calmes, fuseau. */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await prefsStore(ctx.db).get(session.user.id));
});

export const PATCH = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await prefsStore(ctx.db).set(session.user.id, await parseBody(request, schema)));
});
