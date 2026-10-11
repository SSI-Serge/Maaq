import { NextResponse } from "next/server";
import { z } from "zod";
import { ctx, knownDeviceIds, setGrant } from "@/server/auth/http";
import { codeRejection } from "@/server/auth/responses";
import { verifyRecoveryCode } from "@/server/auth/service";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().trim().email().max(254),
  code: z.string().trim().regex(/^\d{6}$/),
});

/** Un code correct ouvre l'écran « Nouveau mot de passe » (US-66 RF6). */
export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, schema);
  const context = ctx();
  const result = await verifyRecoveryCode(context, {
    ...body,
    purpose: "password_reset",
    knownDeviceIds: await knownDeviceIds(),
  });
  if (result.kind !== "ok") throw codeRejection(result.kind);
  await setGrant({ userId: result.userId, deviceId: result.deviceId, purpose: "password_reset" }, context.now);
  return NextResponse.json({ ok: true });
});
