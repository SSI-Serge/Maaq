import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin } from "@/server/auth/http";
import { loadObject, readQuery, runAction } from "@/server/courses/console";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

/** Un objet de la console : tableau, filtres, outils. */
export const GET = handler(async (request: Request, { params }: { params: Promise<{ object: string }> }) => {
  const { session, ctx } = await requireAdmin();
  const { object } = await params;
  const table = await loadObject({ ctx, adminId: session.user.id }, object, readQuery(new URL(request.url).searchParams));
  return NextResponse.json({ table });
});

const schema = z.object({ action: z.string().min(1).max(40), id: z.string().max(200).default(""), values: z.record(z.string(), z.string().max(5000)).default({}) });

/** Une action sur une ligne (modifier, retirer, fusionner…) ou un ajout (`action: "add"`). */
export const POST = handler(async (request: Request, { params }: { params: Promise<{ object: string }> }) => {
  const { session, ctx } = await requireAdmin();
  const { object } = await params;
  const body = await parseBody(request, schema);
  await runAction({ ctx, adminId: session.user.id }, object, body.action, body.id, body.values);
  return NextResponse.json({ ok: true });
});
