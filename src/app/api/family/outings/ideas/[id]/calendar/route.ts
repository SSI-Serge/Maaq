import { NextResponse } from "next/server";
import { z } from "zod";
import { addIdeaToCalendar } from "@/server/assistant/outings/proposals";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({
  title: z.string().max(300),
  place: z.string().max(400).nullable(),
  notes: z.string().max(5000).nullable(),
  type: z.enum(["school", "medical", "work", "family", "personal", "admin"]),
  memberIds: z.array(z.uuid()).max(12),
  start: z.string().max(16),
  end: z.string().max(16),
  allowConflict: z.boolean().optional(),
});

/** « Ajouter au calendrier » : le RDV est enregistré confirmé, sans lien vers la proposition ; l'autre parent n'est pas notifié (US-120 RF4 à RF7). */
export const POST = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ event: await addIdeaToCalendar(ctx, session, (await context.params).id, body) }, { status: 201 });
});
