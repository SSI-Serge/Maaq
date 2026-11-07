import type { Ctx, SessionContext } from "@/server/auth/service";
import { budgetView } from "../budget";
import { listItemMatches } from "../engine";
import { courseError, requireAccess, type CourseAccess } from "../household/settings";
import { setBought } from "../list/mine";
import { addProduct } from "../list/service";
import { euro } from "../console/util";
import { SCREENS, type ScreenKey } from "./screens";

/**
 * Outils de l'agent « Courses et repas » : MAAQ les exécute lui-même, avec les droits du profil qui écrit (un invité secondaire ne peut qu'ajouter un produit et cocher
 * « acheté »). L'agent ne calcule rien : menu, liste, prix et budget sont à l'écran. Les liens vers les écrans sont des marqueurs `[[ecran:nom]]` que le tchat remplace.
 */



export interface CourseToolContext {
  ctx: Ctx;
  session: SessionContext;
  access: CourseAccess;
  accountId: string;
  /** Marqueurs d'écran donnés dans cette demande. */
  opened: Set<string>;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

const ok = (content: string): ToolOutcome => ({ content, isError: false });
const fail = (content: string): ToolOutcome => ({ content, isError: true });

const names = (input: unknown, key: string): string[] => {
  const value = (input as Record<string, unknown> | null)?.[key];
  return (Array.isArray(value) ? value : []).map((v) => String(v ?? "").trim()).filter(Boolean).slice(0, 20);
};

export async function executeCourseTool(name: string, input: unknown, t: CourseToolContext): Promise<ToolOutcome> {
  const { ctx, session } = t;
  try {
    switch (name) {
      case "ajouter_produit": {
        const product = String((input as { nom?: unknown } | null)?.nom ?? "").trim();
        if (!product) return fail("Erreur : indiquez le nom du produit.");
        const result = await addProduct(ctx, session, { name: product });
        return ok(result.duplicate ? `Le produit « ${result.duplicate.name} » est déjà dans la liste : sa quantité passe à ${result.duplicate.quantity}.` : `« ${product} » est ajouté aux produits ajoutés de la liste.`);
      }
      case "marquer_achete": {
        const wanted = names(input, "produits");
        if (!wanted.length) return fail("Erreur : indiquez les produits achetés.");
        const open = await ctx.db
          .selectFrom("grocery_list_items")
          .select(["label", "name_key", "state"])
          .where("account_id", "=", t.accountId)
          .where("state", "in", ["validated", "added_after_validation"])
          .execute();
        const done: string[] = [];
        const missing: string[] = [];
        for (const w of wanted) {
          const hit = open.find((o) => listItemMatches(o.label, w));
          if (!hit) {
            missing.push(w);
            continue;
          }
          await setBought(ctx, session, { key: hit.name_key, bought: true, late: hit.state === "added_after_validation" });
          done.push(hit.label);
        }
        return ok(`${done.length ? `Marqués achetés (ils sortent de la liste et rejoignent l'historique) : ${done.join(", ")}.` : "Aucun produit marqué."}${missing.length ? ` Introuvables dans la liste validée : ${missing.join(", ")}.` : ""} Sans ticket, aucun prix n'est enregistré.`);
      }
      case "etat_liste": {
        const menu = await ctx.db.selectFrom("meal_menus").select(["id", "week_start"]).where("account_id", "=", t.accountId).orderBy("week_start", "desc").limit(1).executeTakeFirst();
        const list = menu ? await ctx.db.selectFrom("grocery_lists").select("id").where("account_id", "=", t.accountId).where("menu_id", "=", menu.id).executeTakeFirst() : undefined;
        const items = await ctx.db.selectFrom("grocery_list_items").select(["state"]).where("account_id", "=", t.accountId).execute();
        const count = (s: string) => items.filter((i) => i.state === s).length;
        return ok(
          JSON.stringify({
            menu_valide: !!menu,
            semaine_du_menu: menu ? String(menu.week_start).slice(0, 10) : null,
            liste_validee: !!list,
            produits_a_acheter: count("validated"),
            ajoutes_depuis_la_validation: count("added_after_validation"),
            produits_deja_achetes: count("bought"),
            en_preparation: count("preparing"),
          }),
        );
      }
      case "chiffres_budget": {
        if (t.access !== "couple") return fail("Erreur : le budget est réservé aux deux parents du couple.");
        const view = await budgetView(ctx, session);
        if (view.empty) return ok("Aucun ticket enregistré pour l'instant : le budget est vide. Il ne vient que des tickets enregistrés.");
        const top = [...view.budget.rows].sort((a, b) => b.lastMonth - a.lastMonth)[0];
        return ok(
          `Mois passé (${view.monthLabel}) : ${euro(view.budget.total.lastMonth)} au total. Rayon le plus dépensier : ${top.rayon} (${euro(top.lastMonth)}). Moyenne mensuelle de l'année : ${view.budget.total.currentYearAverage === null ? "pas encore de moyenne" : euro(view.budget.total.currentYearAverage)}. Le budget ne vient que des tickets enregistrés.`,
        );
      }
      case "ouvrir_ecran": {
        const key = String((input as { ecran?: unknown } | null)?.ecran ?? "") as ScreenKey;
        const screen = SCREENS[key];
        if (!screen) return fail("Erreur : écran inconnu.");
        if (screen.couple && t.access !== "couple") return fail("Erreur : cet écran est réservé aux deux parents du couple.");
        t.opened.add(key);
        return ok(`Écris le marqueur [[ecran:${key}]] dans ta réponse à l'endroit du lien « ${screen.label} ».`);
      }
      default:
        return fail("Erreur : outil inconnu.");
    }
  } catch (error) {
    const e = error as { message?: string; code?: string };
    if (e.code && typeof e.message === "string" && (e as { status?: number }).status) return fail(`Erreur : ${e.message}`);
    throw error;
  }
}

/** Contrôle d'accès commun aux outils. */
export async function toolContext(ctx: Ctx, session: SessionContext): Promise<CourseToolContext> {
  const who = await requireAccess(ctx, session, "list");
  return { ctx, session, access: who.access, accountId: who.accountId, opened: new Set() };
}

export { courseError };
