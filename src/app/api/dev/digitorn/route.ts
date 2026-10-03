import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { digitorn } from "@/server/adapters/digitorn";
import { DEMO_AGENT, DEMO_USER, devOnlyGuard } from "@/server/dev-tools";
import { handler, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

export const GET = handler(async () => {
  const guard = devOnlyGuard();
  if (guard) return guard;
  return NextResponse.json({ events: await digitorn().getConversation(DEMO_USER, DEMO_AGENT) });
});

const messageSchema = z.object({ text: z.string().trim().min(1).max(2000) });

export const POST = handler(async (request: NextRequest) => {
  const guard = devOnlyGuard();
  if (guard) return guard;
  const parsed = messageSchema.safeParse(await request.json());
  if (!parsed.success) throw new Rejection("invalid_message", "Le message doit contenir entre 1 et 2 000 caractères.");

  // La clé d'idempotence du client sert d'identifiant de demande : un renvoi n'exécute rien deux fois.
  const requestId = request.headers.get("Idempotency-Key") ?? crypto.randomUUID();
  await digitorn().submitRequest({
    requestId,
    userRef: DEMO_USER,
    agentRef: DEMO_AGENT,
    text: parsed.data.text,
    context: { rank: "primary_user", autoParticipants: ["dominique@maaq.test"], ccAddresses: [], info: {} },
  });
  return NextResponse.json({ requestId }, { status: 202 });
});
