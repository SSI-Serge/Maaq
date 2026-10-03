import type { Ctx, SessionContext } from "@/server/auth/service";
import { recordCoreGuest, type GuestInput } from "@/server/guests/service";
import { Rejection } from "@/server/http";

/**
 * Configuration initiale de l'utilisateur principal en deux étapes (US-10 RF1, US-11) :
 * « Mes informations », puis « Informations de mon invité » (facultative).
 * L'étape atteinte est enregistrée : le parcours reprend là où il s'est arrêté (US-10 RF7).
 */

export interface SetupState {
  step: "step_1_my_info" | "step_2_guest_info" | "completed";
  me: { firstName: string; lastName: string; email: string };
  coreGuest: { firstName: string; lastName: string; email: string; phone: string | null; invited: boolean } | null;
}

function requireSetupProfile(session: SessionContext) {
  if (session.user.role !== "primary_user" || !session.user.accountId) {
    throw new Rejection("forbidden", "La configuration initiale concerne l'utilisateur principal.", 403);
  }
  return session.user.accountId;
}

export async function getSetup(ctx: Ctx, session: SessionContext): Promise<SetupState> {
  const accountId = requireSetupProfile(session);
  const me = await ctx.db
    .selectFrom("users")
    .select(["first_name", "last_name", "email", "initial_setup_step"])
    .where("id", "=", session.user.id)
    .executeTakeFirstOrThrow();
  const core = await ctx.db
    .selectFrom("users")
    .select(["id", "first_name", "last_name", "email", "phone", "status"])
    .where("account_id", "=", accountId)
    .where("guest_rank", "=", "core")
    .where("status", "<>", "removed")
    .executeTakeFirst();
  const invited = core
    ? (await ctx.db.selectFrom("activation_links").select("id").where("user_id", "=", core.id).executeTakeFirst()) !== undefined ||
      core.status !== "pending_activation"
    : false;
  return {
    step: me.initial_setup_step ?? "completed",
    me: { firstName: me.first_name, lastName: me.last_name, email: me.email },
    coreGuest: core ? { firstName: core.first_name, lastName: core.last_name, email: core.email, phone: core.phone, invited } : null,
  };
}

/** Étape 1 : prénom et nom (l'email de connexion est affiché, non modifiable : US-10 RF3). */
export async function saveMyInfo(ctx: Ctx, session: SessionContext, input: { firstName: string; lastName: string }): Promise<void> {
  requireSetupProfile(session);
  const errors: Record<string, string> = {};
  if (!input.firstName.trim()) errors.firstName = "Ce champ est obligatoire";
  if (!input.lastName.trim()) errors.lastName = "Ce champ est obligatoire";
  if (Object.keys(errors).length) throw new Rejection("invalid_info", "Certaines informations sont à corriger.", 422, errors);
  await ctx.db
    .updateTable("users")
    .set((eb) => ({
      first_name: input.firstName.trim(),
      last_name: input.lastName.trim(),
      updated_at: ctx.now,
      // N'avance que depuis l'étape 1 : modifier ses informations plus tard ne relance pas le parcours.
      initial_setup_step: eb
        .case()
        .when("initial_setup_step", "=", "step_1_my_info")
        .then("step_2_guest_info" as const)
        .else(eb.ref("initial_setup_step"))
        .end(),
    }))
    .where("id", "=", session.user.id)
    .execute();
}

/**
 * Étape 2 : l'invité 1, ou « Passer cette étape ». Dans les deux cas, la configuration est
 * terminée (US-11 RF1, RF8). Renseigner l'invité n'envoie pas l'invitation (RF3).
 */
export async function completeSetup(ctx: Ctx, session: SessionContext, guest: GuestInput | null): Promise<void> {
  requireSetupProfile(session);
  if (guest) await recordCoreGuest(ctx, session, guest);
  await ctx.db
    .updateTable("users")
    .set({ initial_setup_step: "completed", updated_at: ctx.now })
    .where("id", "=", session.user.id)
    .execute();
}
