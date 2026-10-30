import { NextResponse } from "next/server";
import { z } from "zod";
import { setHomeworkAge } from "@/server/assistant/homework/settings";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { memberIdOf } from "../../../members/params";

export const dynamic = "force-dynamic";

const schema = z.object({ age: z.number().int() });

/** Âge des devoirs d'un enfant (US-118 RF4) : les deux parents. */
export const PATCH = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ setting: await setHomeworkAge(ctx, session, await memberIdOf(context), body.age) });
});
