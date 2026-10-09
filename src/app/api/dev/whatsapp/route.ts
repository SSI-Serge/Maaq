import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { devWhatsApp } from "@/server/adapters/whatsapp";
import { whatsappCore } from "@/server/channels/whatsapp-core";
import { devOnlyGuard } from "@/server/dev-tools";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

/** Boîte de test WhatsApp : messages « envoyés ». */
export const GET = handler(async () => {
  const guard = devOnlyGuard();
  if (guard) return guard;
  return NextResponse.json({ messages: await devWhatsApp().list() });
});

const schema = z.object({
  from: z.string().regex(/^\d{8,15}$/, "numéro sans + ni espace"),
  text: z.string().trim().min(1).max(4096).optional(),
  buttonId: z.string().min(1).max(256).optional(),
});

/** Simule un message reçu de WhatsApp (texte ou appui sur un bouton), comme si Meta appelait le webhook. */
export const POST = handler(async (request: NextRequest) => {
  const guard = devOnlyGuard();
  if (guard) return guard;
  const body = await parseBody(request, schema);
  const externalId = `wamid.dev-in-${crypto.randomUUID()}`;
  const result = await whatsappCore().handleWebhook({
    statuses: [],
    messages: [
      {
        externalId,
        from: body.from,
        profileName: null,
        receivedAt: new Date(),
        type: body.buttonId ? "button" : "text",
        text: body.text ?? body.buttonId ?? null,
        buttonId: body.buttonId ?? null,
        buttonTitle: body.buttonId ? (body.text ?? body.buttonId) : null,
      },
    ],
  });
  return NextResponse.json({ externalId, ...result }, { status: 202 });
});
