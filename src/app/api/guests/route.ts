import { after, NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { db } from "@/server/db/client";
import { deliverInvitation } from "@/server/guests/invitations";
import { addGuest, listGuests, requirePrimary } from "@/server/guests/service";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

/** Invités du compte et quota du plan (US-18, US-21). */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await listGuests(ctx, requirePrimary(session)));
});

const schema = z.object({
  firstName: z.string().max(100),
  lastName: z.string().max(100),
  email: z.string().max(254),
  phone: z.string().max(30),
  designateCore: z.boolean(),
});

/** Ajoute un invité ; l'invitation part en arrière-plan (US-18 RF4, RF12). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  return idempotent(ctx, request, session.user.id, async () => {
    const { guestId, delivery } = await addGuest(ctx, session, await parseBody(request, schema));
    after(() => deliverInvitation(db(), delivery.linkId, delivery.content));
    return NextResponse.json({ guestId, ...(await listGuests(ctx, requirePrimary(session))) }, { status: 201 });
  });
});
