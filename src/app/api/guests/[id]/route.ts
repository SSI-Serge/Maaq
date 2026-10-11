import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { listGuests, removeGuest, requirePrimary, updateGuest } from "@/server/guests/service";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const schema = z.object({ firstName: z.string().max(100), lastName: z.string().max(100), email: z.string().max(254), phone: z.string().max(30) });

/** Modifie les coordonnées d'un invité (US-19). */
export const PATCH = handler(async (request: Request, { params }: Params) => {
  const { session, ctx } = await requireProfile();
  const { id } = await params;
  return idempotent(ctx, request, session.user.id, async () => {
    await updateGuest(ctx, session, id, await parseBody(request, schema));
    return NextResponse.json(await listGuests(ctx, requirePrimary(session)));
  });
});

/** Supprime un invité (US-20). */
export const DELETE = handler(async (request: Request, { params }: Params) => {
  const { session, ctx } = await requireProfile();
  const { id } = await params;
  return idempotent(ctx, request, session.user.id, async () => {
    await removeGuest(ctx, session, id);
    return NextResponse.json(await listGuests(ctx, requirePrimary(session)));
  });
});
