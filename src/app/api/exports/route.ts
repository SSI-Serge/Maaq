import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { getExportState, prepareInBackground, requestExport } from "@/server/compliance/exports";
import { handler } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

/** État de la dernière demande d'export du profil (US-55 RF5). */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json(await getExportState(ctx, session));
});

/** Demande l'export des données ; la préparation se fait en arrière-plan (US-55 RF1, RF3, RF5). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  return idempotent(ctx, request, session.user.id, async () => {
    const { id, alreadyInProgress } = await requestExport(ctx, session);
    if (!alreadyInProgress) prepareInBackground(ctx, id);
    return NextResponse.json(await getExportState(ctx, session), { status: 201 });
  });
});
