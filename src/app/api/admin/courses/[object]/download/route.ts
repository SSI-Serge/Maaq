import { requireAdmin } from "@/server/auth/http";
import { downloadFile, readQuery } from "@/server/courses/console";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Un fichier de la console (export, modèle, liste de contrôle) en CSV. `?file=export`. */
export const GET = handler(async (request: Request, { params }: { params: Promise<{ object: string }> }) => {
  const { session, ctx } = await requireAdmin();
  const { object } = await params;
  const url = new URL(request.url);
  const file = await downloadFile({ ctx, adminId: session.user.id }, object, url.searchParams.get("file") ?? "export", readQuery(url.searchParams));
  return new Response(file.content, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${file.file}"`, "cache-control": "no-store" } });
});
