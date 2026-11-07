import { NextResponse } from "next/server";
import { requireAdmin } from "@/server/auth/http";
import { importFile } from "@/server/courses/console";
import { courseError } from "@/server/courses/household/settings";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

const MAX_BYTES = 5 * 1024 * 1024;

/** Importe un fichier CSV ou xlsx (règles communes : tout est vérifié avant l'écriture). `dry=1` contrôle sans rien importer, `replace=1` remplace tout. */
export const POST = handler(async (request: Request, { params }: { params: Promise<{ object: string }> }) => {
  const { session, ctx } = await requireAdmin();
  const { object } = await params;
  const form = await request.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) throw courseError("file_required", "Choisissez un fichier CSV ou xlsx.", 422);
  if (file.size > MAX_BYTES) throw courseError("file_too_large", "Le fichier est trop gros (5 Mo au plus).", 413);
  const result = await importFile({ ctx, adminId: session.user.id }, object, { name: file.name, content: Buffer.from(await file.arrayBuffer()) }, { replaceAll: form?.get("replace") === "1", dryRun: form?.get("dry") === "1" });
  return NextResponse.json(result);
});
