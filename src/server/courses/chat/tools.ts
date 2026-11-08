import type { Ctx, SessionContext } from "@/server/auth/service";
import { budgetView } from "../budget";
import { listItemMatches } from "../engine";
import { courseError, requireAccess, type CourseAccess } from "../household/settings";
import { setBought } from "../list/mine";
import { addProduct } from "../list/service";
import { euro } from "../console/util";
import { sql } from "kysely";
import { asProfile } from "@/server/assistant/outings/profile";
import { familyTimeZone } from "@/server/assistant/reminders";
import { localDay } from "@/server/chat/service";
import { env } from "@/server/env";
import { randomUUID } from "node:crypto";
import { loadSettings } from "../household/settings";
import { lastReceiptProducts } from "../tickets/service";
import { menuInput } from "../menu-ia/contract";
import { loadMenuContext, type MenuContext } from "../menu-ia/context";
import { buildProposal, type MenuProposal } from "../menu-ia/proposal";
import { SCREENS, type ScreenKey } from "./screens";

/** Essais invalides de `proposer_menu` acceptés avant d'abandonner (CR-44) : au deuxième, la demande échoue avec « Réessayer ». */
export const MAX_INVALID_MENUS = 2;

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
  /** Menu composé par l'IA dans cette demande (CR-42). */
  menu: { invalid: number; aborted: boolean; limitReached: boolean; proposal: MenuProposal | null; context: MenuContext | null };
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
      case "preparer_menu": {
        const refused = menuRefusal(t);
        if (refused) return fail(refused);
        const settings = await loadSettings(ctx.db, t.accountId);
        if (settings.missing.length) return fail("Erreur : les réglages du foyer ne sont pas complets. Invite à ouvrir l'écran de réglages avant de composer un menu.");
        t.menu.context = await loadMenuContext(ctx.db, t.accountId, settings, ctx.now);
        return ok(t.menu.context.text);
      }
      case "produits_achetes": {
        const refused = menuRefusal(t);
        if (refused) return fail(refused);
        const names = await lastReceiptProducts(ctx, t.accountId);
        return ok(names.length ? `Produits du dernier ticket enregistré (sans prix, magasin ni date) : ${names.join(" ; ")}.` : "Aucun ticket enregistré : demande à la personne ce qu'elle vient d'acheter.");
      }
      case "proposer_menu": {
        const refused = menuRefusal(t);
        if (refused) return fail(refused);
        const parsed = menuInput.safeParse(input);
        if (!parsed.success) return invalidMenu(t, parsed.error.issues.map((i) => `${i.path.join(".") || "menu"} : ${i.message}`));
        if (!t.menu.context) {
          const settings = await loadSettings(ctx.db, t.accountId);
          if (settings.missing.length) return fail("Erreur : les réglages du foyer ne sont pas complets.");
          t.menu.context = await loadMenuContext(ctx.db, t.accountId, settings, ctx.now);
        }
        const built = buildProposal(parsed.data, { data: t.menu.context.data, cuisines: t.menu.context.cuisines, householdSize: t.menu.context.householdSize, now: ctx.now, newId: randomUUID });
        if (!built.ok) return invalidMenu(t, built.errors);
        // plafond de menus complets par foyer et par jour, corrections comprises (CR-44) : seul un menu valide est compté
        if (!(await registerMenu(t))) {
          t.menu.limitReached = true;
          return fail("Erreur : la limite de menus du jour est atteinte pour ce foyer. Dis seulement qu'il pourra reprendre demain.");
        }
        t.menu.proposal = built.proposal;
        return ok(menuSummary(built.proposal));
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

/** Compte un menu pour le foyer et le jour (fuseau de la famille) ; faux si le plafond du jour est atteint. Atomique côté base (register_meal_menu). */
async function registerMenu(t: CourseToolContext): Promise<boolean> {
  const day = localDay(t.ctx.now, await familyTimeZone(t.ctx.db, t.accountId));
  const row = await asProfile(t.ctx.db, t.session.user.id, async (trx) => (await sql<{ ok: boolean }>`select register_meal_menu(${t.accountId}::uuid, ${day}::date, null) as ok`.execute(trx)).rows[0]);
  return row?.ok === true;
}

function menuRefusal(t: CourseToolContext): string | null {
  if (t.access !== "couple") return "Erreur : la composition du menu est réservée aux deux parents du couple.";
  if (env().MENU_IA !== "live") return "Erreur : la composition du menu par l'agent n'est pas encore ouverte. Renvoie vers l'écran « Liste de courses ».";
  return null;
}

function invalidMenu(t: CourseToolContext, problems: string[]): ToolOutcome {
  t.menu.invalid += 1;
  if (t.menu.invalid >= MAX_INVALID_MENUS) t.menu.aborted = true;
  return fail(["Menu refusé par MAAQ :", ...problems.slice(0, 12).map((p) => `- ${p}`), "Corrige et rappelle proposer_menu avec le menu COMPLET."].join("\n"));
}

/** Ce que le modèle apprend du menu enregistré : il le résume en une ou deux phrases, la carte est affichée par MAAQ. */
export function menuSummary(p: MenuProposal): string {
  const all = [...p.dinners, ...p.express];
  const served = all.filter((d) => d.servedOn).map((d) => `${d.name} (déjà servi le ${d.servedOn})`);
  const conflicts = all.flatMap((d) => d.blockers);
  const warnings = all.flatMap((d) => d.warnings.map((w) => `${d.name} : ${w}`));
  const source = p.session.source === "plan" ? "durée de la semaine type" : p.session.source === "steps" ? "durée estimée par MAAQ d'après le déroulé" : "durée estimée par MAAQ (formule), le déroulé manquait ou était incohérent";
  return [
    `Menu enregistré pour la semaine du ${p.week} : ${p.dinners.length} dîners, ${p.express.length} plats express${p.complete ? "" : " (INCOMPLET : il manque des dîners, pas de bouton « Valider le menu »)"}.`,
    `Séance de batch : ${p.session.minutes} min (${source})${p.session.overCap ? `, AU-DESSUS du plafond de ${p.session.cap} min : dis-le` : ""}.`,
    p.express.length < 4 ? `Il manque ${4 - p.express.length} plat(s) express : rappelle proposer_menu avec 4 plats express, qui reprennent des ingrédients du menu.` : "",
    served.length ? `Déjà servis récemment : ${served.join(" ; ")}. L'utilisateur peut les garder.` : "",
    conflicts.length ? `CONFLITS D'ALLERGIE OU DE RÉGIME (validation impossible) : ${conflicts.join(" ; ")}. Remplace ces plats et rappelle proposer_menu.` : "",
    warnings.length ? `Avertissements affichés sur les plats : ${warnings.join(" ; ")}.` : "",
    "MAAQ affiche le menu en carte avec le bouton « Valider le menu » : n'écris PAS le menu en entier dans ta réponse. Résume en une ou deux phrases, signale la durée de la séance, les répétitions et les avertissements, et propose de corriger.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Contrôle d'accès commun aux outils. */
export async function toolContext(ctx: Ctx, session: SessionContext): Promise<CourseToolContext> {
  const who = await requireAccess(ctx, session, "list");
  return { ctx, session, access: who.access, accountId: who.accountId, opened: new Set(), menu: { invalid: 0, aborted: false, limitReached: false, proposal: null, context: null } };
}

export { courseError };
