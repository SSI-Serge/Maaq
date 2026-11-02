import { requireProfile } from "@/server/auth/http";
import { handler, Rejection } from "@/server/http";
import { parseRange, readMedia, type MediaKind } from "@/server/presentation/service";

export const dynamic = "force-dynamic";

const KINDS = new Set<MediaKind>(["video", "captions", "poster"]);

/**
 * Sert la vidéo, ses sous-titres ou son image d'aperçu (US-140 RT1) : par MAAQ, pour un profil connecté, sans cookie ni suivi. La lecture partielle (« Range ») est gérée : l'iPhone
 * ne lit pas une vidéo sans elle. L'adresse porte la version du fichier : le navigateur la garde, un remplacement change l'adresse.
 */
export const GET = handler(async (request: Request, context: { params: Promise<{ file: string }> }) => {
  await requireProfile();
  const { file } = await context.params;
  if (!KINDS.has(file as MediaKind)) throw new Rejection("not_found", "Ce fichier n'existe pas.", 404);
  const media = await readMedia(file as MediaKind);
  if (!media) throw new Rejection("not_found", "Aucune vidéo n'est configurée.", 404);
  const headers: Record<string, string> = {
    "Content-Type": media.contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=86400",
    "X-Content-Type-Options": "nosniff",
    ETag: `"${media.version}-${file}"`,
  };
  const range = parseRange(request.headers.get("range"), media.bytes.length);
  if (range === "invalid") return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${media.bytes.length}` } });
  if (range) {
    const part = media.bytes.subarray(range.start, range.end + 1);
    return new Response(new Uint8Array(part), { status: 206, headers: { ...headers, "Content-Range": `bytes ${range.start}-${range.end}/${media.bytes.length}`, "Content-Length": String(part.length) } });
  }
  return new Response(new Uint8Array(media.bytes), { status: 200, headers: { ...headers, "Content-Length": String(media.bytes.length) } });
});
