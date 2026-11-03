import type { Ctx, SessionContext } from "@/server/auth/service";
import { partnerOf } from "./couple";
import { currentReview, type ReviewSummary } from "./reviews";
import { listWishes, type WishView } from "./wishes";

/** Ce que l'accueil de l'Assistant Famille montre de la MMF « Émotions » (E-03) : rien pour un profil hors couple, qui garde le point actuel. */
export interface EmotionsHome {
  couple: { partner: string } | null;
  /** Dernier bilan, consultable jusqu'au suivant (US-144 RF5). */
  review: ReviewSummary | null;
  /** Les trois envies les plus récentes et le fait qu'il y en ait d'autres (US-147 RF2). */
  wishes: { latest: WishView[]; more: boolean; max: number; full: boolean } | null;
}

export async function emotionsHome(ctx: Ctx, session: SessionContext): Promise<EmotionsHome> {
  if (!session.user.accountId || session.user.role === "admin") return { couple: null, review: null, wishes: null };
  const partner = await partnerOf(ctx.db, session.user.id);
  if (!partner) return { couple: null, review: null, wishes: null };
  const list = await listWishes(ctx, session);
  return {
    couple: { partner: partner.firstName },
    review: await currentReview(ctx, session),
    wishes: { latest: list.wishes.slice(0, 3), more: list.wishes.length > 3, max: list.max, full: list.wishes.length >= list.max },
  };
}
