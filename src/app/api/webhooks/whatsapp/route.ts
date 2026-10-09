import { NextResponse } from "next/server";
import { parseWebhook, verifySignature } from "@/server/adapters/whatsapp/cloud";
import { whatsappCore } from "@/server/channels/whatsapp-core";
import { env } from "@/server/env";

export const dynamic = "force-dynamic";

/** Vérification du webhook par Meta à l'abonnement (hub.challenge). */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const verifyToken = env().WHATSAPP_VERIFY_TOKEN;
  if (url.searchParams.get("hub.mode") === "subscribe" && verifyToken && url.searchParams.get("hub.verify_token") === verifyToken) {
    return new NextResponse(url.searchParams.get("hub.challenge") ?? "", { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new NextResponse(null, { status: 403 });
}

/**
 * Messages reçus et accusés de remise. La signature est vérifiée sur le corps brut ; la réponse 200 part tout
 * de suite et le traitement (lent : modèle de langage) se fait en file, par numéro.
 */
export async function POST(request: Request) {
  const settings = env();
  if (settings.WHATSAPP_MODE !== "cloud") return new NextResponse(null, { status: 404 });
  const raw = await request.text();
  if (!verifySignature(raw, request.headers.get("x-hub-signature-256"), settings.WHATSAPP_APP_SECRET!)) {
    return NextResponse.json({ error: "signature invalide" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "corps illisible" }, { status: 400 });
  }
  try {
    await whatsappCore().handleWebhook(parseWebhook(body));
  } catch (error) {
    // Meta relancerait indéfiniment sur une erreur : on consigne et on accuse réception.
    console.error("[whatsapp] webhook :", error);
  }
  return NextResponse.json({ received: true });
}
