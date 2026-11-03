import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { addNote, listMyNotes } from "@/server/emotions/notes";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

/** Les mots que ce profil a écrits pour son partenaire (US-143 RF4). */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json(await listMyNotes(ctx, session));
});

const schema = z.object({ text: z.string().max(2000) });

/** Écrit un mot pour le partenaire : chiffré, jamais envoyé à l'agent, invisible du partenaire avant l'ouverture de son bilan. */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ note: await addNote(ctx, session, body.text) }, { status: 201 });
});
