import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { deletePerson, personInputSchema, updatePerson } from "@/server/gifts/calendar";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export const PATCH = handler(async (request: Request, { params }: Params) => {
  const { session, ctx } = await requireProfile();
  const { id } = await params;
  return NextResponse.json(await updatePerson(ctx, session, id, await parseBody(request, personInputSchema.partial())));
});

/** Effacement doux, annulable 30 jours depuis le tchat. */
export const DELETE = handler(async (_request: Request, { params }: Params) => {
  const { session, ctx } = await requireProfile();
  const { id } = await params;
  await deletePerson(ctx, session, id);
  return NextResponse.json({ deleted: true });
});
