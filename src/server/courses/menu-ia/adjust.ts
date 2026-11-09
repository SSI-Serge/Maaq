import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { z } from "zod";
import type { AssistantModel } from "@/server/assistant/model";
import { familyTimeZone } from "@/server/assistant/reminders";
import { asProfile } from "@/server/assistant/outings/profile";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { localDay } from "@/server/chat/service";
import type { DB } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { decrypt, encrypt } from "@/server/security/crypto";
import { buildRefProducts, DAYS, estimateMinutes, listItemMatches, norm } from "../engine";
import { courseError, loadSettings, requireAccess, translateCourseError } from "../household/settings";
import { loadReferences } from "../list/data";
import { seedListFromMenu } from "../list/service";
import { weekLabel } from "../menu/weeks";
import { loadEngineData } from "../menu/data";
import { ADJUST_PREFIX } from "./cards";
import { dishInput } from "./contract";
import { applyNeedsToItems } from "./needs";
import { resolveDish, type ProposalDish } from "./proposal";
import { insertMenuEntry, reopenList } from "./validate";
import { Pseudonymizer } from "@/server/assistant/pseudonymize";
import { loadPseudoMembers } from "@/server/assistant/family";
import { ingredientText } from "../engine/quantities";

/**
 * Ajuster le menu après un ticket (CR-58, US-177) : après un ticket qui coche au moins un produit d'un menu validé, MAAQ compare les ingrédients du menu à ce qui est acheté (placards ignorés)
 * et écrit, dans le tchat, les ingrédients manquants plat par plat. « Ajuster le menu » demande à l'IA, pour chaque plat, un ingrédient de remplacement acheté ou un plat réalisable avec ce qui a été
 * acheté (elle reçoit le plat, les manquants et les noms des produits du ticket non prévus, sans prix, magasin ni date) ; chaque proposition s'accepte ou se refuse, et un plat accepté remplace l'ancien
 * dans le menu validé, la liste étant mise à jour comme à la validation (achats gardés). L'appel compte pour 1 dans la limite de menus et suit l'interrupteur MENU_IA (CR-43).
 */

const key = () => Buffer.from(env().ENCRYPTION_KEY, "base64");

export interface AdjustDish {
  /** « dinner:2 » : ligne du menu. */
  key: string;
  name: string;
  /** « mardi » ou « express ». */
  day: string;
  missing: string[];
}

export interface AdjustProposal {
  key: string;
  /** « Remplacer les aubergines par les courgettes achetées. » */
  explanation: string;
  dish: ProposalDish;
}

export interface AdjustEnvelope {
  card: "adjust";
  id: string;
  week: string;
  weekLabel: string;
  dishes: AdjustDish[];
  /** Noms des produits du ticket qui n'étaient pas prévus dans la liste (envoyés à l'IA, sans prix). */
  ticketProducts: string[];
  /** open : en attente ; later : « Je l'achèterai plus tard » ; proposed : propositions de l'IA ; closed : toutes décidées. */
  status: "open" | "later" | "proposed" | "closed";
  proposals: AdjustProposal[];
  decided: Record<string, "accepted" | "refused">;
  /** L'IA n'a rien pu proposer (réponse invalide ou refusée). */
  failed?: boolean;
}

export const isAdjustCard = (text: string) => text.startsWith(ADJUST_PREFIX);

export function parseAdjust(text: string): AdjustEnvelope | null {
  if (!isAdjustCard(text)) return null;
  try {
    const parsed = JSON.parse(text) as AdjustEnvelope;
    return parsed.card === "adjust" && parsed.id ? parsed : null;
  } catch {
    return null;
  }
}

/** Ce que le navigateur reçoit : la carte sans les noms de produits du ticket. */
export interface AdjustView extends Omit<AdjustEnvelope, "ticketProducts"> {
  messageId: string;
  /** « Ajuster le menu » est proposé : MENU_IA ouvert et carte en attente. */
  canAdjust: boolean;
}

export const adjustView = (messageId: string, e: AdjustEnvelope): AdjustView => {
  const { ticketProducts: _unused, ...rest } = e;
  void _unused;
  return { ...rest, messageId, canAdjust: env().MENU_IA === "live" && e.status === "open" };
};

/** Ingrédients des plats d'un menu validé qui ne sont pas achetés (produit coché « acheté » de ce menu) : placards ignorés, plat par plat. */
export async function missingIngredients(db: Kysely<DB>, accountId: string, menuId: string): Promise<AdjustDish[]> {
  const entries = (await db.selectFrom("meal_menu_entries").select(["id", "kind", "slot", "dish_name"]).where("menu_id", "=", menuId).where("kind", "in", ["dinner", "express"]).orderBy("kind").orderBy("slot").execute()).map((e) => ({ ...e, id: String(e.id) }));
  if (!entries.length) return [];
  const ings = await db
    .selectFrom("meal_menu_entry_ingredients")
    .select(["entry_id", "label", "name_key", "product_id", "unit"])
    .where("entry_id", "in", entries.map((e) => e.id) as never[])
    .orderBy("entry_id")
    .orderBy("position")
    .execute();
  const bought = await db.selectFrom("grocery_list_items").select(["label", "name_key", "product_id"]).where("account_id", "=", accountId).where("menu_id", "=", menuId).where("state", "=", "bought").execute();
  const productIds = [...new Set(ings.map((i) => i.product_id).filter((p): p is NonNullable<typeof p> => p !== null).map(String))];
  const pantry = new Set((productIds.length ? await db.selectFrom("grocery_products").select("id").where("id", "in", productIds as never[]).where("is_pantry", "=", true).execute() : []).map((p) => String(p.id)));
  const boughtKeys = new Set(bought.map((b) => b.name_key));
  const boughtProducts = new Set(bought.map((b) => (b.product_id === null ? "" : String(b.product_id))).filter(Boolean));
  const isBought = (i: (typeof ings)[number]) => boughtKeys.has(i.name_key) || (i.product_id !== null && boughtProducts.has(String(i.product_id))) || bought.some((b) => listItemMatches(b.label, i.label));
  const out: AdjustDish[] = [];
  for (const e of entries) {
    const missing = ings.filter((i) => String(i.entry_id) === e.id && i.unit !== "spoon" && i.unit !== "pinch" && !(i.product_id !== null && pantry.has(String(i.product_id))) && !isBought(i)).map((i) => i.label);
    if (missing.length) out.push({ key: `${e.kind}:${e.slot}`, name: e.dish_name, day: e.kind === "dinner" ? (DAYS[e.slot - 1] ?? "").toLowerCase() : "express", missing });
  }
  return out;
}

/** Après un ticket : la carte « ingrédients manquants » est rangée dans le tchat de la personne (fil de l'agent) ; null s'il ne manque rien. */
export async function postAdjustCard(ctx: Ctx, userId: string, accountId: string, menuId: string, ticketProducts: string[]): Promise<AdjustView | null> {
  if (env().MENU_IA !== "live") return null;
  const dishes = await missingIngredients(ctx.db, accountId, menuId);
  if (!dishes.length) return null;
  const menu = await ctx.db.selectFrom("meal_menus").select("week_start").where("id", "=", menuId).executeTakeFirstOrThrow();
  const week = typeof menu.week_start === "string" ? (menu.week_start as string).slice(0, 10) : `${(menu.week_start as Date).getFullYear()}-${String((menu.week_start as Date).getMonth() + 1).padStart(2, "0")}-${String((menu.week_start as Date).getDate()).padStart(2, "0")}`;
  const { conversationOf } = await import("../chat/service");
  const conversation = await conversationOf(ctx.db, accountId, userId, ctx.now);
  const envelope: AdjustEnvelope = { card: "adjust", id: randomUUID(), week, weekLabel: weekLabel(week), dishes, ticketProducts: [...new Set(ticketProducts)].slice(0, 40), status: "open", proposals: [], decided: {} };
  const row = await ctx.db
    .insertInto("agent_conversation_messages")
    .values({ conversation_id: conversation.id, sender: "agent", kind: "text", content: encrypt(JSON.stringify(envelope), key()), created_at: ctx.now })
    .returning("id")
    .executeTakeFirstOrThrow();
  return adjustView(String(row.id), envelope);
}

async function loadAdjust(db: Kysely<DB>, userId: string, messageId: string): Promise<{ id: string; envelope: AdjustEnvelope } | null> {
  if (!/^\d{1,18}$/.test(messageId)) return null;
  const row = await db
    .selectFrom("agent_conversation_messages as m")
    .innerJoin("agent_conversations as c", "c.id", "m.conversation_id")
    .select(["m.id", "m.content"])
    .where("m.id", "=", messageId as never)
    .where("c.user_id", "=", userId)
    .where("m.content", "is not", null)
    .executeTakeFirst();
  if (!row?.content) return null;
  const envelope = parseAdjust(decrypt(row.content, key()));
  return envelope ? { id: String(row.id), envelope } : null;
}

async function saveAdjust(db: Kysely<DB>, messageId: string, envelope: AdjustEnvelope): Promise<void> {
  await db.updateTable("agent_conversation_messages").set({ content: encrypt(JSON.stringify(envelope), key()) }).where("id", "=", messageId as never).execute();
}

async function openAdjust(ctx: Ctx, session: SessionContext, messageId: string) {
  const who = await requireAccess(ctx, session, "couple");
  const card = await loadAdjust(ctx.db, session.user.id, messageId);
  if (!card) throw courseError("card_not_found", "Cette proposition n'est plus disponible.", 404);
  return { who, card };
}

/** « Je l'achèterai plus tard » : rien n'est plus demandé pour ce ticket. */
export async function adjustLater(ctx: Ctx, session: SessionContext, messageId: string): Promise<AdjustView> {
  const { card } = await openAdjust(ctx, session, messageId);
  if (card.envelope.status !== "open") throw courseError("not_open", "Cette proposition n'est plus en attente.", 409);
  const envelope: AdjustEnvelope = { ...card.envelope, status: "later" };
  await saveAdjust(ctx.db, card.id, envelope);
  return adjustView(card.id, envelope);
}

const proposalsInput = z.strictObject({ propositions: z.array(dishInput.extend({ plat: z.string().trim().min(1).max(80), explication: z.string().trim().min(1).max(300) })).min(1).max(8) });

const ADJUST_TOOL = {
  name: "proposer_ajustement",
  description: "Rend, pour chaque plat à ajuster, UNE proposition : un ingrédient de remplacement acheté (le plat adapté, recette comprise) ou un plat réalisable avec ce qui a été acheté.",
  input_schema: (() => {
    const schema = z.toJSONSchema(proposalsInput, { io: "input" }) as Record<string, unknown>;
    delete schema.$schema;
    return schema;
  })(),
} as const;

const SYSTEM = [
  "Un foyer a acheté ses courses mais il manque des ingrédients pour certains plats de son menu. Tu appelles l'outil `proposer_ajustement` avec, pour CHAQUE plat donné, une seule proposition.",
  "Deux façons : un ingrédient de remplacement pris parmi les produits achetés (par exemple « Remplacer les aubergines par les courgettes achetées »), avec la recette adaptée ; ou un autre plat réalisable avec ce qui a été acheté.",
  "Pour chaque proposition : `plat` = nom EXACT du plat à ajuster, `explication` = une phrase, puis le plat complet : `nom`, `cuisine`, `duree_minutes`, `recette` et `ingredients` ({ nom, quantite, unite }) écrits pour le nombre de personnes du foyer.",
  "Respecte les régimes et les allergies du foyer. N'écris ni prix, ni magasin. Réponds uniquement par l'appel de l'outil.",
].join("\n");

async function registerMenu(ctx: Ctx, accountId: string, userId: string): Promise<boolean> {
  const day = localDay(ctx.now, await familyTimeZone(ctx.db, accountId));
  const row = await asProfile(ctx.db, userId, async (trx) => (await sql<{ ok: boolean }>`select register_meal_menu(${accountId}::uuid, ${day}::date, null) as ok`.execute(trx)).rows[0]);
  return row?.ok === true;
}

export interface AdjustDeps {
  model?: AssistantModel;
}

/** « Ajuster le menu » : un appel de l'IA, compté 1 dans la limite de menus. Chaque proposition est contrôlée (allergies, régimes) comme un plat du menu. */
export async function proposeAdjustments(ctx: Ctx, session: SessionContext, messageId: string, deps: AdjustDeps = {}): Promise<AdjustView> {
  const { who, card } = await openAdjust(ctx, session, messageId);
  const e = card.envelope;
  if (e.status !== "open") throw courseError("not_open", "Cette proposition n'est plus en attente.", 409);
  if (env().MENU_IA !== "live" && !deps.model) throw courseError("assistant_unavailable", "L'ajustement du menu n'est pas encore ouvert.", 409);
  let model = deps.model;
  if (!model) {
    const { courseModel } = await import("../chat/service");
    model = courseModel();
  }
  const settings = await loadSettings(ctx.db, who.accountId);
  const data = await loadEngineData(ctx.db, who.accountId, settings, { all: true });
  const cuisines = await ctx.db.selectFrom("meal_cuisines").select(["id", "name"]).execute();
  // le menu validé : plats à ajuster avec leurs ingrédients et leur recette
  const menu = await ctx.db.selectFrom("meal_menus").select("id").where("account_id", "=", who.accountId).where("week_start", "=", e.week as never).executeTakeFirst();
  if (!menu) throw courseError("no_menu", "Le menu de cette semaine n'existe plus.", 404);
  const entries = await ctx.db.selectFrom("meal_menu_entries").select(["id", "kind", "slot", "dish_name", "recipe"]).where("menu_id", "=", menu.id).execute();
  const ings = entries.length ? await ctx.db.selectFrom("meal_menu_entry_ingredients").select(["entry_id", "label", "quantity", "unit"]).where("entry_id", "in", entries.map((x) => x.id) as never[]).orderBy("position").execute() : [];
  const members = await loadPseudoMembers(ctx.db, who.accountId);
  const safe = (t: string) => new Pseudonymizer(members).toModel(t);
  const blocks = e.dishes.map((d) => {
    const [kind, slot] = d.key.split(":");
    const entry = entries.find((x) => x.kind === kind && String(x.slot) === slot);
    const lines = ings.filter((i) => entry && String(i.entry_id) === String(entry.id)).map((i) => ingredientText({ label: i.label, quantity: i.quantity === null ? null : Number(i.quantity), unit: i.unit }));
    return `Plat : ${safe(d.name)} (${d.day})\nIngrédients : ${lines.map(safe).join(", ")}\nRecette : ${safe((entry?.recipe ?? "").replace(/\s+/g, " ").slice(0, 600)) || "non renseignée"}\nIngrédients non achetés : ${d.missing.join(", ")}`;
  });
  const content = [
    `<foyer>\nNombre de personnes : ${settings.householdSize ?? 4}\nRégimes : ${settings.diets.join(", ") || "aucun"}\nAllergies : ${[...settings.allergens, ...settings.allergyText.split(/[,;\n]/).map((s) => safe(s.trim())).filter(Boolean)].join(", ") || "aucune"}\nCuisines du catalogue : ${cuisines.map((c) => c.name).join(", ")}\n</foyer>`,
    `Produits du ticket qui n'étaient pas prévus dans la liste : ${e.ticketProducts.join(", ") || "aucun"}`,
    ...blocks,
  ].join("\n\n");

  if (!(await registerMenu(ctx, who.accountId, who.userId))) throw courseError("limit_reached", "Vous avez atteint la limite de menus pour aujourd'hui : vous pourrez reprendre demain.", 429);
  const proposals: AdjustProposal[] = [];
  let failed = false;
  try {
    const response = await model.send({ system: SYSTEM, tools: [ADJUST_TOOL], messages: [{ role: "user", content }] });
    const use = response.content.find((b) => b.type === "tool_use" && b.name === ADJUST_TOOL.name);
    const parsed = use && use.type === "tool_use" ? proposalsInput.safeParse(use.input) : null;
    if (!parsed?.success) failed = true;
    else {
      for (const p of parsed.data.propositions) {
        const target = e.dishes.find((d) => norm(d.name) === norm(p.plat));
        if (!target || proposals.some((x) => x.key === target.key)) continue;
        const errors: string[] = [];
        const { plat: _plat, explication, ...dish } = p;
        void _plat;
        const resolved = resolveDish(dish, { data, cuisines, householdSize: settings.householdSize, now: ctx.now, newId: randomUUID }, e.week, errors, "Plat");
        if (resolved && !resolved.blockers.length) proposals.push({ key: target.key, explanation: explication, dish: resolved });
      }
      failed = proposals.length === 0;
    }
  } catch (error) {
    console.error(`[courses] ajustement non proposé : ${error instanceof Error ? error.message : "erreur"}`);
    failed = true;
  }
  const next: AdjustEnvelope = { ...e, status: failed ? "open" : "proposed", proposals, failed: failed || undefined };
  await saveAdjust(ctx.db, card.id, next);
  return adjustView(card.id, next);
}

/**
 * Accepte ou refuse la proposition d'un plat. Accepter remplace le plat dans le menu validé (recette, quantités, durée) et met la liste à jour comme à la validation d'un menu : les produits achetés sont
 * gardés, le reste est recalculé et la page « Liste de courses » se rouvre pour être validée de nouveau. Refuser garde le plat.
 */
export async function decideAdjustment(ctx: Ctx, session: SessionContext, input: { messageId: string; key: string; accept: boolean }): Promise<AdjustView> {
  const { who, card } = await openAdjust(ctx, session, input.messageId);
  const e = card.envelope;
  const proposal = e.proposals.find((p) => p.key === input.key);
  if (e.status !== "proposed" || !proposal || e.decided[input.key]) throw courseError("not_open", "Cette proposition n'est plus en attente.", 409);
  if (input.accept) {
    const [kind, slotText] = input.key.split(":");
    const slot = Number(slotText);
    const engine = await loadEngineData(ctx.db, who.accountId, await loadSettings(ctx.db, who.accountId), { all: true });
    const refs = engine.refs;
    const prods = buildRefProducts((await loadReferences(ctx.db)).rows);
    try {
      await asProfile(ctx.db, who.userId, async (trx) => {
        const menu = await trx.selectFrom("meal_menus").select("id").where("account_id", "=", who.accountId).where("week_start", "=", e.week as never).executeTakeFirst();
        if (!menu) throw courseError("no_menu", "Le menu de cette semaine n'existe plus.", 404);
        const old = await trx.selectFrom("meal_menu_entries").select("id").where("menu_id", "=", menu.id).where("kind", "=", kind as never).where("slot", "=", slot).executeTakeFirst();
        if (!old) throw courseError("invalid_dish", "Ce plat n'existe plus dans le menu.", 404);
        await trx.deleteFrom("meal_menu_entries").where("id", "=", old.id).execute();
        await insertMenuEntry(trx, who.accountId, menu.id, kind as "dinner" | "express", slot, proposal.dish, refs, prods);
        // la liste se rouvre comme à la validation d'un menu : achats et ajouts à la main gardés, le reste recalculé (US-156 RF7)
        await trx.updateTable("meal_menus").set({ validated_at: ctx.now }).where("id", "=", menu.id).execute();
        await reopenList(trx, who.accountId, menu.id, ctx.now);
        const entries = await trx.selectFrom("meal_menu_entries").select(["id", "dish_name"]).where("menu_id", "=", menu.id).orderBy("kind").orderBy("slot").execute();
        const lines = await trx.selectFrom("meal_menu_entry_ingredients").select(["entry_id", "label"]).where("entry_id", "in", entries.map((x) => x.id) as never[]).orderBy("position").execute();
        const dishes = entries.map((x) => ({ id: "", cuisine: "", name: x.dish_name, ing: lines.filter((l) => String(l.entry_id) === String(x.id)).map((l) => l.label).join(", "), recipe: "", health: "", batch: "", time: "", minutes: 0, tags: new Set<string>() }));
        await seedListFromMenu(trx, who.accountId, who.userId, menu.id, dishes, { repeat: true });
        await applyNeedsToItems(trx, who.accountId, menu.id);
        // un des cinq plats de la séance change : son déroulé est effacé, la durée repasse à la formule et « Déroulé à mettre à jour » est proposé avec « Rédiger le déroulé » (US-177 RF3)
        if (kind === "dinner" && slot <= 5) {
          await trx.deleteFrom("meal_menu_session_steps").where("menu_id", "=", menu.id).execute();
          const first = await trx.selectFrom("meal_menu_entries").select(["slot", "duration_minutes", "dish_id", "household_dish_id"]).where("menu_id", "=", menu.id).where("kind", "=", "dinner").where("slot", "<=", 5).orderBy("slot").execute();
          const minutesOf = (e: (typeof first)[number]) => {
            if (e.duration_minutes) return e.duration_minutes;
            const code = e.household_dish_id ? `H:${e.household_dish_id}` : e.dish_id ? ([...engine.refs].find(([, r]) => r.kind === "catalog" && r.dishId === String(e.dish_id))?.[0] ?? null) : null;
            return engine.dishes.find((d) => d.id === code)?.minutes ?? 30;
          };
          const minutes = Math.round(estimateMinutes(first.map((e) => ({ minutes: minutesOf(e) }))));
          await trx.updateTable("meal_menus").set({ batch_week_id: null, session_minutes: Math.min(Math.max(minutes, 1), 1000), session_is_estimated: true, session_over_cap: minutes > engine.sessionCap }).where("id", "=", menu.id).execute();
        }
      });
    } catch (error) {
      throw translateCourseError(error);
    }
  }
  const decided = { ...e.decided, [input.key]: input.accept ? ("accepted" as const) : ("refused" as const) };
  const next: AdjustEnvelope = { ...e, decided, status: e.proposals.every((p) => decided[p.key]) ? "closed" : "proposed" };
  await saveAdjust(ctx.db, card.id, next);
  return adjustView(card.id, next);
}
