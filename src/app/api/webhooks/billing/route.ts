import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { ctx } from "@/server/auth/http";
import { applyBillingEvent } from "@/server/compliance/lifecycle";
import { env } from "@/server/env";
import { handler, parseBody, rejected } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({ event: z.enum(["unsubscribed", "resubscribed"]), email: z.string().email().max(254) });

/**
 * Point d'entrée de l'outil de facturation : désabonnement ou réabonnement d'un compte, hors application
 * (US-58 RF1, RT2). Protégé par un secret partagé ; fermé tant que ce secret n'est pas configuré.
 */
export const POST = handler(async (request: Request) => {
  const secret = env().BILLING_WEBHOOK_SECRET;
  if (!secret) return rejected("not_configured", "Point d'entrée non configuré.", 503);
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return rejected("unauthorized", "Accès refusé.", 401);
  return NextResponse.json(await applyBillingEvent(ctx(), await parseBody(request, schema)));
});
