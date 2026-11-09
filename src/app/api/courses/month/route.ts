import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { composeMonth, monthReplace, monthReplaceOptions, monthStatus, monthValidate } from "@/server/courses/month/service";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";
export const maxDuration = 150;

const id = z.string().regex(/^\d{1,18}$/);
const week = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const kind = z.enum(["dinner", "express"]);
const choice = z.discriminatedUnion("group", [
  z.object({ group: z.literal("express"), index: z.number().int().min(0).max(10) }),
  z.object({ group: z.literal("dinners"), index: z.number().int().min(0).max(10) }),
  z.object({ group: z.literal("own"), dishId: z.string().min(1).max(60) }),
]);

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("compose"), startWeek: week.nullable().optional(), variant: z.number().int().min(0).max(50).optional(), previous: id.nullable().optional(), more: z.boolean().optional() }),
  z.object({ action: z.literal("options"), messageId: id, week, kind, index: z.number().int().min(0).max(10) }),
  z.object({ action: z.literal("replace"), messageId: id, week, kind, index: z.number().int().min(0).max(10), choice }),
  z.object({ action: z.literal("validate"), messageId: id, keep: z.array(week).max(4).optional() }),
]);

/** Menu du mois dans le budget : état (menus, tickets, budget, dernière proposition). */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ status: await monthStatus(ctx, session) });
});

/** Composer le menu du mois, le consulter, remplacer un plat (sans IA) et valider les 4 menus (CR-59). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  if (body.action === "compose") return NextResponse.json({ card: await composeMonth(ctx, session, body) });
  if (body.action === "options") return NextResponse.json({ options: await monthReplaceOptions(ctx, session, body) });
  if (body.action === "replace") return NextResponse.json({ card: await monthReplace(ctx, session, body) });
  return NextResponse.json({ result: await monthValidate(ctx, session, body) });
});
