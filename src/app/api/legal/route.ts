import { NextResponse } from "next/server";
import { ctx } from "@/server/auth/http";
import { currentDocuments } from "@/server/compliance/legal";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Politique de confidentialité et conditions d'utilisation en vigueur : consultables sans être connecté (US-54 RF1). */
export const GET = handler(async () => {
  const context = ctx();
  return NextResponse.json({ documents: await currentDocuments(context.db, context.now) });
});
