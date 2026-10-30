import { NextResponse } from "next/server";
import { z } from "zod";
import { getCriteria, saveCriteria } from "@/server/assistant/outings/criteria";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

/** Critères de sorties du profil connecté (US-114) : les siens seulement, jamais ceux de l'autre parent (US-117). */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ criteria: await getCriteria(ctx, session) });
});

const category = z.enum(["self", "couple", "kids", "teens"]);
const schema = z.object({
  enabled: z.boolean(),
  selected: z.partialRecord(category, z.array(z.string().max(40)).max(12)),
  budget: z.number().int().nullable(),
  people: z.number().int().nullable(),
  place: z.string().max(200),
  mood: z.enum(["calm", "playful", "both"]),
  days: z.array(z.enum(["weekend", "weekday_evenings", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"])).max(9),
  frequency: z.enum(["monthly", "twice_monthly", "weekly"]),
});

/** Enregistre les critères (US-114 RF2 à RF6). */
export const PUT = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ criteria: await saveCriteria(ctx, session, body) });
});
