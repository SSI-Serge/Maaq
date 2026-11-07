import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { listCourseMessages, MAX_COURSE_TEXT, sendCourseMessage } from "@/server/courses/chat/service";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

/** Les messages récents du tchat de l'agent Courses et repas. */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ messages: await listCourseMessages(ctx, session) });
});

const schema = z.object({ requestId: z.string().uuid(), text: z.string().max(MAX_COURSE_TEXT + 100) });

/** Envoie un message à l'agent ; un renvoi avec le même identifiant de demande ne refait rien. */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json(await sendCourseMessage(ctx, session, body));
});
