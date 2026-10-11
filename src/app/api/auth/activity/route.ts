import { requireProfile } from "@/server/auth/http";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/**
 * Signal d'activité envoyé par l'appareil pendant que le profil interagit sans appeler le serveur
 * (saisie d'un long message…) : prolonge le déverrouillage de 5 minutes (US-52).
 */
export const POST = handler(async () => {
  await requireProfile({ allowGrace: true, allowLegalPending: true });
  return new Response(null, { status: 204 });
});
