import { NextResponse } from "next/server";
import { z } from "zod";
import { ctx } from "@/server/auth/http";
import { MESSAGES } from "@/server/auth/rules";
import { requestRecoveryCode } from "@/server/auth/service";
import { handler, parseBody } from "@/server/http";

export const dynamic = "force-dynamic";

const schema = z.object({ email: z.string().trim().email().max(254) });

/** Code de récupération du schéma tactile (US-8). La réponse ne révèle pas si le compte existe. */
export const POST = handler(async (request: Request) => {
  const { email } = await parseBody(request, schema);
  await requestRecoveryCode(ctx(), email, "access_recovery");
  return NextResponse.json({ message: MESSAGES.neutralCodeSent });
});
