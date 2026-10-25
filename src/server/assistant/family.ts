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
export const MEMBER_COLORS = ["#2f6b9a", "#c2562f", "#3a8a5c", "#8a4fa0", "#b8860b", "#2a7f86", "#a63d5e", "#5c6b2f", "#4a5fb5", "#b0482f", "#6b7d8f", "#8c5a2b"];

/** Une famille compte au plus 12 membres actifs (US-92 RF7) : autant que de couleurs, et la couleur d'un membre retiré est réattribuable (US-93 RF9). */
export const MAX_MEMBERS = 12;
export const MAX_NAME = 30;

async function nextColor(db: Db, accountId: string): Promise<string> {
  const used = (await db.selectFrom("family_members").select("color").where("account_id", "=", accountId).where("archived_at", "is", null).execute()).map((r) => r.color);
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
    if (known.has(parent.id)) {
      // Le prénom d'un membre relié à un profil suit celui du profil (US-93 RF3, RF4).
      await db
        .updateTable("family_members")
        .set({ first_name: parent.first_name, updated_at: new Date() })
        .where("account_id", "=", accountId)
        .where("user_id", "=", parent.id)
        .where("first_name", "<>", parent.first_name)
        .execute();
      continue;
    }
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
  /** « Utilisateur principal » ou « Invité » pour un membre relié à un profil ; vide pour un membre sans compte (US-92 RF2). */
  badge: "primary" | "guest" | null;
  /** Relié à un profil : son prénom se modifie depuis le profil, il ne se retire ni ne s'efface ici (US-93 RF3, RF7). */
  linked: boolean;
  /** Rendez-vous à venir (provisoires ou confirmés) qui le concernent, pour la confirmation de retrait (US-93 RF5). */
  upcoming: number;
  removedAt: string | null;
}

export interface FamilyOverview {
  members: FamilyMemberView[];
  removed: FamilyMemberView[];
  max: number;
}

// Les dates de naissance sont lues en texte (AAAA-MM-JJ) : le pilote de base les rendrait en minuit local, un jour trop tôt selon le fuseau du serveur.
const birthText = (alias: string) => sql<string | null>`${sql.ref(`${alias}birth_date`)}::text`.as("birth_text");

/** Tous les membres, retirés compris : leurs alias et prénoms restent traduits dans les textes existants, mais l'assistant ne les propose plus. */
export async function loadPseudoMembers(db: Db, accountId: string): Promise<PseudoMember[]> {
  const rows = await db
    .selectFrom("family_members")
    .select(["id", "first_name", "role", "alias_index", birthText(""), "archived_at", "erased_at"])
    .where("account_id", "=", accountId)
    .orderBy("role")
    .orderBy("alias_index")
    .execute();
  return rows.map((r) => ({
    id: r.id,
    firstName: r.first_name,
    role: r.role === "child" ? "child" : "parent",
    aliasIndex: r.alias_index,
    birthDate: r.birth_text,
    archived: r.archived_at !== null,
    erased: r.erased_at !== null,
  }));
}

async function viewsOf(ctx: Ctx, accountId: string, session: SessionContext, scope: "active" | "removed"): Promise<FamilyMemberView[]> {
  const base = ctx.db
    .selectFrom("family_members as m")
    .leftJoin("users as u", "u.id", "m.user_id")
    .select(["m.id", "m.first_name", "m.role", birthText("m."), "m.color", "m.user_id", "m.archived_at", "u.role as user_role"])
    .where("m.account_id", "=", accountId)
    .orderBy("m.role")
    .orderBy("m.alias_index");
  const rows = await (scope === "active" ? base.where("m.archived_at", "is", null) : base.where("m.archived_at", "is not", null).where("m.erased_at", "is", null)).execute();
  const counts = new Map<string, number>();
  if (scope === "active" && rows.length) {
    const upcoming = await ctx.db
      .selectFrom("family_event_members as l")
      .innerJoin("family_events as e", "e.id", "l.event_id")
      .select(["l.member_id", sql<number>`count(*)`.as("n")])
      .where("e.account_id", "=", accountId)
      .where("e.starts_at", ">", ctx.now)
      .where("e.status", "in", ["provisional", "confirmed"])
      .groupBy("l.member_id")
      .execute();
    for (const u of upcoming) counts.set(u.member_id, Number(u.n));
  }
  return rows.map((r) => ({
    id: r.id,
    firstName: r.first_name,
    role: r.role,
    birthDate: r.birth_text,
    color: r.color,
    isYou: r.user_id === session.user.id,
    badge: r.user_id === null ? null : r.user_role === "primary_user" ? "primary" : "guest",
    linked: r.user_id !== null,
    upcoming: counts.get(r.id) ?? 0,
    removedAt: r.archived_at ? new Date(r.archived_at as Date | string).toISOString() : null,
  }));
}

/** Membres actifs, puis membres retirés (section repliée « Membres retirés », qui garde l'effacement définitif). */
export async function familyOverview(ctx: Ctx, session: SessionContext): Promise<FamilyOverview> {
  const accountId = requireParent(session);
  await ensureParentMembers(ctx.db, accountId);
  return { members: await viewsOf(ctx, accountId, session, "active"), removed: await viewsOf(ctx, accountId, session, "removed"), max: MAX_MEMBERS };
}

export async function listFamilyMembers(ctx: Ctx, session: SessionContext): Promise<FamilyMemberView[]> {
  return (await familyOverview(ctx, session)).members;
}

const foldName = (name: string) => name.normalize("NFC").trim().toLocaleLowerCase("fr");

async function checkedName(db: Db, accountId: string, raw: string, exceptId?: string): Promise<string> {
  const firstName = raw.trim();
  if (!firstName) throw new Rejection("invalid_name", "Le prénom est obligatoire.", 422);
  if ([...firstName].length > MAX_NAME) throw new Rejection("invalid_name", `Le prénom ne peut pas dépasser ${MAX_NAME} caractères.`, 422);
  const taken = await db.selectFrom("family_members").select(["id", "first_name"]).where("account_id", "=", accountId).where("archived_at", "is", null).execute();
  if (taken.some((m) => m.id !== exceptId && foldName(m.first_name) === foldName(firstName))) {
    throw new Rejection("name_taken", "Un membre porte déjà ce prénom. Ajoutez une initiale pour les distinguer.", 409);
  }
  return firstName;
}

function checkedBirthDate(value: string | null | undefined, now: Date): string | null {
  if (!value) return null;
  const born = new Date(`${value}T00:00:00Z`);
  // Le retour en texte écarte les jours qui n'existent pas (31 février) que Date accepterait en les reportant au mois suivant.
  if (Number.isNaN(born.getTime()) || born.toISOString().slice(0, 10) !== value || born.getUTCFullYear() < 1900) throw new Rejection("invalid_birth_date", "La date de naissance est invalide.", 422);
  if (born > now) throw new Rejection("invalid_birth_date", "La date de naissance ne peut pas être dans le futur.", 422);
  return value;
}

async function viewOne(ctx: Ctx, session: SessionContext, id: string): Promise<FamilyMemberView> {
  const view = (await viewsOf(ctx, requireParent(session), session, "active")).find((m) => m.id === id);
  if (!view) throw new Rejection("not_found", "Ce membre n'existe pas.", 404);
  return view;
}

/** Ajoute un enfant au foyer (sans compte). Les deux parents peuvent gérer les membres (D33). */
export async function addChild(ctx: Ctx, session: SessionContext, input: { firstName: string; birthDate?: string | null }): Promise<FamilyMemberView> {
  const accountId = requireParent(session);
  await ensureParentMembers(ctx.db, accountId);
  const birthDate = checkedBirthDate(input.birthDate, ctx.now);
  const firstName = await checkedName(ctx.db, accountId, input.firstName);
  const active = await ctx.db.selectFrom("family_members").select(sql<number>`count(*)`.as("n")).where("account_id", "=", accountId).where("archived_at", "is", null).executeTakeFirstOrThrow();
  if (Number(active.n) >= MAX_MEMBERS) throw new Rejection("member_limit", `Nombre maximal de membres atteint (${MAX_MEMBERS}).`, 409);
  const row = await ctx.db
    .insertInto("family_members")
    .values({ account_id: accountId, first_name: firstName, role: "child", birth_date: birthDate, alias_index: await nextAliasIndex(ctx.db, accountId, "child"), color: await nextColor(ctx.db, accountId) })
    .returning("id")
    .executeTakeFirstOrThrow();
  return viewOne(ctx, session, row.id);
}

async function activeMember(ctx: Ctx, accountId: string, id: string) {
  const member = await ctx.db.selectFrom("family_members").select(["id", "first_name", "user_id", "archived_at"]).where("account_id", "=", accountId).where("id", "=", id).executeTakeFirst();
  if (!member || member.archived_at) throw new Rejection("not_found", "Ce membre n'existe pas ou a été retiré.", 404);
  return member;
}

/** Modifie un membre : prénom et date de naissance pour un membre sans compte, date de naissance seule pour un membre relié à un profil (US-93 RF2, RF3). */
export async function updateMember(ctx: Ctx, session: SessionContext, id: string, input: { firstName?: string; birthDate?: string | null }): Promise<FamilyMemberView> {
  const accountId = requireParent(session);
  const member = await activeMember(ctx, accountId, id);
  const changes: { first_name?: string; birth_date?: string | null; updated_at: Date } = { updated_at: ctx.now };
  if (input.firstName !== undefined && input.firstName.trim() !== member.first_name) {
    if (member.user_id) throw new Rejection("linked_member", "Le prénom d'un membre qui a un compte se modifie depuis son profil.", 422);
    changes.first_name = await checkedName(ctx.db, accountId, input.firstName, id);
  }
  if (input.birthDate !== undefined) changes.birth_date = checkedBirthDate(input.birthDate, ctx.now);
  await ctx.db.updateTable("family_members").set(changes).where("id", "=", id).execute();
  return viewOne(ctx, session, id);
}

/** Retire un membre sans compte : il est archivé, ses rendez-vous gardent son prénom, il ne se restaure pas (US-93 RF5 à RF8). */
export async function removeMember(ctx: Ctx, session: SessionContext, id: string): Promise<void> {
  const accountId = requireParent(session);
  const member = await activeMember(ctx, accountId, id);
  if (member.user_id) throw new Rejection("linked_member", "Un membre qui a un profil ne peut pas être retiré ici : supprimez son profil.", 422);
  await ctx.db.updateTable("family_members").set({ archived_at: ctx.now, updated_at: ctx.now }).where("id", "=", id).execute();
}

/**
 * Efface définitivement un membre sans compte, retiré ou non (D34, US-93 RF13) : prénom et date de naissance effacés, rendez-vous qui ne
 * concernent que lui supprimés, rendez-vous partagés conservés sous « Ancien membre ». La ligne anonymisée sert de trace sans donnée personnelle.
 */
export async function eraseMember(ctx: Ctx, session: SessionContext, id: string): Promise<{ deletedEvents: number }> {
  const accountId = requireParent(session);
  const member = await ctx.db.selectFrom("family_members").select(["id", "user_id", "erased_at"]).where("account_id", "=", accountId).where("id", "=", id).executeTakeFirst();
  if (!member || member.erased_at) throw new Rejection("not_found", "Ce membre n'existe pas ou a déjà été effacé.", 404);
  if (member.user_id) throw new Rejection("linked_member", "Un membre qui a un profil ne peut pas être effacé ici : supprimez son profil.", 422);
  return ctx.db.transaction().execute(async (trx) => {
    const deleted = await trx
      .deleteFrom("family_events")
      .where("account_id", "=", accountId)
      .where("all_family", "=", false)
      .where(sql<boolean>`id in (select event_id from family_event_members where member_id = ${id})`)
      .where(sql<boolean>`not exists (select 1 from family_event_members o where o.event_id = family_events.id and o.member_id <> ${id})`)
      .returning("id")
      .execute();
    await trx
      .updateTable("family_members")
      .set({ first_name: "Ancien membre", birth_date: null, archived_at: sql`coalesce(archived_at, ${ctx.now})`, erased_at: ctx.now, updated_at: ctx.now })
      .where("id", "=", id)
      .execute();
    return { deletedEvents: deleted.length };
  });
}
