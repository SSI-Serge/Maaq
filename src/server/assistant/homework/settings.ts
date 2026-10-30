import { sql } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { HomeworkLevel } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { requireFamilyProfile, requireParent } from "../family";
import { LEVEL_LABEL } from "./catalog";

/**
 * Aide Devoirs du foyer (US-118) : un réglage familial lisible par tous les profils et modifiable par les deux parents (D64, S-07), désactivé par défaut (SG-2).
 * L'âge des devoirs de chaque enfant est saisi par le parent, sans lien avec sa date de naissance (S-11) : il donne le niveau de maths et l'âge des activités.
 */

export const HOMEWORK_AGE_MIN = 6;
export const HOMEWORK_AGE_MAX = 12;

export interface HomeworkChildView {
  memberId: string;
  firstName: string;
  /** Âge des devoirs, ou rien tant que le parent ne l'a pas saisi : l'enfant n'est alors pas proposé dans l'aide. */
  homeworkAge: number | null;
  level: HomeworkLevel | null;
  levelLabel: string | null;
}

export interface HomeworkSetting {
  enabled: boolean;
  /** Vrai tant que la présentation en trois lignes n'a jamais été montrée (première activation, RF3). */
  needsIntro: boolean;
  /** Les deux parents modifient ; les invités secondaires lisent. */
  canEdit: boolean;
  /** Au moins un membre enfant : sans lui l'aide ne s'active pas (RF2). */
  hasChildren: boolean;
  children: HomeworkChildView[];
}

/** Niveau de maths de l'âge des devoirs : 6 ans CP … 10 ans CM2, et 11 ou 12 ans CM2 (RF4). Même règle que `homework_level_for_age` dans la base. */
export function levelForAge(age: number): HomeworkLevel {
  return (["cp", "ce1", "ce2", "cm1"] as const)[age - HOMEWORK_AGE_MIN] ?? "cm2";
}

export async function homeworkChildren(ctx: Ctx, accountId: string): Promise<HomeworkChildView[]> {
  const rows = await ctx.db
    .selectFrom("family_members as m")
    .leftJoin("homework_children as h", "h.member_id", "m.id")
    .select(["m.id", "m.first_name", "h.homework_age"])
    .where("m.account_id", "=", accountId)
    .where("m.role", "=", "child")
    .where("m.archived_at", "is", null)
    .orderBy("m.alias_number")
    .execute();
  return rows.map((r) => ({
    memberId: r.id,
    firstName: r.first_name ?? "",
    homeworkAge: r.homework_age,
    level: r.homework_age === null ? null : levelForAge(r.homework_age),
    levelLabel: r.homework_age === null ? null : LEVEL_LABEL[levelForAge(r.homework_age)],
  }));
}

export async function getHomeworkSetting(ctx: Ctx, session: SessionContext): Promise<HomeworkSetting> {
  const { accountId, parent } = requireFamilyProfile(session);
  const row = await ctx.db.selectFrom("family_settings").select(["homework_help_enabled", "homework_help_first_enabled_at"]).where("account_id", "=", accountId).executeTakeFirst();
  const children = await homeworkChildren(ctx, accountId);
  return {
    enabled: row?.homework_help_enabled ?? false,
    needsIntro: !row?.homework_help_first_enabled_at,
    canEdit: parent,
    hasChildren: children.length > 0,
    children,
  };
}

/** Vrai si l'aide est activée pour ce foyer : porte d'entrée de tout ce qui touche aux devoirs (apparition, tchat, accueil). */
export async function homeworkEnabled(ctx: Ctx, accountId: string): Promise<boolean> {
  const row = await ctx.db.selectFrom("family_settings").select("homework_help_enabled").where("account_id", "=", accountId).executeTakeFirst();
  return row?.homework_help_enabled ?? false;
}

/**
 * Active ou désactive l'aide pour le foyer. La première activation demande que le parent ait vu la présentation (`confirmed`). La base refuse l'activation
 * d'une famille sans enfant et pose elle-même les dates d'activation et de désactivation.
 */
export async function setHomeworkEnabled(ctx: Ctx, session: SessionContext, input: { enabled: boolean; confirmed?: boolean }): Promise<HomeworkSetting> {
  const accountId = requireParent(session);
  const current = await getHomeworkSetting(ctx, session);
  if (input.enabled && !current.hasChildren) throw new Rejection("no_child", "Ajoutez vos enfants dans les membres pour utiliser l'aide Devoirs.", 422);
  if (input.enabled && current.needsIntro && !input.confirmed) throw new Rejection("intro_required", "Lisez la présentation de l'aide Devoirs avant de l'activer.", 409);
  try {
    await ctx.db
      .insertInto("family_settings")
      .values({ account_id: accountId, homework_help_enabled: input.enabled, updated_by_user_id: session.user.id })
      .onConflict((oc) => oc.column("account_id").doUpdateSet({ homework_help_enabled: input.enabled, updated_by_user_id: session.user.id }))
      .execute();
  } catch (error) {
    if ((error as { code?: string }).code === "23514") throw new Rejection("no_child", "Ajoutez vos enfants dans les membres pour utiliser l'aide Devoirs.", 422);
    throw error;
  }
  return getHomeworkSetting(ctx, session);
}

/** Âge des devoirs d'un enfant (6 à 12 ans) : sans lien avec sa date de naissance, qui n'est ni lue ni modifiée (RF4). */
export async function setHomeworkAge(ctx: Ctx, session: SessionContext, memberId: string, age: number): Promise<HomeworkSetting> {
  const accountId = requireParent(session);
  if (!Number.isInteger(age) || age < HOMEWORK_AGE_MIN || age > HOMEWORK_AGE_MAX) {
    throw new Rejection("invalid_age", `L'âge des devoirs est compris entre ${HOMEWORK_AGE_MIN} et ${HOMEWORK_AGE_MAX} ans.`, 422);
  }
  const child = await ctx.db.selectFrom("family_members").select("id").where("id", "=", memberId).where("account_id", "=", accountId).where("role", "=", "child").where("archived_at", "is", null).executeTakeFirst();
  if (!child) throw new Rejection("not_found", "Cet enfant n'existe plus ou ne fait plus partie de la famille.", 404);
  await ctx.db
    .insertInto("homework_children")
    .values({ member_id: memberId, account_id: accountId, homework_age: age })
    .onConflict((oc) => oc.column("member_id").doUpdateSet({ homework_age: age }))
    .execute();
  return getHomeworkSetting(ctx, session);
}

/** « Effacer les progrès de Devoirs » (RF5, S-12) : semaines, tâches et exercices validés disparaissent ; l'âge des devoirs de chaque enfant reste. */
export async function eraseHomeworkProgress(ctx: Ctx, session: SessionContext): Promise<{ erased: number }> {
  const accountId = requireParent(session);
  const { rows } = await sql<{ n: string }>`select erase_family_homework_progress(${accountId}::uuid, true) as n`.execute(ctx.db);
  return { erased: Number(rows[0]?.n ?? 0) };
}

/** Purges quotidiennes de la base : semaines de plus de 12 mois, exercices validés d'une famille sans aide depuis plus de 30 jours (D65). */
export async function purgeExpiredHomework(ctx: Ctx): Promise<number> {
  const { rows } = await sql<{ n: string }>`select purge_expired_homework_data() as n`.execute(ctx.db);
  return Number(rows[0]?.n ?? 0);
}
