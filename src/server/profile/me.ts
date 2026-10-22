import type { Ctx, SessionContext } from "@/server/auth/service";
import { Rejection } from "@/server/http";

/** « Mes informations » des Réglages : prénom, nom et code postal ; l'email de connexion n'y est pas modifiable (US-12 RF7). */

export interface MyProfile {
  id: string;
  firstName: string;
  lastName: string;
  /** Zone approximative, jamais une adresse : sert par défaut aux suggestions de services (marketplace silencieux). */
  postcode: string | null;
  email: string;
  role: "primary_user" | "guest" | "admin";
  guestRank: "core" | "secondary" | null;
}

export async function getMyProfile(ctx: Ctx, session: SessionContext): Promise<MyProfile> {
  const me = await ctx.db
    .selectFrom("users")
    .select(["id", "first_name", "last_name", "postcode", "email", "role", "guest_rank"])
    .where("id", "=", session.user.id)
    .executeTakeFirstOrThrow();
  return { id: me.id, firstName: me.first_name, lastName: me.last_name, postcode: me.postcode, email: me.email, role: me.role, guestRank: me.guest_rank };
}

const POSTCODE = /^\d{5}$/;

export async function updateMyNames(ctx: Ctx, session: SessionContext, input: { firstName: string; lastName: string; postcode?: string | null }): Promise<MyProfile> {
  const errors: Record<string, string> = {};
  if (!input.firstName.trim()) errors.firstName = "Ce champ est obligatoire";
  if (!input.lastName.trim()) errors.lastName = "Ce champ est obligatoire";
  if (input.firstName.trim().length > 100 || input.lastName.trim().length > 100) errors.lastName = "100 caractères au maximum";
  const postcode = input.postcode === undefined ? undefined : input.postcode?.trim() || null;
  if (postcode && !POSTCODE.test(postcode)) errors.postcode = "Code postal à 5 chiffres";
  if (Object.keys(errors).length) throw new Rejection("invalid_info", "Certaines informations sont à corriger.", 422, errors);
  await ctx.db
    .updateTable("users")
    .set({ first_name: input.firstName.trim(), last_name: input.lastName.trim(), ...(postcode !== undefined ? { postcode } : {}), updated_at: ctx.now })
    .where("id", "=", session.user.id)
    .execute();
  return getMyProfile(ctx, session);
}
