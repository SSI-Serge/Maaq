import { NextResponse } from "next/server";
import { pendingConfirmations } from "@/server/assistant/reminders";
import { requireProfile } from "@/server/auth/http";
import { handler } from "@/server/http";
import { sendPush } from "@/server/push/service";

export const dynamic = "force-dynamic";

/** Envoie une notification de test aux appareils autorisés du profil, pour vérifier que les rappels arrivent bien. */
export const POST = handler(async () => {
  const { session, ctx } = await requireProfile();
  const result = await sendPush(ctx, session.user.id, {
    title: "Assistant Famille",
    body: "Les rappels arrivent bien sur cet appareil.",
    url: "/assistant",
    tag: "test",
    badge: session.user.accountId ? await pendingConfirmations(ctx.db, session.user.accountId, ctx.now) : 0, // le test ne touche pas au badge
  });
  return NextResponse.json({ delivered: result.delivered });
});
