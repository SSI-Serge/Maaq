import type { Ctx, SessionContext } from "@/server/auth/service";
import { Rejection } from "@/server/http";

/** « Mes informations » des Réglages : prénom et nom ; l'email de connexion n'y est pas modifiable (US-12 RF7). */

export interface MyProfile {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: "primary_user" | "guest" | "admin";
  guestRank: "core" | "secondary" | null;
}

export async function getMyProfile(ctx: Ctx, session: SessionContext): Promise<MyProfile> {
  const me = await ctx.db
    .selectFrom("users")
    .select(["id", "first_name", "last_name", "email", "role", "guest_rank"])
    .where("id", "=", session.user.id)
    .executeTakeFirstOrThrow();
  return { id: me.id, firstName: me.first_name, lastName: me.last_name, email: me.email, role: me.role, guestRank: me.guest_rank };
}

export async function updateMyNames(ctx: Ctx, session: SessionContext, input: { firstName: string; lastName: string }): Promise<MyProfile> {
  const errors: Record<string, string> = {};
  if (!input.firstName.trim()) errors.firstName = "Ce champ est obligatoire";
  if (!input.lastName.trim()) errors.lastName = "Ce champ est obligatoire";
  if (input.firstName.trim().length > 100 || input.lastName.trim().length > 100) errors.lastName = "100 caractères au maximum";
  if (Object.keys(errors).length) throw new Rejection("invalid_info", "Certaines informations sont à corriger.", 422, errors);
  await ctx.db
    .updateTable("users")
    .set({ first_name: input.firstName.trim(), last_name: input.lastName.trim(), updated_at: ctx.now })
    .where("id", "=", session.user.id)
    .execute();
  return getMyProfile(ctx, session);
}
