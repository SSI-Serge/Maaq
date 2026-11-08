import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { addMenuDishesToMine } from "@/server/courses/menu-ia/mine";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({ messageId: z.string().regex(/^\d{1,18}$/).optional(), week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), slots: z.array(z.string().regex(/^(dinner|express):\d{1,2}$/)).max(11) });

/** « Ajouter ce plat à vos plats ? » : copie les plats cochés du menu validé dans « Mes plats ». */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  return NextResponse.json({ result: await addMenuDishesToMine(ctx, session, body) });
});
