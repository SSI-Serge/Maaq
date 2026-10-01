import { NextResponse } from "next/server";
import { z } from "zod";
import { listAgents, publishAgent } from "@/server/admin/agents";
import { requireAdmin } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

/** Liste des agents du catalogue, filtrable (US-45 RF1). */
export const GET = handler(async (request: Request) => {
  const { ctx } = await requireAdmin();
  const search = new URL(request.url).searchParams.get("q") ?? "";
  return NextResponse.json({ agents: await listAgents(ctx, search) });
});

const lines = z.array(z.string().trim().min(1).max(500)).max(20);

const schema = z.object({
  digitornRef: z.string().min(1).max(100),
  name: z.string().trim().min(1).max(100),
  category: z.enum(["pro", "perso", "contracts"]),
  shortDescription: z.string().trim().min(1).max(200),
  fullDescription: z.string().trim().min(1).max(5000),
  examples: lines,
  suggestions: lines,
  connectors: z
    .array(
      z.object({
        code: z.enum(["google_drive", "google_calendar", "validation_mailbox"]),
        scope: z.enum(["each_profile", "primary_user", "account"]),
      }),
    )
    .max(3)
    .refine((list) => new Set(list.map((c) => c.code)).size === list.length),
  infoFields: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(150),
        dataType: z.enum(["text", "phone", "postal_code", "past_date", "email"]),
        required: z.boolean(),
        maxItems: z.number().int().min(1).max(100),
        sharedKey: z.string().trim().regex(/^[a-z0-9_]+$/).nullable(),
      }),
    )
    .max(30),
  ccMaxCount: z.number().int().min(0).max(50),
  validatedActions: z.array(z.string().trim().min(1).max(150)).max(20),
});

/** Met un agent à disposition dans le catalogue (US-45). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireAdmin();
  return idempotent(ctx, request, session.user.id, async () => {
    const input = await parseBody(request, schema);
    const id = await publishAgent(ctx, session.user.id, input);
    return NextResponse.json({ id }, { status: 201 });
  });
});
