import { NextResponse } from "next/server";
import { z } from "zod";
import { closeSessionCookies, requireProfile } from "@/server/auth/http";
import { requestDeletion } from "@/server/compliance/lifecycle";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({ password: z.string().min(1).max(200) });

/**
 * Demande la suppression du compte et des données, après vérification du mot de passe (US-56). Le profil est
 * déconnecté de tous ses appareils, celui-ci compris.
 */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const { password } = await parseBody(request, schema);
  const result = await requestDeletion(ctx, session, password);
  await closeSessionCookies();
  return NextResponse.json(result);
});
