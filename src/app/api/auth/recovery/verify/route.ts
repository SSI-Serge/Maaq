import { NextResponse } from "next/server";
import { z } from "zod";
import { ctx, knownDeviceIds, setGrant } from "@/server/auth/http";
import { codeRejection } from "@/server/auth/responses";
import { verifyRecoveryCode } from "@/server/auth/service";
import { handler, parseBody, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({
  email: z.string().trim().email().max(254),
  code: z.string().trim().regex(/^\d{6}$/),
});

/** Un code correct autorise à recréer le schéma sur cet appareil (US-8 RF5). */
export const POST = handler(async (request: Request) => {
  const body = await parseBody(request, schema);
  const context = ctx();
  const result = await verifyRecoveryCode(context, {
    ...body,
    purpose: "access_recovery",
    knownDeviceIds: await knownDeviceIds(),
  });
  if (result.kind !== "ok") throw codeRejection(result.kind);
  if (!result.deviceId) {
    throw new Rejection(
      "device_unknown",
      "Cet appareil n'est pas encore reconnu : connectez-vous avec votre mot de passe, puis créez votre schéma.",
      409,
    );
  }
  await setGrant({ userId: result.userId, deviceId: result.deviceId, purpose: "pattern_recovery" }, context.now);
  return NextResponse.json({ next: "/schema/creer" });
});
