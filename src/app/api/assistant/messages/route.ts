import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { listAssistantMessages, sendAssistantMessage } from "@/server/assistant/service";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";
// Un tour peut enchaîner plusieurs appels du modèle : on laisse jusqu'à une minute à la demande.
export const maxDuration = 60;

const schema = z.object({ requestId: z.uuid(), text: z.string().max(4000) });

/**
 * Message d'un parent à l'Assistant Famille (texte tapé ou collé). L'identifiant de la demande, choisi par l'écran, rend le renvoi sans
 * danger : la réponse déjà donnée est rendue, aucun rendez-vous n'est créé deux fois. Les autres entrées (voix, image, mail) viendront
 * s'ajouter avec leur propre point d'entrée.
 */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  const reply = await sendAssistantMessage(ctx, session, { ...body, source: "typed" });
  return NextResponse.json(reply, { status: reply.failed ? 502 : 201 });
});

/** Fil récent de ce parent avec l'assistant : 4 jours au plus (D38). */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ messages: await listAssistantMessages(ctx, session) });
});
