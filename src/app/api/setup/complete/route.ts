import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";
import { completeSetup } from "@/server/profile/setup";

export const dynamic = "force-dynamic";

const schema = z.object({
  guest: z
    .object({ firstName: z.string().max(100), lastName: z.string().max(100), email: z.string().max(254), phone: z.string().max(30) })
    .nullable(),
});

/** Étape 2 : l'invité 1 ou « Passer cette étape » ; la configuration est terminée (US-11). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  return idempotent(ctx, request, session.user.id, async () => {
    const { guest } = await parseBody(request, schema);
    await completeSetup(ctx, session, guest);
    return NextResponse.json({ next: "/accueil" });
  });
});
