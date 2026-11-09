import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { writeMenuSteps } from "@/server/courses/menu-ia/steps";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/** « Rédiger le déroulé » : l'IA écrit le déroulé de la séance d'un menu validé sans déroulé (CR-57, hors limite de menus). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, z.object({ week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }));
  return NextResponse.json({ result: await writeMenuSteps(ctx, session, body.week) });
});
