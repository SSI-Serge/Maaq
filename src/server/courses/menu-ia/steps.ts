import { sql } from "kysely";
import { z } from "zod";
import type { AssistantModel } from "@/server/assistant/model";
import { familyTimeZone } from "@/server/assistant/reminders";
import { asProfile } from "@/server/assistant/outings/profile";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { localDay } from "@/server/chat/service";
import { env } from "@/server/env";
import { courseError, requireAccess, translateCourseError } from "../household/settings";
import { checkWeek, menuOfWeek } from "../list/weeks";
import { MAX_STEPS, stepInput } from "./contract";
import { minutesFromSteps, resolveSteps, type ProposalStep } from "./proposal";
import { integerSetting } from "@/server/settings";
import { loadEntryIngredients, loadMenuEntries } from "./entries";

/**
 * Déroulé de la séance de batch écrit par l'IA, hors de la limite de menus (CR-57, US-156 RF6quater) : une seule réécriture à la validation d'un menu dont un plat a été remplacé, ou « Rédiger
 * le déroulé » quand le menu a été validé sans déroulé. Garde-fou : le plafond technique de demandes du foyer (une demande comptée). Si l'IA échoue, rien n'est écrit et la durée reste estimée.
 */

const stepsInput = z.strictObject({ etapes: z.array(stepInput).min(2).max(MAX_STEPS) });

const STEPS_TOOL = {
  name: "proposer_deroule",
  description: "Rend le déroulé de la séance de batch du dimanche pour les cinq dîners donnés : étapes numérotées dans l'ordre, avec le plat concerné, une durée, les chevauchements et la conservation de chaque plat.",
  input_schema: (() => {
    const schema = z.toJSONSchema(stepsInput, { io: "input" }) as Record<string, unknown>;
    delete schema.$schema;
    return schema;
  })(),
} as const;

const SYSTEM = [
  "Tu rédiges le déroulé de la séance de batch du dimanche d'un foyer, pour les dîners du lundi au vendredi, en appelant l'outil `proposer_deroule`.",
  "Des étapes numérotées dans l'ordre : ce qu'on lance en premier, ce qu'on prépare pendant les cuissons, puis la conservation de chaque plat.",
  "Chaque étape donne le plat concerné (nom EXACT d'un des plats donnés, vide pour une étape générale comme la préparation ou le nettoyage) et une durée approximative en minutes.",
  "Une étape qui se fait pendant une autre porte `en_meme_temps_que` : le rang d'une étape PRÉCÉDENTE.",
  "Termine par la conservation de chaque plat (`conservation` : frigo ou congelateur, et `jour_sortie` : 1 = lundi … 5 = vendredi) : une seule étape de conservation par plat.",
  "N'écris ni prix, ni quantité d'achat. Réponds uniquement par l'appel de l'outil.",
].join("\n");

export interface DeroulDish {
  name: string;
  minutes: number;
  ingredients: string[];
}

/** Une demande comptée dans le plafond technique du foyer ; faux quand il est atteint. */
async function registerRequest(ctx: Ctx, accountId: string, userId: string): Promise<boolean> {
  const day = localDay(ctx.now, await familyTimeZone(ctx.db, accountId));
  const accepted = await sql<{ accepted: boolean }>`select register_agent_request(${userId}::uuid, ${day}::date) as accepted`.execute(ctx.db);
  return !!accepted.rows[0]?.accepted;
}

/** Un essai, une seule demande : le déroulé vérifié par MAAQ (étapes cohérentes, plats connus), ou null. */
export async function draftSteps(model: AssistantModel, dishes: DeroulDish[]): Promise<ProposalStep[] | null> {
  try {
    const content = `Plats de la séance (lundi à vendredi) :\n${dishes.map((d, i) => `${i + 1}. ${d.name} — ${d.minutes} min — ${d.ingredients.slice(0, 14).join(", ")}`).join("\n")}`;
    const response = await model.send({ system: SYSTEM, tools: [STEPS_TOOL], messages: [{ role: "user", content }] });
    const use = response.content.find((b) => b.type === "tool_use" && b.name === STEPS_TOOL.name);
    if (!use || use.type !== "tool_use") return null;
    const parsed = stepsInput.safeParse(use.input);
    if (!parsed.success) return null;
    const errors: string[] = [];
    const steps = resolveSteps({ etapes: parsed.data.etapes }, dishes.map((d) => d.name), errors);
    if (errors.length) return null;
    return minutesFromSteps(steps, Math.max(0, ...dishes.map((d) => d.minutes))) === null ? null : steps;
  } catch (error) {
    console.error(`[courses] déroulé non écrit : ${error instanceof Error ? error.message : "erreur"}`);
    return null;
  }
}

export interface StepsDeps {
  model?: AssistantModel;
}

async function modelOf(deps: StepsDeps): Promise<AssistantModel | null> {
  if (deps.model) return deps.model;
  if (env().MENU_IA !== "live") return null;
  const { courseModel } = await import("../chat/service");
  try {
    return courseModel();
  } catch {
    return null;
  }
}

/** Réécriture à la validation d'un menu dont un plat a été remplacé : les étapes et la durée recalculées, ou null (durée estimée, pas de déroulé). */
export async function rewriteStepsOnValidation(ctx: Ctx, who: { accountId: string; userId: string }, dishes: DeroulDish[], deps: StepsDeps): Promise<{ steps: ProposalStep[]; minutes: number } | null> {
  const model = await modelOf(deps);
  if (!model) return null;
  if (!(await registerRequest(ctx, who.accountId, who.userId))) return null;
  const steps = await draftSteps(model, dishes);
  if (!steps) return null;
  const minutes = minutesFromSteps(steps, Math.max(0, ...dishes.map((d) => d.minutes)));
  return minutes === null ? null : { steps, minutes };
}

/** « Rédiger le déroulé » : le menu d'une semaine validé sans déroulé reçoit celui de l'IA. */
export async function writeMenuSteps(ctx: Ctx, session: SessionContext, week: string, deps: StepsDeps = {}): Promise<{ steps: number; minutes: number }> {
  const who = await requireAccess(ctx, session, "couple");
  const menu = await menuOfWeek(ctx.db, who.accountId, checkWeek(week, ctx.now) ?? "");
  if (!menu) throw courseError("no_menu", "Il n'y a pas de menu pour cette semaine.", 404);
  if (menu.batch_week_id !== null) throw courseError("has_steps", "Ce menu reprend une semaine type : son déroulé est celui du planning.", 409);
  const existing = await ctx.db.selectFrom("meal_menu_session_steps").select("id").where("menu_id", "=", menu.id).limit(1).execute();
  if (existing.length) throw courseError("has_steps", "Ce menu a déjà un déroulé.", 409);
  const model = await modelOf(deps);
  if (!model) throw courseError("assistant_unavailable", "La rédaction du déroulé n'est pas ouverte.", 409);

  const entries = (await loadMenuEntries(ctx.db, menu.id)).filter((e) => e.kind === "dinner").slice(0, 5);
  const ingredients = await loadEntryIngredients(ctx.db, entries.map((e) => e.id));
  const dishes: DeroulDish[] = entries.map((e) => ({ name: e.dish_name, minutes: e.duration_minutes ?? 30, ingredients: (ingredients.get(e.id) ?? []).map((i) => i.label) }));
  if (dishes.length < 2) throw courseError("not_enough_dishes", "Il faut au moins deux dîners pour rédiger le déroulé.", 422);
  if (!(await registerRequest(ctx, who.accountId, who.userId))) throw courseError("daily_cap_reached", "Vous avez atteint la limite de demandes pour aujourd'hui : vous pourrez reprendre demain.", 429);
  const steps = await draftSteps(model, dishes);
  const minutes = steps ? minutesFromSteps(steps, Math.max(0, ...dishes.map((d) => d.minutes))) : null;
  if (!steps || minutes === null) throw courseError("steps_failed", "Je n'ai pas réussi à rédiger le déroulé pour le moment. Vous pouvez réessayer.", 502);
  const entryOf = (name: string | null) => (name ? (entries.find((e) => e.dish_name === name)?.id ?? null) : null);
  try {
    await asProfile(ctx.db, who.userId, async (trx) => {
      await trx
        .insertInto("meal_menu_session_steps")
        .values(
          steps.map((s) => ({
            menu_id: menu.id,
            account_id: who.accountId,
            position: s.position,
            body: s.text,
            entry_id: entryOf(s.dish) as never,
            duration_minutes: s.minutes,
            overlaps_position: s.overlaps,
            storage_mode: s.storage,
            take_out_day: s.takeOutDay,
          })),
        )
        .execute();
      const cap = await integerSetting(trx, "meal_session_cap_minutes", 120);
      await trx.updateTable("meal_menus").set({ session_minutes: Math.min(Math.max(minutes, 1), 1000), session_is_estimated: true, session_over_cap: minutes > cap }).where("id", "=", menu.id).execute();
    });
  } catch (error) {
    throw translateCourseError(error);
  }
  return { steps: steps.length, minutes };
}
