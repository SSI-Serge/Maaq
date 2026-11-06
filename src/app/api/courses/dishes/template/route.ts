import { requireProfile } from "@/server/auth/http";
import { requireAccess } from "@/server/courses/household/settings";
import { dishTemplate } from "@/server/courses/menu/dishes";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Le modèle CSV pour ajouter plusieurs plats d'un coup. */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  await requireAccess(ctx, session, "couple");
  const t = dishTemplate();
  return new Response(t.content, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${t.file}"`, "cache-control": "no-store" } });
});
