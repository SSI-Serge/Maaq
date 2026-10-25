import { sql, type Kysely } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import type { PseudoMember } from "./pseudonymize";

/** Membres du foyer de l'Assistant Famille : les parents (profils connectables) et les enfants (sans compte). */

type Db = Kysely<DB>;

/** Les deux parents du foyer : l'utilisateur principal et l'invité de rang « core » (D33). Les autres profils n'y ont pas accès. */
export function isParent(session: SessionContext): boolean {
  return session.user.role === "primary_user" || (session.user.role === "guest" && session.user.guestRank === "core");
}

export function requireParent(session: SessionContext): string {
  if (!isParent(session) || !session.user.accountId) {
    throw new Rejection("forbidden", "Seuls les parents du foyer ont accès à l'Assistant Famille.", 403);
  }
  return session.user.accountId;
}

/** Couleurs des membres dans le calendrier (AF-5) : distinctes entre elles et lisibles sur fond clair comme sur fond sombre. */
export const MEMBER_COLORS = ["#2f6b9a", "#c2562f", "#3a8a5c", "#8a4fa0", "#b8860b", "#2a7f86", "#a63d5e", "#5c6b2f"];

async function nextColor(db: Db, accountId: string): Promise<string> {
  const used = (await db.selectFrom("family_members").select("color").where("account_id", "=", accountId).execute()).map((r) => r.color);
  return MEMBER_COLORS.find((c) => !used.includes(c)) ?? MEMBER_COLORS[used.length % MEMBER_COLORS.length];
}

async function nextAliasIndex(db: Db, accountId: string, role: "parent" | "child"): Promise<number> {
  const row = await db
    .selectFrom("family_members")
    .select(sql<number>`coalesce(max(alias_index), 0)`.as("max"))
    .where("account_id", "=", accountId)
    .where("role", "=", role)
    .executeTakeFirstOrThrow();
  return Number(row.max) + 1;
}

/**
 * Crée au besoin la fiche « membre » des parents du foyer (utilisateur principal et invité de rang core) à partir de leur profil.
 * Les alias se suivent dans l'ordre de création : Parent 1 est l'utilisateur principal.
 */
export async function ensureParentMembers(db: Db, accountId: string): Promise<void> {
  const parents = await db
    .selectFrom("users")
    .select(["id", "first_name", "role", "guest_rank"])
    .where("account_id", "=", accountId)
    .where("status", "in", ["active", "grace_period"])
    .where((eb) => eb.or([eb("role", "=", "primary_user"), eb.and([eb("role", "=", "guest"), eb("guest_rank", "=", "core")])]))
    .orderBy(sql`case when role = 'primary_user' then 0 else 1 end`)
    .orderBy("created_at")
    .execute();
  const known = new Set(
    (await db.selectFrom("family_members").select("user_id").where("account_id", "=", accountId).where("user_id", "is not", null).execute()).map((m) => m.user_id),
  );
  for (const parent of parents) {
    if (known.has(parent.id)) continue;
    await db
      .insertInto("family_members")
      .values({ account_id: accountId, user_id: parent.id, first_name: parent.first_name, role: "parent", alias_index: await nextAliasIndex(db, accountId, "parent"), color: await nextColor(db, accountId) })
      .onConflict((oc) => oc.doNothing())
      .execute();
  }
}

export interface FamilyMemberView {
  id: string;
  firstName: string;
  role: "parent" | "child";
  birthDate: string | null;
  color: string | null;
  isYou: boolean;
}

const iso = (d: Date | string | null) => (d === null ? null : typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10));

export async function loadPseudoMembers(db: Db, accountId: string): Promise<PseudoMember[]> {
  const rows = await db
    .selectFrom("family_members")
    .select(["id", "first_name", "role", "alias_index", "birth_date"])
    .where("account_id", "=", accountId)
    .orderBy("role")
    .orderBy("alias_index")
    .execute();
  return rows.map((r) => ({ id: r.id, firstName: r.first_name, role: r.role === "child" ? "child" : "parent", aliasIndex: r.alias_index, birthDate: iso(r.birth_date as Date | string | null) }));
}

export async function listFamilyMembers(ctx: Ctx, session: SessionContext): Promise<FamilyMemberView[]> {
  const accountId = requireParent(session);
  await ensureParentMembers(ctx.db, accountId);
  const rows = await ctx.db
    .selectFrom("family_members")
    .select(["id", "first_name", "role", "birth_date", "color", "user_id"])
    .where("account_id", "=", accountId)
    .orderBy("role")
    .orderBy("alias_index")
    .execute();
  return rows.map((r) => ({ id: r.id, firstName: r.first_name, role: r.role, birthDate: iso(r.birth_date as Date | string | null), color: r.color, isYou: r.user_id === session.user.id }));
}

/** Ajoute un enfant au foyer (sans compte). Les deux parents peuvent gérer les membres (D33). */
export async function addChild(ctx: Ctx, session: SessionContext, input: { firstName: string; birthDate?: string | null }): Promise<FamilyMemberView> {
  const accountId = requireParent(session);
  const firstName = input.firstName.trim();
  if (!firstName || firstName.length > 100) throw new Rejection("invalid_name", "Le prénom doit faire entre 1 et 100 caractères.", 422);
  if (input.birthDate) {
    const born = new Date(`${input.birthDate}T00:00:00Z`);
    if (Number.isNaN(born.getTime()) || born > ctx.now) throw new Rejection("invalid_birth_date", "La date de naissance est invalide.", 422);
  }
  await ensureParentMembers(ctx.db, accountId);
  const row = await ctx.db
    .insertInto("family_members")
    .values({ account_id: accountId, first_name: firstName, role: "child", birth_date: input.birthDate ?? null, alias_index: await nextAliasIndex(ctx.db, accountId, "child"), color: await nextColor(ctx.db, accountId) })
    .returning(["id", "first_name", "role", "birth_date", "color"])
    .executeTakeFirstOrThrow();
  return { id: row.id, firstName: row.first_name, role: row.role, birthDate: iso(row.birth_date as Date | string | null), color: row.color, isYou: false };
}
