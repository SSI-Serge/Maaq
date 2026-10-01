import { NextResponse } from "next/server";
import { z } from "zod";
import { listSettings, settingHistory, updateSettings } from "@/server/admin/settings";
import { requireAdmin } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

/** Paramètres de la plateforme et historique des modifications (US-65). */
export const GET = handler(async () => {
  const { ctx } = await requireAdmin();
  return NextResponse.json({ settings: await listSettings(ctx), history: await settingHistory(ctx) });
});

const schema = z.object({ values: z.record(z.string(), z.string().max(254)) });

/** Enregistre les valeurs modifiées ; renvoyer les mêmes valeurs ne change rien. */
export const PUT = handler(async (request: Request) => {
  const { session, ctx } = await requireAdmin();
  const { values } = await parseBody(request, schema);
  const changed = await updateSettings(ctx, session.user.id, values);
  return NextResponse.json({ changed, settings: await listSettings(ctx), history: await settingHistory(ctx) });
});
