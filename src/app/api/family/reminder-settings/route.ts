import { NextResponse } from "next/server";
import { z } from "zod";
import { getReminderSettings, setReminderSetting } from "@/server/assistant/reminders";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

/** Délais de rappel par type de rendez-vous, communs à la famille (US-82). */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json(await getReminderSettings(ctx, session));
});

const schema = z.object({ type: z.string().max(20), kind: z.string().max(10), enabled: z.boolean() });

/** Active ou désactive un rappel pour un type de rendez-vous : enregistré dès qu'on touche l'interrupteur. */
export const PATCH = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ setting: await setReminderSetting(ctx, session, body) });
});
