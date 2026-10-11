import { requireProfile } from "@/server/auth/http";
import { readExport } from "@/server/compliance/exports";
import { handler, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

/** Téléchargement de l'archive, réservé à son propriétaire connecté (US-55 RF6). */
export const GET = handler(async (_request: Request, { params }: { params: Promise<{ id: string }> }) => {
  const { session, ctx } = await requireProfile();
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Rejection("not_found", "Cet export n'existe pas.", 404);
  const archive = await readExport(ctx, session, id);
  return new Response(new Uint8Array(archive), {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": 'attachment; filename="mes-donnees-maaq.zip"',
      "Cache-Control": "private, no-store",
    },
  });
});
