import { NextResponse, type NextRequest } from "next/server";

/**
 * Zone de test en ligne (MAAQ_ZONE=test) : la boîte de test contient les codes de connexion de tous les profils,
 * elle ne doit donc pas être publique. Les pages et routes /dev ne répondent qu'à qui détient la clé
 * MAAQ_DEV_TOOLS_KEY : ouvrir une première fois /dev/boite?cle=<la clé> la mémorise dans un cookie.
 * En développement local et hors zone de test, ce contrôle ne fait rien.
 */
export function proxy(request: NextRequest) {
  if (process.env.NODE_ENV !== "production" || process.env.MAAQ_ZONE !== "test") return NextResponse.next();

  const key = process.env.MAAQ_DEV_TOOLS_KEY;
  if (!key || key.length < 16) return new NextResponse(null, { status: 404 });

  const given = request.nextUrl.searchParams.get("cle");
  if (given === key) {
    // Adresse publique vue par le navigateur : derrière Cloud Run, celle du serveur interne n'est pas la bonne.
    const clean = new URLSearchParams(request.nextUrl.searchParams);
    clean.delete("cle");
    const query = clean.toString();
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? request.nextUrl.host;
    const protocol = request.headers.get("x-forwarded-proto") ?? "https";
    const response = NextResponse.redirect(`${protocol}://${host}${request.nextUrl.pathname}${query ? `?${query}` : ""}`);
    response.cookies.set("maaq_dev", key, { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 12 * 3600 });
    return response;
  }
  if (request.cookies.get("maaq_dev")?.value === key) return NextResponse.next();
  return new NextResponse(null, { status: 404 });
}

export const config = { matcher: ["/dev/:path*", "/api/dev/:path*"] };
