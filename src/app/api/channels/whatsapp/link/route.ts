import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { createLinkCode } from "@/server/channels/linking";
import { handler, parseBody, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({ consent: z.literal(true) });

/** Code de liaison à envoyer depuis WhatsApp ; le consentement explicite est exigé avant (opt-in). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema).catch(() => null);
  if (!body) throw new Rejection("consent_required", "Cochez la case de consentement pour relier WhatsApp.");
  return NextResponse.json(await createLinkCode(ctx, session));
});
