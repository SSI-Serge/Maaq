import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { pushStatus, removeSubscription, saveSubscription } from "@/server/push/service";

export const dynamic = "force-dynamic";

/** État des notifications de cet appareil : service disponible, clé publique pour l'abonnement, appareil déjà inscrit (US-94). */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json(await pushStatus(ctx, session));
});

const schema = z.object({
  endpoint: z.string().max(2048),
  keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(200) }),
});

/** Inscrit cet appareil aux notifications, une fois l'autorisation accordée sur le téléphone (US-94 RF4). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  await saveSubscription(ctx, session, await parseBody(request, schema));
  return NextResponse.json({ subscribed: true }, { status: 201 });
});

/** Désinscrit cet appareil. */
export const DELETE = handler(async () => {
  const { session, ctx } = await requireProfile();
  await removeSubscription(ctx, session);
  return NextResponse.json({ subscribed: false });
});
