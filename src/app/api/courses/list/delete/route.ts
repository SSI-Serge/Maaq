import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { deleteWeekList, deleteWeekMenu } from "@/server/courses/list/delete";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

/** Supprime définitivement le menu d'une semaine (avec sa liste) ou seulement sa liste (couple seulement, CR-54). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, z.object({ what: z.enum(["menu", "list"]), week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }));
  return NextResponse.json(body.what === "menu" ? await deleteWeekMenu(ctx, session, body.week) : await deleteWeekList(ctx, session, body.week));
});
