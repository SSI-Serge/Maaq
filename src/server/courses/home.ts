import type { Ctx, SessionContext } from "@/server/auth/service";
import { loadSettings, requireAccess, type CourseAccess } from "./household/settings";

/** Accueil de l'agent « Courses et repas » (CR-Tchat) : ce qui est prêt, ce que l'autre parent a ajouté, le jour du budget. */

export interface CourseHome {
  access: CourseAccess;
  firstName: string;
  /** Réglages demandés au premier lancement qui manquent (couple). */
  missing: string[];
  /** Prénoms des deux parents du foyer. */
  couple: string[];
  list: null | { validatedDay: string; products: number; stores: number };
  /** Produits ajoutés par quelqu'un d'autre depuis la dernière validation : « Julien a ajouté du lait et du liquide vaisselle ». */
  addedByOthers: { by: string; names: string[] } | null;
  budgetDay: boolean;
}

const WEEKDAYS = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];

export async function courseHome(ctx: Ctx, session: SessionContext): Promise<CourseHome> {
  const who = await requireAccess(ctx, session, "list");
  const couple = who.access === "couple";
  const settings = couple ? await loadSettings(ctx.db, who.accountId) : null;
  const list = await ctx.db.selectFrom("grocery_lists").select(["id", "validated_at"]).where("account_id", "=", who.accountId).orderBy("validated_at", "desc").limit(1).executeTakeFirst();
  let summary: CourseHome["list"] = null;
  if (list) {
    const items = await ctx.db.selectFrom("grocery_list_items").select(["store_chain"]).where("account_id", "=", who.accountId).where("list_id", "=", list.id).where("state", "in", ["validated", "bought"]).execute();
    summary = { validatedDay: WEEKDAYS[list.validated_at.getDay()], products: items.length, stores: new Set(items.map((i) => i.store_chain).filter(Boolean)).size };
  }
  const others = await ctx.db
    .selectFrom("grocery_list_items as i")
    .innerJoin("users as u", "u.id", "i.added_by_user_id")
    .select(["i.label", "u.first_name"])
    .where("i.account_id", "=", who.accountId)
    .where("i.source", "=", "added")
    .where("i.state", "in", ["preparing", "added_after_validation"])
    .where("i.added_by_user_id", "<>", who.userId)
    .orderBy("i.created_at")
    .execute();
  return {
    access: who.access,
    firstName: session.user.firstName,
    missing: settings?.missing ?? [],
    couple: settings?.couple ?? [],
    list: summary,
    addedByOthers: others.length ? { by: [...new Set(others.map((o) => o.first_name))].join(" et "), names: others.map((o) => o.label) } : null,
    budgetDay: !!settings && ctx.now.getDate() === settings.budgetDay,
  };
}
