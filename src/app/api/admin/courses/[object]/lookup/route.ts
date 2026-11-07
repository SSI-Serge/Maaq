import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/server/auth/http";
import { lookupValue } from "@/server/courses/console";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

/** Calcul à la demande (pourcentage de correspondance d'un nom de plat). */
export const POST = handler(async (request: Request, { params }: { params: Promise<{ object: string }> }) => {
  const { session, ctx } = await requireAdmin();
  const { object } = await params;
  const { value } = await parseBody(request, z.object({ value: z.string().max(160) }));
  return NextResponse.json({ lines: await lookupValue({ ctx, adminId: session.user.id }, object, value) });
});
