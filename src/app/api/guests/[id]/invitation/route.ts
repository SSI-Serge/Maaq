import { after, NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { db } from "@/server/db/client";
import { deliverInvitation } from "@/server/guests/invitations";
import { listGuests, requirePrimary, sendInvitation } from "@/server/guests/service";
import { handler } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

/** Envoie ou renvoie un lien d'invitation ; l'ancien lien est invalidé (US-5). */
export const POST = handler(async (request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  const { id } = await params;
  return idempotent(ctx, request, session.user.id, async () => {
    const delivery = await sendInvitation(ctx, session, id);
    after(() => deliverInvitation(db(), delivery.linkId, delivery.content));
    return NextResponse.json(await listGuests(ctx, requirePrimary(session)));
  });
});
