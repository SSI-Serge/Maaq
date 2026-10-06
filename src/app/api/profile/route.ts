import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { getMyProfile, updateMyNames } from "@/server/profile/me";

export const dynamic = "force-dynamic";

/** « Mes informations » du profil connecté (US-12). */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await getMyProfile(ctx, session));
});

const schema = z.object({ firstName: z.string().max(200), lastName: z.string().max(200) });

export const PATCH = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await updateMyNames(ctx, session, await parseBody(request, schema)));
});
