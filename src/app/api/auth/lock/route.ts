import { lockSession } from "@/server/auth/http";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** Verrouillage après inactivité, décidé par l'appareil (US-52 RF1, RT1) : le serveur s'aligne. */
export const POST = handler(async () => {
  await lockSession();
  return new Response(null, { status: 204 });
});
