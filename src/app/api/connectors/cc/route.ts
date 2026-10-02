import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { addCcAddress, removeCcAddress } from "@/server/connectors/service";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

const schema = z.object({ agentId: z.string().regex(/^\d{1,18}$/), email: z.string().max(254) });

/** Ajoute une adresse en copie systématique (US-16, US-17). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  return idempotent(ctx, request, session.user.id, async () => {
    return NextResponse.json(await addCcAddress(ctx, session, await parseBody(request, schema)), { status: 201 });
  });
});

/** Retire une adresse en copie. */
export const DELETE = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await removeCcAddress(ctx, session, await parseBody(request, schema)));
});
