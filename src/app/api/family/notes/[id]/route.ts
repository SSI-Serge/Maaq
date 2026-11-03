import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { removeNote, updateNote } from "@/server/emotions/notes";
import { handler, parseBody, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

async function idOf(context: Context): Promise<string> {
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) throw new Rejection("not_found", "Ce mot n'existe plus.", 404);
  return id;
}

const schema = z.object({ text: z.string().max(2000) });

/** Modifie un mot, tant que le partenaire n'a pas ouvert son bilan. */
export const PATCH = handler(async (request: Request, context: Context) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ note: await updateNote(ctx, session, await idOf(context), body.text) });
});

/** Retire un mot, tant que le partenaire n'a pas ouvert son bilan. */
export const DELETE = handler(async (_request: Request, context: Context) => {
  const { session, ctx } = await requireProfile();
  await removeNote(ctx, session, await idOf(context));
  return NextResponse.json({ removed: true });
});
