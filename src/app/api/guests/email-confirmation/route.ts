import { NextResponse } from "next/server";
import { z } from "zod";
import { confirmEmailChange, inspectEmailChange } from "@/server/guests/service";
import { db } from "@/server/db/client";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({ token: z.string().min(10).max(4000) });

/**
 * Confirmation, par l'invité, de son nouvel email de connexion (US-19, décision du 13/11/2026). Sans session : le lien signé reçu à la nouvelle adresse fait foi.
 * `apply: false` montre seulement de quoi il s'agit ; la confirmation demande un geste (pas de changement à la simple ouverture du lien par un antivirus de messagerie).
 */
export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, schema.extend({ apply: z.boolean() }));
  const ctx = { db: db(), now: new Date() };
  return NextResponse.json(body.apply ? await confirmEmailChange(ctx, body.token) : await inspectEmailChange(ctx, body.token));
});
