import type { Kysely } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { requireAccess } from "./household/settings";
import { prepareList, type MenuSummary } from "./list/service";
import { addDaysIso, weekChoices, weekRange } from "./list/weeks";
import { addableDishes } from "./menu-ia/cards";

/**
 * « Menu de la semaine » (CR-72, US-180bis) : la carte en tête de l'accueil de Courses et repas, et l'écran du menu validé complet. Réservé au couple, comme le menu.
 * Tout vient des données du menu validé (meal_menus, meal_menu_entries), jamais de la conversation, qui est vidée à la validation.
 */

const SHORT_DAYS = ["Lun.", "Mar.", "Mer.", "Jeu.", "Ven.", "Sam.", "Dim."];
/** Jour de la semaine d'une date, 1 = lundi. */
const isoDow = (date: Date) => ((date.getDay() + 6) % 7) + 1;
/** « Lun. 9 » : le jour d'un dîner, d'après le lundi de la semaine et son rang (1 = lundi). */
export const dayLabel = (week: string, slot: number) => `${SHORT_DAYS[slot - 1] ?? ""} ${Number(addDaysIso(week, slot - 1).slice(8, 10))}`;

export interface HomeWeekMenu {
  /** Lundi de la semaine du menu montré. */
  week: string;
  /** Vrai quand la carte montre le menu de la semaine PROCHAINE, faute de menu pour la semaine en cours : « Menu de la semaine prochaine », avec ses 3 premiers dîners. */
  upcoming: boolean;
  /** « du 9 au 15 nov. » */
  range: string;
  dinners: number;
  express: number;
  /**
   * Les 3 prochains repas. Les dîners ont un jour (leur rang dans la semaine) : ceux d'aujourd'hui et des jours suivants, dans l'ordre, « Ce soir » pour celui du jour.
   * Les plats express n'ont pas de jour dans les données : ils ne complètent la liste, sans jour, que s'il reste moins de 3 dîners.
   */
  next: { day: string; name: string; express: boolean }[];
}

/**
 * La carte de l'accueil : le menu validé de la semaine en cours ; à défaut celui de la semaine prochaine (`upcoming`), pour que le menu qu'on vient de valider en fin de
 * semaine se retrouve bien en haut de l'accueil ; sinon rien.
 */
export async function homeWeekMenu(db: Kysely<DB>, accountId: string, week: string, now: Date, upcoming = false): Promise<HomeWeekMenu | null> {
  const menu = await db.selectFrom("meal_menus").select("id").where("account_id", "=", accountId).where("week_start", "=", week as never).executeTakeFirst();
  if (!menu) return null;
  const entries = await db.selectFrom("meal_menu_entries").select(["kind", "slot", "dish_name"]).where("menu_id", "=", menu.id).where("kind", "in", ["dinner", "express"] as never[]).orderBy("slot").execute();
  const dinners = entries.filter((e) => e.kind === "dinner");
  const express = entries.filter((e) => e.kind === "express");
  // Semaine prochaine : tous ses dîners sont à venir, aucun n'est « ce soir ».
  const today = upcoming ? 0 : isoDow(now);
  const next: HomeWeekMenu["next"] = dinners.filter((e) => e.slot >= today).map((e) => ({ day: e.slot === today ? "Ce soir" : dayLabel(week, e.slot), name: e.dish_name, express: false }));
  for (const e of express) if (next.length < 3) next.push({ day: "", name: e.dish_name, express: true });
  return { week, upcoming, range: weekRange(week), dinners: dinners.length, express: express.length, next: next.slice(0, 3) };
}

const MONTHS_FULL = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];
const MONTHS_SHORT = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

/** « 9 – 15 novembre » ; « 30 nov. – 6 décembre » quand la semaine change de mois (titre du passage d'une semaine à l'autre, CR-73). */
export function navTitle(week: string): string {
  const end = addDaysIso(week, 6);
  const [, m1, d1] = week.split("-").map(Number);
  const [, m2, d2] = end.split("-").map(Number);
  return m1 === m2 ? `${d1} – ${d2} ${MONTHS_FULL[m2 - 1]}` : `${d1} ${MONTHS_SHORT[m1 - 1]} – ${d2} ${MONTHS_FULL[m2 - 1]}`;
}

export interface WeekMenuView {
  /**
   * Semaines que l'on parcourt avec ‹ › (CR-73, US-180bis RF10) : la semaine en cours, même sans menu, puis chaque semaine à venir qui a un menu validé, dans l'ordre.
   * Une semaine sans menu entre deux semaines validées est sautée ; les semaines passées ne sont jamais proposées. `offset` : 0 cette semaine, 1 la prochaine, etc.
   */
  weeks: { week: string; offset: number; range: string; title: string; hasMenu: boolean }[];
  /** Semaine affichée (lundi). */
  week: string;
  /** Jour d'aujourd'hui (1 = lundi) quand la semaine affichée est la semaine en cours : sert à « Ce soir » et « Passé ». */
  today: number | null;
  /** Le menu validé de cette semaine, avec ses recettes et son déroulé ; `null` s'il n'y en a pas. */
  menu: MenuSummary | null;
  /** Plats du menu qui ne sont pas encore dans « Mes plats » : « Ajouter à mes plats » (clé `dinner:3`, `express:1`). */
  addable: { slot: string; name: string }[];
  /** Une liste de courses est validée pour ce menu. */
  listValidated: boolean;
}

/** L'écran « Menu de la semaine » : le menu validé de la semaine demandée, sinon de la première semaine à venir qui en a un, sinon la semaine en cours (sans menu). */
export async function weekMenuView(ctx: Ctx, session: SessionContext, requested?: string | null): Promise<WeekMenuView> {
  const who = await requireAccess(ctx, session, "couple");
  // Un menu ne se valide que pour la semaine en cours ou l'une des quatre suivantes : toutes les semaines à parcourir sont dans cette fenêtre.
  const choices = await weekChoices(ctx.db, who.accountId, ctx.now);
  const weeks = choices.map((c, offset) => ({ week: c.week, offset, range: c.range, title: navTitle(c.week), hasMenu: c.hasMenu })).filter((w) => w.offset === 0 || w.hasMenu);
  const week = weeks.find((t) => t.week === requested)?.week ?? weeks.find((t) => t.hasMenu)?.week ?? weeks[0].week;
  const today = week === weeks[0].week ? isoDow(ctx.now) : null;
  if (!weeks.find((t) => t.week === week)?.hasMenu) return { weeks, week, today, menu: null, addable: [], listValidated: false };
  const prepared = await prepareList(ctx, session, week);
  const menu = prepared.week === week ? prepared.menu : null;
  return { weeks, week, today, menu, addable: menu ? await addableDishes(ctx.db, who.accountId, week) : [], listValidated: menu ? prepared.validated : false };
}
