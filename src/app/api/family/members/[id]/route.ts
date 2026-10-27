import { NextResponse } from "next/server";
import { z } from "zod";
import { updateMember } from "@/server/assistant/family";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { memberIdOf } from "../params";

export const dynamic = "force-dynamic";

const schema = z.object({ firstName: z.string().max(200).optional(), birth: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional() });

/** Modifie un membre : prénom et date de naissance, ou la date seule pour un membre relié à un profil (US-93). */
export const PATCH = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ member: await updateMember(ctx, session, await memberIdOf(context), body) });
});
