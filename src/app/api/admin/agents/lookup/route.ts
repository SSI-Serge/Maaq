import { NextResponse } from "next/server";
import { z } from "zod";
import { lookupAgent } from "@/server/admin/agents";
import { requireAdmin } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({
  name: z.string().trim().min(1).max(100),
  apiKey: z.string().trim().max(200).nullish(),
});

/**
 * Cherche un agent chez Digitorn à partir de son nom (US-45 RF2, RT2). La clé secrète du projet de l'agent est envoyée
 * en POST (jamais dans l'adresse) et n'est pas conservée par cette route.
 */
export const POST = handler(async (request: Request) => {
  const { ctx } = await requireAdmin();
  const input = await parseBody(request, schema);
  return NextResponse.json(await lookupAgent(ctx, input));
});
