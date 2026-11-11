import { NextResponse } from "next/server";
import { z } from "zod";
import { setChildProfile, updateMember } from "@/server/assistant/family";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { memberIdOf } from "../params";

export const dynamic = "force-dynamic";

const schema = z.object({ firstName: z.string().max(200).optional(), birth: z.string().regex(/^\d{4}-\d{2}$/).nullable().optional(), profileUserId: z.uuid().nullable().optional() });

/** Modifie un membre : prénom et date de naissance, ou la date seule pour un membre relié à un profil (US-93). */
export const PATCH = handler(async (request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  const id = await memberIdOf(context);
  const { profileUserId, ...fields } = body;
  let member = await updateMember(ctx, session, id, fields);
  // « Profil de [prénom] » : l'invité secondaire relié à la fiche enfant, ou aucun (D73 S-48)
  if (profileUserId !== undefined) member = await setChildProfile(ctx, session, id, profileUserId);
  return NextResponse.json({ member });
});
