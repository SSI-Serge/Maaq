import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { addMask, removeMask } from "@/server/contracts/process";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";
import { numericParam } from "../../../ids";

export const dynamic = "force-dynamic";

/** « Masquer aussi ce mot » : toutes ses occurrences dans ce document deviennent un jeton (US-137 RF3). */
export const POST = handler(async (request: Request, context: { params: Promise<{ docId: string }> }) => {
  const { session, ctx } = await requireProfile();
  return idempotent(ctx, request, session.user.id, async () => {
    const { word } = await parseBody(request, z.object({ word: z.string().min(1).max(200) }));
    return NextResponse.json(await addMask(ctx, session, await numericParam(context.params, "docId"), word));
  });
});

/** Annule un masque posé à la main (US-137 RF3). */
export const DELETE = handler(async (request: Request, context: { params: Promise<{ docId: string }> }) => {
  const { session, ctx } = await requireProfile();
  return idempotent(ctx, request, session.user.id, async () => {
    const { token } = await parseBody(request, z.object({ token: z.string().regex(/^\[DONNEE_\d{1,4}\]$/) }));
    return NextResponse.json(await removeMask(ctx, session, await numericParam(context.params, "docId"), token));
  });
});
