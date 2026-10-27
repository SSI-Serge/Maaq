import { NextResponse } from "next/server";
import { z } from "zod";
import { getEvent, updateEvent } from "@/server/assistant/events";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { eventIdOf } from "../params";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Détail d'un rendez-vous, avec ses éventuels conflits et créneaux alternatifs (US-75, US-79). */
export const GET = handler(async (_request: Request, context: Context) => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ event: await getEvent(ctx, session, await eventIdOf(context)) });
});

const repetition = z.object({
  frequency: z.enum(["weekly", "biweekly", "monthly_day", "monthly_weekday"]),
  weekdays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  end: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("date"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    z.object({ kind: z.literal("count"), count: z.number().int().min(1).max(400) }),
    z.object({ kind: z.literal("never") }),
  ]),
  skipSchoolHolidays: z.boolean().optional(),
});

const schema = z.object({
  version: z.number().int().min(1),
  allowConflict: z.boolean().optional(),
  scope: z.enum(["this", "following", "all"]).optional(),
  repetition: repetition.nullable().optional(),
  title: z.string().max(300),
  type: z.enum(["school", "medical", "work", "family", "personal", "admin"]),
  allFamily: z.boolean(),
  memberIds: z.array(z.uuid()).max(50),
  start: z.string().max(16),
  end: z.string().max(16).nullable().optional(),
  allDay: z.boolean(),
  place: z.string().max(1000).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
});

/** Modifie un rendez-vous provisoire ou confirmé (US-76, US-80). Le corps porte la version affichée par l'écran. */
export const PATCH = handler(async (request: Request, context: Context) => {
  const { session, ctx } = await requireProfile();
  const { version, allowConflict, scope, ...changes } = await parseBody(request, schema);
  return NextResponse.json({ event: await updateEvent(ctx, session, await eventIdOf(context), changes, { expectedVersion: version, allowConflict, scope }) });
});
