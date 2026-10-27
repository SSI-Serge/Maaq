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

/** Couleurs des membres dans le calendrier (AF-5) : distinctes entre elles et lisibles sur fond clair comme sur fond sombre. La base attribue le plus petit numéro libre, invités secondaires compris. */
export const MEMBER_COLORS = ["#2f6b9a", "#c2562f", "#3a8a5c", "#8a4fa0", "#b8860b", "#2a7f86", "#a63d5e", "#5c6b2f", "#4a5fb5", "#b0482f", "#6b7d8f", "#8c5a2b", "#0f766e", "#9a3412", "#4d7c0f", "#a21caf"];

/** Une famille compte au plus 12 membres actifs (US-92 RF7) : autant que de couleurs, et la couleur d'un membre retiré est réattribuable (US-93 RF9). */
export const MAX_MEMBERS = 12;
export const MAX_NAME = 30;

/** Couleur d'un membre : la base attribue le plus petit numéro libre parmi les membres actifs (US-93 RF9) ; la palette se répète au-delà. */
export const colorOf = (index: number): string => MEMBER_COLORS[index % MEMBER_COLORS.length];

/** Valeur laissée à la base : l'alias (par rôle, jamais réutilisé) et la couleur libre sont attribués par `family_member_before_insert`. */
const BY_DATABASE = sql<number>`null`;

/**
 * Les fiches « membre » des parents sont créées avec leur profil et suivent leur prénom, leur rang et leur retrait (déclencheurs de la base,
 * US-92 RF1, US-93 RF3) ; Parent 1 est l'utilisateur principal. Les invités secondaires ont aussi une fiche (rôle « autre »), que l'assistant ne
 * connaît pas encore : les listes ci-dessous se limitent aux parents et aux enfants.
 */
const ASSISTANT_ROLES = ["parent", "child"] as const;

export interface FamilyMemberView {
  id: string;
  firstName: string;
  role: "parent" | "child";
  /** Mois et année de naissance, « AAAA-MM » : le jour n'est jamais demandé (D54). */
  birth: string | null;
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

/** Naissance en « AAAA-MM », ou rien si elle n'est pas connue. */
const birthText = (alias: string) =>
  sql<string | null>`case when ${sql.ref(`${alias}birth_year`)} is null then null else lpad(${sql.ref(`${alias}birth_year`)}::text, 4, '0') || '-' || lpad(${sql.ref(`${alias}birth_month`)}::text, 2, '0') end`.as("birth_text");

/** Prénom affiché d'un membre effacé définitivement (D34). */
const FORMER = "Ancien membre";

/** Tous les membres, retirés compris : leurs alias et prénoms restent traduits dans les textes existants, mais l'assistant ne les propose plus. */
export async function loadPseudoMembers(db: Db, accountId: string): Promise<PseudoMember[]> {
  const rows = await db
    .selectFrom("family_members")
    .select(["id", "first_name", "role", "alias_number", birthText(""), "archived_at", "anonymized_at"])
    .where("account_id", "=", accountId)
    .where("role", "in", [...ASSISTANT_ROLES])
    .orderBy("role")
    .orderBy("alias_number")
    .execute();
  return rows.map((r) => ({
    id: r.id,
    firstName: r.first_name ?? FORMER,
    role: r.role === "child" ? "child" : "parent",
    aliasIndex: r.alias_number,
    birth: r.birth_text,
    archived: r.archived_at !== null,
    erased: r.anonymized_at !== null,
  }));
}

async function viewsOf(ctx: Ctx, accountId: string, session: SessionContext, scope: "active" | "removed"): Promise<FamilyMemberView[]> {
  const base = ctx.db
    .selectFrom("family_members as m")
    .leftJoin("users as u", "u.id", "m.user_id")
    .select(["m.id", "m.first_name", "m.role", birthText("m."), "m.color_index", "m.user_id", "m.archived_at", "u.role as user_role"])
    .where("m.account_id", "=", accountId)
    .where("m.role", "in", [...ASSISTANT_ROLES])
    .orderBy("m.role")
    .orderBy("m.alias_number");
  const rows = await (scope === "active" ? base.where("m.archived_at", "is", null) : base.where("m.archived_at", "is not", null).where("m.anonymized_at", "is", null)).execute();
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
    firstName: r.first_name ?? FORMER,
    role: r.role === "child" ? "child" : "parent",
    birth: r.birth_text,
    color: colorOf(r.color_index),
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
  if (taken.some((m) => m.id !== exceptId && m.first_name !== null && foldName(m.first_name) === foldName(firstName))) {
    throw new Rejection("name_taken", "Un membre porte déjà ce prénom. Ajoutez une initiale pour les distinguer.", 409);
  }
  return firstName;
}

/** « AAAA-MM » : mois et année de naissance, facultatifs (D54). Le mois courant est accepté, pas un mois à venir. */
function checkedBirth(value: string | null | undefined, now: Date): { birth_year: number; birth_month: number } | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  const year = match ? Number(match[1]) : 0;
  const month = match ? Number(match[2]) : 0;
  if (!match || year < 1900 || month < 1 || month > 12) throw new Rejection("invalid_birth_date", "La date de naissance est invalide.", 422);
  if (year * 12 + month > now.getUTCFullYear() * 12 + now.getUTCMonth() + 1) throw new Rejection("invalid_birth_date", "La date de naissance ne peut pas être dans le futur.", 422);
  return { birth_year: year, birth_month: month };
}

async function viewOne(ctx: Ctx, session: SessionContext, id: string): Promise<FamilyMemberView> {
  const view = (await viewsOf(ctx, requireParent(session), session, "active")).find((m) => m.id === id);
  if (!view) throw new Rejection("not_found", "Ce membre n'existe pas.", 404);
  return view;
}

/** Ajoute un enfant au foyer (sans compte). Les deux parents peuvent gérer les membres (D33). */
export async function addChild(ctx: Ctx, session: SessionContext, input: { firstName: string; birth?: string | null }): Promise<FamilyMemberView> {
  const accountId = requireParent(session);
  const birth = checkedBirth(input.birth, ctx.now);
  const firstName = await checkedName(ctx.db, accountId, input.firstName);
  const active = await ctx.db.selectFrom("family_members").select(sql<number>`count(*)`.as("n")).where("account_id", "=", accountId).where("role", "in", [...ASSISTANT_ROLES]).where("archived_at", "is", null).executeTakeFirstOrThrow();
  if (Number(active.n) >= MAX_MEMBERS) throw new Rejection("member_limit", `Nombre maximal de membres atteint (${MAX_MEMBERS}).`, 409);
  const row = await ctx.db
    .insertInto("family_members")
    .values({ account_id: accountId, first_name: firstName, role: "child", ...(birth ?? {}), alias_number: BY_DATABASE, color_index: BY_DATABASE, created_by_user_id: session.user.id })
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
export async function updateMember(ctx: Ctx, session: SessionContext, id: string, input: { firstName?: string; birth?: string | null }): Promise<FamilyMemberView> {
  const accountId = requireParent(session);
  const member = await activeMember(ctx, accountId, id);
  const changes: { first_name?: string; birth_year?: number | null; birth_month?: number | null } = {};
  if (input.firstName !== undefined && input.firstName.trim() !== member.first_name) {
    if (member.user_id) throw new Rejection("linked_member", "Le prénom d'un membre qui a un compte se modifie depuis son profil.", 422);
    changes.first_name = await checkedName(ctx.db, accountId, input.firstName, id);
  }
  if (input.birth !== undefined) {
    const birth = checkedBirth(input.birth, ctx.now);
    changes.birth_year = birth?.birth_year ?? null;
    changes.birth_month = birth?.birth_month ?? null;
  }
  if (Object.keys(changes).length) await ctx.db.updateTable("family_members").set(changes).where("id", "=", id).execute();
  return viewOne(ctx, session, id);
}

/** Retire un membre sans compte : il est archivé, ses rendez-vous gardent son prénom, il ne se restaure pas (US-93 RF5 à RF8). */
export async function removeMember(ctx: Ctx, session: SessionContext, id: string): Promise<void> {
  const accountId = requireParent(session);
  const member = await activeMember(ctx, accountId, id);
  if (member.user_id) throw new Rejection("linked_member", "Un membre qui a un profil ne peut pas être retiré ici : supprimez son profil.", 422);
  await ctx.db.updateTable("family_members").set({ archived_at: ctx.now }).where("id", "=", id).execute();
}

/**
 * Efface définitivement un membre sans compte, retiré ou non (D34, US-93 RF13) : prénom et date de naissance effacés, rendez-vous qui ne
 * concernent que lui supprimés, rendez-vous partagés conservés sous « Ancien membre ». La ligne anonymisée sert de trace sans donnée personnelle.
 */
export async function eraseMember(ctx: Ctx, session: SessionContext, id: string): Promise<{ deletedEvents: number }> {
  const accountId = requireParent(session);
  const member = await ctx.db.selectFrom("family_members").select(["id", "user_id", "anonymized_at"]).where("account_id", "=", accountId).where("id", "=", id).where("role", "in", [...ASSISTANT_ROLES]).executeTakeFirst();
  if (!member || member.anonymized_at) throw new Rejection("not_found", "Ce membre n'existe pas ou a déjà été effacé.", 404);
  if (member.user_id) throw new Rejection("linked_member", "Un membre qui a un profil ne peut pas être effacé ici : supprimez son profil.", 422);
  // La base efface le prénom et la naissance, supprime les rendez-vous qui ne concernent que ce membre, retire les images et mails devenus inutiles
  // et laisse la trace sans donnée personnelle (`anonymize_family_member`).
  const { rows } = await sql<{ n: string }>`select anonymize_family_member(${id}::uuid) as n`.execute(ctx.db);
  return { deletedEvents: Number(rows[0]?.n ?? 0) };
}
