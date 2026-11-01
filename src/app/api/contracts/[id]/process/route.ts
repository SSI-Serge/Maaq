import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { processContract } from "@/server/contracts/process";
import { handler } from "@/server/http";
import { numericParam } from "../../ids";

export const dynamic = "force-dynamic";
// La lecture d'un document photographié peut prendre une minute : le délai de la requête suit celui du service de lecture.
export const maxDuration = 300;

/** Lit et masque les documents en attente du contrat (US-136 RF1) ; sans effet si l'analyse n'est pas activée sur le contrat. Renvoie le contrat à jour. */
export const POST = handler(async (_request: Request, context: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  return NextResponse.json(await processContract(ctx, session, await numericParam(context.params, "id")));
});
