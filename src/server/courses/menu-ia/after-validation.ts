import type { Ctx, SessionContext } from "@/server/auth/service";
import { describeError } from "@/server/safe-log";
import { clearAfterValidation } from "../chat/erase";
import { monthValidate, type MonthValidated } from "../month/service";
import { validateMenuCard, type ValidatedMenuCard } from "./validate";
import type { StepsDeps } from "./steps";

/**
 * Les deux validations d'un menu telles que l'écran les demande (CR-72, US-180bis) : le menu est validé, puis la conversation du profil avec l'agent Courses et repas est
 * vidée. L'effacement ne fait jamais échouer une validation réussie : s'il ne peut pas se faire (réponse en cours, panne), la conversation reste et le menu est validé.
 */
async function clear(ctx: Ctx, session: SessionContext): Promise<boolean> {
  try {
    const done = await clearAfterValidation(ctx, session.user.id);
    return !done.skipped;
  } catch (error) {
    console.error(`Conversation non vidée après la validation du menu : ${describeError(error)}`);
    return false;
  }
}

/** « Valider le menu » ou « Remplacer le menu » de la semaine. `cleared` : la conversation a été vidée. */
export async function validateWeekMenu(ctx: Ctx, session: SessionContext, messageId: string, deps: StepsDeps = {}): Promise<ValidatedMenuCard & { cleared: boolean }> {
  const result = await validateMenuCard(ctx, session, messageId, deps);
  return { ...result, cleared: await clear(ctx, session) };
}

/** Validation des menus du « Menu du mois dans le budget » : la proposition du mois, cachée dans le même fil, est gardée. */
export async function validateMonthMenus(ctx: Ctx, session: SessionContext, input: { messageId: string; keep?: string[] }): Promise<MonthValidated & { cleared: boolean }> {
  const result = await monthValidate(ctx, session, input);
  return { ...result, cleared: await clear(ctx, session) };
}
