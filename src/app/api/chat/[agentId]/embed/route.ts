import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { openEmbeddedChat } from "@/server/chat/embed";
import { handler } from "@/server/http";
import { agentIdOf } from "../params";

export const dynamic = "force-dynamic";

/**
 * Ouvre le tchat embarqué de Digitorn (US-37) : un lien de lancement neuf à chaque affichage, valable une seule fois.
 * La réponse ne doit jamais être mise en cache, et le lien n'est jamais journalisé.
 */
export const POST = handler(async (_request: Request, context: { params: Promise<{ agentId: string }> }) => {
  const { session, ctx } = await requireProfile();
  const chat = await openEmbeddedChat(ctx, session, await agentIdOf(context));
  return NextResponse.json(chat, { headers: { "Cache-Control": "no-store" } });
});
