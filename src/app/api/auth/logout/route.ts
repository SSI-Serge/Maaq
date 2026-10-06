import { closeSessionCookies, ctx, currentSession } from "@/server/auth/http";
import { logout } from "@/server/auth/service";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/**
 * Déconnexion (US-9) : la session est invalidée côté serveur et l'effacement des tchats demandé.
 * Sans effet si la session est déjà fermée : l'appareil peut la renvoyer sans risque (US-9 RF8).
 */
export const POST = handler(async () => {
  const context = ctx();
  const session = await currentSession(context);
  if (session) await logout(context, session);
  await closeSessionCookies();
  return new Response(null, { status: 204 });
});
