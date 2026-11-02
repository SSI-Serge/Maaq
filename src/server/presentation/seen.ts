import type { Ctx, SessionContext } from "@/server/auth/service";

/**
 * Marque l'écran « Découvrir MAAQ » comme vu ou passé pour ce profil (US-140 RF4) : une seule date, jamais écrasée, aucune autre donnée de lecture (RT3).
 * L'administrateur n'est jamais concerné. Idempotent : un second appel ne change rien.
 */
export async function markPresentationSeen(ctx: Ctx, session: SessionContext): Promise<void> {
  if (session.user.role === "admin") return;
  await ctx.db
    .updateTable("users")
    .set({ presentation_seen_at: ctx.now })
    .where("id", "=", session.user.id)
    .where("presentation_seen_at", "is", null)
    .execute();
}
