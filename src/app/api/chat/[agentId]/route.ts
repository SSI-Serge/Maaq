import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { getChat } from "@/server/chat/service";
import { handler } from "@/server/http";
import { agentIdOf } from "./params";

export const dynamic = "force-dynamic";

/**
 * Contenu du tchat (US-37). Avec `?auto=1`, c'est une relecture automatique en arrière-plan : elle
 * ne prolonge pas le déverrouillage de l'application (US-52).
 */
export const GET = handler(async (request: Request, context: { params: Promise<{ agentId: string }> }) => {
  const automatic = new URL(request.url).searchParams.get("auto") === "1";
  const { session, ctx } = await requireProfile({ passive: automatic });
  return NextResponse.json(await getChat(ctx, session, await agentIdOf(context)));
});
