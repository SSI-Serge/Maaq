import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { createPerson, personInputSchema } from "@/server/gifts/calendar";
import { giftStore } from "@/server/gifts/service";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

/** Proches de kdo_help du profil connecté. */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json({ people: await giftStore(ctx.db).listPeople(session.user.id) });
});

/** Ajoute un proche, avec son anniversaire s'il est connu. */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await createPerson(ctx, session, await parseBody(request, personInputSchema)), { status: 201 });
});
