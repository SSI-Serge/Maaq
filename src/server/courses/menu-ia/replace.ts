import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { norm } from "../engine";
import { courseError, loadSettings, requireAccess } from "../household/settings";
import { loadEngineData } from "../menu/data";
import { hasNewerCard, cardView, loadCard, updateCardProposal, validatedWeeks, type CardView } from "./cards";
import { INPUT_OF_UNIT, refreshProposal, resolveDish, type MenuProposal, type ProposalDish } from "./proposal";

/**
 * Remplacer un plat de la carte sans IA (CR-57, US-156 RF6quater) : MAAQ le fait seul, sur la carte encore ouverte du tchat, sans appel au modèle et sans compter dans la limite de menus.
 * Trois groupes : le plat express prend la place du dîner (et le dîner devient plat express), deux plats du menu échangent leur jour, un plat de « Mes plats » remplace celui du menu.
 * Un plat de « Mes plats » reprend les quantités du dernier menu validé où il figurait, ramenées au nombre de personnes du foyer ; sans quantités connues, ses ingrédients passent en
 * « Quantité à vérifier ». Les contrôles (allergies, régimes, répétition) sont refaits, la durée de la séance recalculée, le déroulé marqué « à mettre à jour ».
 */

export type ReplaceKind = "dinner" | "express";

export interface ReplaceOptions {
  /** Pour un dîner : les plats express du menu (le dîner prend leur place). */
  express: { index: number; name: string }[];
  /** Les dîners du menu avec lesquels échanger (le jour change). */
  dinners: { index: number; name: string }[];
  /** Plats de « Mes plats » qui ne sont pas déjà dans le menu. */
  own: { id: string; name: string }[];
}

export type ReplaceChoice = { group: "express"; index: number } | { group: "dinners"; index: number } | { group: "own"; dishId: string };

async function openCard(ctx: Ctx, session: SessionContext, messageId: string) {
  const who = await requireAccess(ctx, session, "couple");
  const card = await loadCard(ctx.db, session.user.id, messageId);
  if (!card) throw courseError("card_not_found", "Ce menu n'est plus disponible : demandez-en un nouveau.", 404);
  if (card.envelope.validatedAt) throw courseError("already_validated", "Ce menu est déjà validé.", 409);
  if (await hasNewerCard(ctx.db, card.conversationId, card.id, card.envelope.proposal.week)) throw courseError("menu_replaced", "Menu remplacé : modifiez le dernier menu proposé.", 409);
  return { who, card };
}

const position = (proposal: MenuProposal, kind: ReplaceKind, index: number): ProposalDish => {
  const dish = (kind === "dinner" ? proposal.dinners : proposal.express)[index];
  if (!dish) throw courseError("invalid_dish", "Ce plat n'existe plus dans le menu.", 422);
  return dish;
};

/** Plats de « Mes plats » du foyer qui ne sont pas déjà dans le menu. */
async function ownCandidates(ctx: Ctx, accountId: string, proposal: MenuProposal): Promise<{ id: string; name: string }[]> {
  const settings = await loadSettings(ctx.db, accountId);
  const data = await loadEngineData(ctx.db, accountId, settings, { all: true });
  const inMenu = new Set([...proposal.dinners, ...proposal.express].map((d) => norm(d.name)));
  return data.dishes.filter((d) => d.mine && !inMenu.has(norm(d.name))).map((d) => ({ id: d.id, name: d.name }));
}

export async function replaceOptions(ctx: Ctx, session: SessionContext, input: { messageId: string; kind: ReplaceKind; index: number }): Promise<ReplaceOptions> {
  const { who, card } = await openCard(ctx, session, input.messageId);
  const p = card.envelope.proposal;
  position(p, input.kind, input.index);
  return {
    express: input.kind === "dinner" ? p.express.map((d, index) => ({ index, name: d.name })) : [],
    dinners: p.dinners.map((d, index) => ({ index, name: d.name })).filter((d) => !(input.kind === "dinner" && d.index === input.index)),
    own: await ownCandidates(ctx, who.accountId, p),
  };
}

/** Quantités d'un plat de « Mes plats » : celles de son dernier menu validé, ramenées au foyer ; vide si aucun menu validé ne les donne. */
export async function lastOwnQuantities(db: Kysely<DB>, accountId: string, householdDishId: string, householdSize: number | null): Promise<{ nom: string; quantite?: number; unite?: string }[]> {
  const entry = await db
    .selectFrom("meal_menu_entries as e")
    .innerJoin("meal_menus as m", "m.id", "e.menu_id")
    .select(["e.id", "m.servings", "m.week_start"])
    .where("e.account_id", "=", accountId)
    .where("e.household_dish_id", "=", householdDishId as never)
    .orderBy("m.week_start", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!entry) return [];
  const rows = await db.selectFrom("meal_menu_entry_ingredients").select(["label", "quantity", "unit"]).where("entry_id", "=", entry.id).orderBy("position").execute();
  const factor = householdSize && entry.servings ? householdSize / entry.servings : 1;
  return rows.map((r) => {
    if (r.quantity === null || !r.unit || !(r.unit in INPUT_OF_UNIT)) return { nom: r.label };
    const scaled = Number(r.quantity) * factor;
    const amount = r.unit === "piece" ? Math.max(0.5, Math.round(scaled * 2) / 2) : scaled >= 100 ? Math.round(scaled / 10) * 10 : Math.round(scaled * 10) / 10;
    return { nom: r.label, quantite: amount, unite: INPUT_OF_UNIT[r.unit] };
  });
}

export async function replaceDish(ctx: Ctx, session: SessionContext, input: { messageId: string; kind: ReplaceKind; index: number; choice: ReplaceChoice }): Promise<CardView> {
  const { who, card } = await openCard(ctx, session, input.messageId);
  const p = card.envelope.proposal;
  const dinners = [...p.dinners];
  const express = [...p.express];
  const old = position(p, input.kind, input.index);
  const c = input.choice;

  if (c.group === "express") {
    if (input.kind !== "dinner") throw courseError("invalid_choice", "Un plat express ne se remplace pas par un plat express.", 422);
    const other = express[c.index];
    if (!other) throw courseError("invalid_dish", "Ce plat express n'existe plus dans le menu.", 422);
    dinners[input.index] = other;
    express[c.index] = old;
  } else if (c.group === "dinners") {
    const other = dinners[c.index];
    if (!other || (input.kind === "dinner" && c.index === input.index)) throw courseError("invalid_dish", "Ce dîner n'existe plus dans le menu.", 422);
    if (input.kind === "dinner") {
      dinners[input.index] = other;
      dinners[c.index] = old;
    } else {
      dinners[c.index] = old;
      express[input.index] = other;
    }
  } else {
    const settings = await loadSettings(ctx.db, who.accountId);
    const data = await loadEngineData(ctx.db, who.accountId, settings, { all: true });
    const known = data.dishes.find((d) => d.id === c.dishId && d.mine);
    if (!known || data.refs.get(known.id)?.kind !== "household") throw courseError("invalid_dish", "Ce plat n'est pas dans « Mes plats ».", 422);
    if ([...dinners, ...express].some((d) => d !== old && norm(d.name) === norm(known.name))) throw courseError("duplicate_dish", "Ce plat est déjà dans le menu.", 422);
    const cuisines = await ctx.db.selectFrom("meal_cuisines").select(["id", "name"]).execute();
    const refId = data.refs.get(known.id)!.dishId;
    const quantities = await lastOwnQuantities(ctx.db, who.accountId, refId, settings.householdSize);
    const errors: string[] = [];
    const resolved = resolveDish({ plat_id: known.id, nom: known.name, ingredients: quantities.length ? quantities : undefined } as never, { data, cuisines, householdSize: settings.householdSize, now: ctx.now, newId: randomUUID }, p.week, errors, "Plat");
    if (!resolved) throw courseError("invalid_dish", errors.join(" "), 422);
    if (input.kind === "dinner") dinners[input.index] = resolved;
    else express[input.index] = resolved;
  }

  const next = refreshProposal(p, dinners, express);
  await updateCardProposal(ctx.db, card.id, card.envelope, next);
  const replacesValidated = (await validatedWeeks(ctx.db, who.accountId, [next.week])).size > 0;
  return cardView(card.id, { ...card.envelope, proposal: next }, false, replacesValidated);
}
