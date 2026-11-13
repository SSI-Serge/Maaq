import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { Rejection } from "@/server/http";
import { describeError } from "@/server/safe-log";
import { estimateCostUsd } from "../cost";
import { open, seal } from "../fields";
import { localDay } from "../local-time";
import type { AssistantModel, ImageBlock } from "../model";
import { familyTimeZone } from "../reminders";
import { taskViewer, type TaskViewer } from "../tasks";
import { LEVEL_LABEL } from "./catalog";
import { InvalidPage, readModelPage, type GradingScale, type PageAnswers, type PageContent } from "./page-format";
import { MAX_PHOTO_BYTES, PHOTO_TYPES, type PhotoType } from "./photos";
import { homeworkEnabled, levelForAge } from "./settings";

/**
 * Pages d'exercices créées à partir d'une leçon (US-180, D71 à D73). L'enfant, par son profil, ou un parent pour un enfant, envoie la photo ou le texte d'une leçon ; le modèle
 * propose 3 exercices (facile, moyen, difficile), une fiche réponse et un barème sur 20 ; le code contrôle la page avant de l'enregistrer (RT1).
 *  - La photo vit dans la mémoire de la requête : elle n'est écrite ni en base ni dans les journaux, et disparaît avec la réponse (RT3, S-35).
 *  - Le modèle ne reçoit que l'âge des devoirs, jamais le prénom ni la date de naissance (RT2).
 *  - La fiche réponse et le barème ne sont lus et renvoyés qu'à un parent : pour le profil d'un enfant, ils ne sont même pas chargés (RT4, S-36).
 *  - Thème, matière, niveau, exercices, réponses et barème sont chiffrés ; seule la liste des formes de question reste en clair (S-50).
 */

export const MAX_LESSON_TEXT = 6000;
/** « Mes exercices » de l'enfant : ses pages des 30 derniers jours (RF5). */
export const CHILD_PAGE_DAYS = 30;

const fail = (code: string, message: string, status = 422, details?: unknown) => new Rejection(code, message, status, details);
const instructions = (): string => readFileSync(path.join(process.env.ASSISTANT_AGENT_DIR ?? path.join(process.cwd(), "agent"), "devoirs-exercices-instructions.md"), "utf8");

/** Messages de l'écran : l'enfant est tutoyé, le parent vouvoyé (RF8, RF9bis, RF10, RF11). */
export const PAGE_MESSAGES = {
  child: {
    unreadable: "Je n'arrive pas à lire ta leçon. Reprends la photo bien à plat, avec de la lumière.",
    off_topic: "Cette photo ne ressemble pas à une leçon. Essaie avec la page « Je retiens » de ton cahier.",
    cap: "Tu as déjà créé beaucoup d'exercices aujourd'hui. Réessaie demain.",
    failed: "Les exercices n'ont pas pu être créés. Réessaie.",
  },
  parent: {
    unreadable: "La leçon n'a pas pu être lue. Reprenez la photo bien à plat, avec de la lumière.",
    off_topic: "Cette photo ne ressemble pas à une leçon. Essayez avec la page « Je retiens » du cahier.",
    cap: "Vous avez déjà créé beaucoup d'exercices aujourd'hui. Réessayez demain.",
    failed: "Les exercices n'ont pas pu être créés. Réessayez.",
  },
} as const;

interface PageViewer extends TaskViewer {
  role: "parent" | "child";
}

/** Les deux parents, ou le profil d'un enfant qui a un âge des devoirs ; l'aide Devoirs doit être activée (RF1). */
async function viewerOf(ctx: Ctx, session: SessionContext): Promise<PageViewer> {
  const v = await taskViewer(ctx, session);
  if (!v.parent && !v.child) throw fail("forbidden", "Les exercices sont réservés aux parents du foyer et aux enfants qui ont un profil.", 403);
  if (!(await homeworkEnabled(ctx, v.accountId))) throw fail("homework_disabled", "L'aide Devoirs n'est pas activée pour la famille.", 409);
  return { ...v, role: v.parent ? "parent" : "child" };
}

async function childOf(ctx: Ctx, accountId: string, memberId: string) {
  return ctx.db
    .selectFrom("homework_children as h")
    .innerJoin("family_members as m", "m.id", "h.member_id")
    .select(["h.member_id", "m.first_name", "h.homework_age", "m.child_profile_user_id"])
    .where("h.member_id", "=", memberId)
    .where("h.account_id", "=", accountId)
    .where("m.archived_at", "is", null)
    .executeTakeFirst();
}

export interface NewPageInput {
  /** L'enfant pour qui la page est créée : obligatoire pour un parent ; pour le profil d'un enfant, c'est toujours lui. */
  memberId?: string | null;
  photo?: { mediaType: PhotoType; data: Buffer } | null;
  text?: string | null;
}

/**
 * Crée une page d'exercices à partir de la photo ou du texte d'une leçon. Elle compte comme une demande dans le plafond quotidien du profil qui l'envoie (RF10) ; une panne ou
 * une page refusée par le contrôle rend cette demande. Une leçon illisible ou hors sujet ne crée aucune page (RF8).
 */
export async function createExercisePage(ctx: Ctx, session: SessionContext, input: NewPageInput, model: AssistantModel): Promise<{ pageId: string; firstName: string }> {
  const v = await viewerOf(ctx, session);
  const say = PAGE_MESSAGES[v.role];
  const memberId = v.role === "child" ? v.memberId : (input.memberId ?? null);
  const child = memberId ? await childOf(ctx, v.accountId, memberId) : undefined;
  if (!child) throw v.role === "child" ? fail("forbidden", "Demande à tes parents d'indiquer ton âge des devoirs.", 403) : fail("not_found", "Choisissez un enfant qui a un âge des devoirs.", 404);
  const lesson = input.text?.trim() || "";
  if (!input.photo && !lesson) throw fail("no_lesson", v.role === "child" ? "Prends ta leçon en photo, ou colle son texte." : "Prenez la leçon en photo, ou collez son texte.");
  if (lesson.length > MAX_LESSON_TEXT) throw fail("lesson_too_long", `Le texte de la leçon ne peut pas dépasser ${MAX_LESSON_TEXT} caractères.`);
  if (input.photo) {
    if (!PHOTO_TYPES.includes(input.photo.mediaType)) throw fail("invalid_photo", "Envoyez une photo au format JPEG, PNG ou WebP.");
    if (input.photo.data.length === 0 || input.photo.data.length > MAX_PHOTO_BYTES) throw fail("invalid_photo", "La photo est vide ou trop lourde (6 Mo au plus).");
  }

  const day = localDay(ctx.now, await familyTimeZone(ctx.db, v.accountId));
  const accepted = await sql<{ accepted: boolean }>`select register_agent_request(${v.userId}::uuid, ${day}::date) as accepted`.execute(ctx.db);
  if (!accepted.rows[0]?.accepted) throw fail("daily_cap_reached", say.cap, 429);
  const release = () => ctx.db.updateTable("daily_request_counters").set({ request_count: sql`greatest(request_count - 1, 0)` }).where("user_id", "=", v.userId).where("request_date", "=", sql<Date>`${day}::date`).execute();

  // Le modèle ne reçoit que l'âge des devoirs et la leçon : ni prénom, ni date de naissance (RT2).
  const content: ({ type: "text"; text: string } | ImageBlock)[] = [{ type: "text", text: `<age_des_devoirs>${child.homework_age}</age_des_devoirs>${input.photo ? "" : `\n<lecon>${lesson.replaceAll("</lecon>", "")}</lecon>`}` }];
  if (input.photo) content.push({ type: "image", source: { type: "base64", media_type: input.photo.mediaType, data: input.photo.data.toString("base64") } });
  let answer: Awaited<ReturnType<AssistantModel["send"]>>;
  try {
    answer = await model.send({ kind: "page_exercices", system: instructions(), tools: [], messages: [{ role: "user", content }] });
  } catch (error) {
    await release();
    console.error(`Page d'exercices non créée : ${describeError(error)}`);
    throw fail("page_failed", say.failed, 502);
  }
  const raw = answer.content.map((b) => (b.type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("");
  let page: ReturnType<typeof readModelPage>;
  try {
    page = readModelPage(raw);
  } catch (error) {
    await release();
    // Journal sans contenu de la leçon : seulement la raison du refus.
    console.error(JSON.stringify({ event: "homework_page_rejected", reason: error instanceof InvalidPage ? error.message : "erreur" }));
    throw fail("page_failed", say.failed, 502);
  }
  console.log(JSON.stringify({ event: "homework_page", status: page.status, by: v.role, forms: page.status === "ok" ? page.forms : [], costUsd: estimateCostUsd(model.id, answer.usage), tokens: answer.usage.inputTokens + answer.usage.outputTokens }));
  if (page.status === "unreadable") throw fail("lesson_unreadable", say.unreadable);
  if (page.status === "off_topic") throw fail("lesson_off_topic", say.off_topic);

  const ok = page;
  const pageId = await ctx.db.transaction().execute(async (trx) => {
    // Le profil est indiqué à la base : ses règles de sécurité par ligne et ses gardes s'appliquent (création par un parent ou par l'enfant lui-même).
    await sql`select set_config('app.user_id', ${v.userId}, true)`.execute(trx);
    const row = await trx
      .insertInto("homework_exercise_pages")
      .values({
        account_id: v.accountId, member_id: child.member_id, created_by_user_id: v.userId, theme: seal(ok.content.theme), subject: seal(ok.content.subject), level: seal(ok.content.level),
        question_forms: ok.forms, exercises: seal(JSON.stringify({ keyword: ok.content.keyword, exercises: ok.content.exercises })), created_at: ctx.now,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await trx.insertInto("homework_exercise_page_answers").values({ page_id: row.id, account_id: v.accountId, answers: seal(JSON.stringify(ok.answers)), grading_scale: seal(JSON.stringify(ok.grading)) }).execute();
    return row.id;
  });
  return { pageId, firstName: child.first_name ?? "" };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Lecture : « Mes exercices » de l'enfant, dossier « Exercices » des parents
// ---------------------------------------------------------------------------------------------------------------------------

export interface PageSummary {
  id: string;
  theme: string;
  /** Jour de création, « AAAA-MM-JJ », dans le fuseau de la famille. */
  created: string;
  /** Prénom du parent qui a créé la page pour l'enfant ; vide quand l'enfant l'a créée lui-même. */
  createdBy: string | null;
}

export type PageFolder =
  | { role: "parent"; children: { memberId: string; firstName: string; levelLabel: string; hasProfile: boolean; pages: PageSummary[] }[] }
  | { role: "child"; firstName: string; pages: PageSummary[] };

async function summaries(ctx: Ctx, v: PageViewer, memberIds: string[], since: Date | null): Promise<Map<string, PageSummary[]>> {
  const out = new Map<string, PageSummary[]>(memberIds.map((id) => [id, []]));
  if (!memberIds.length) return out;
  const rows = await ctx.db
    .selectFrom("homework_exercise_pages as p")
    .leftJoin("users as u", "u.id", "p.created_by_user_id")
    .innerJoin("family_members as m", "m.id", "p.member_id")
    .select(["p.id", "p.member_id", "p.theme", "p.created_at", "p.created_by_user_id", "u.first_name as by_name", "m.child_profile_user_id"])
    .where("p.account_id", "=", v.accountId)
    .where("p.member_id", "in", memberIds)
    .$if(since !== null, (qb) => qb.where("p.created_at", ">=", since!))
    .orderBy("p.created_at", "desc")
    .limit(500)
    .execute();
  for (const r of rows) {
    const own = r.created_by_user_id !== null && r.created_by_user_id === r.child_profile_user_id;
    out.get(r.member_id)?.push({ id: r.id, theme: open(r.theme), created: localDay(new Date(r.created_at as Date | string), v.timeZone), createdBy: own ? null : (r.by_name ?? null) });
  }
  return out;
}

const since30 = (now: Date) => new Date(now.getTime() - CHILD_PAGE_DAYS * 86_400_000);

/** Le dossier « Exercices » : toutes les pages par enfant pour un parent (RF7) ; ses pages des 30 derniers jours pour le profil d'un enfant, celles qu'un parent a créées pour lui comprises (RF5, S-43). */
export async function listExercisePages(ctx: Ctx, session: SessionContext): Promise<PageFolder> {
  const v = await viewerOf(ctx, session);
  if (v.role === "child") {
    const child = v.memberId ? await childOf(ctx, v.accountId, v.memberId) : undefined;
    if (!child) throw fail("forbidden", "Les exercices sont réservés aux enfants qui ont un âge des devoirs.", 403);
    return { role: "child", firstName: child.first_name ?? "", pages: (await summaries(ctx, v, [child.member_id], since30(ctx.now))).get(child.member_id) ?? [] };
  }
  const kids = await ctx.db
    .selectFrom("homework_children as h")
    .innerJoin("family_members as m", "m.id", "h.member_id")
    .select(["h.member_id", "m.first_name", "h.homework_age", "m.child_profile_user_id"])
    .where("h.account_id", "=", v.accountId)
    .where("m.archived_at", "is", null)
    .orderBy("m.alias_number")
    .execute();
  const pages = await summaries(ctx, v, kids.map((k) => k.member_id), null);
  return {
    role: "parent",
    children: kids.map((k) => ({ memberId: k.member_id, firstName: k.first_name ?? "", levelLabel: LEVEL_LABEL[levelForAge(k.homework_age)], hasProfile: k.child_profile_user_id !== null, pages: pages.get(k.member_id) ?? [] })),
  };
}

export interface PageView {
  id: string;
  role: "parent" | "child";
  /** Prénom de l'enfant, ajouté par MAAQ à l'affichage : le modèle ne l'a jamais reçu. */
  firstName: string;
  created: string;
  content: PageContent;
  /** Fiche réponse et barème, « pour l'adulte qui corrige » : absents de la réponse du serveur pour le profil d'un enfant (S-36). */
  answers: PageAnswers | null;
  grading: GradingScale | null;
}

/** Une page : l'énoncé pour tous ceux qui la voient ; la fiche réponse et le barème pour un parent seulement, jamais chargés pour un enfant (RT4). */
export async function getExercisePage(ctx: Ctx, session: SessionContext, id: string): Promise<PageView> {
  const v = await viewerOf(ctx, session);
  const NOT_FOUND = () => fail("not_found", v.role === "child" ? "Cette page n'existe plus." : "Cette page n'existe plus ou ne vous est pas accessible.", 404);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw NOT_FOUND();
  const row = await ctx.db
    .selectFrom("homework_exercise_pages as p")
    .innerJoin("family_members as m", "m.id", "p.member_id")
    .select(["p.id", "p.member_id", "p.theme", "p.subject", "p.level", "p.exercises", "p.created_at", "m.first_name"])
    .where("p.id", "=", id)
    .where("p.account_id", "=", v.accountId)
    .executeTakeFirst();
  if (!row) throw NOT_FOUND();
  // L'enfant n'ouvre que ses pages, et seulement celles des 30 derniers jours (RF5).
  if (v.role === "child" && (row.member_id !== v.memberId || new Date(row.created_at as Date | string) < since30(ctx.now))) throw NOT_FOUND();
  const stored = JSON.parse(open(row.exercises)) as { keyword: string | null; exercises: PageContent["exercises"] };
  const content: PageContent = { theme: open(row.theme), keyword: stored.keyword, subject: open(row.subject), level: open(row.level), exercises: stored.exercises };
  const base = { id: row.id, role: v.role, firstName: row.first_name ?? "", created: localDay(new Date(row.created_at as Date | string), v.timeZone), content };
  if (v.role !== "parent") return { ...base, answers: null, grading: null };
  const sheet = await ctx.db.selectFrom("homework_exercise_page_answers").select(["answers", "grading_scale"]).where("page_id", "=", id).where("account_id", "=", v.accountId).executeTakeFirst();
  return { ...base, answers: sheet ? (JSON.parse(open(sheet.answers)) as PageAnswers) : null, grading: sheet ? (JSON.parse(open(sheet.grading_scale)) as GradingScale) : null };
}

/** Un parent supprime une page, pour les deux parents et pour l'enfant ; la fiche réponse part avec elle (RF7). */
export async function deleteExercisePage(ctx: Ctx, session: SessionContext, id: string): Promise<void> {
  const v = await viewerOf(ctx, session);
  if (v.role !== "parent") throw fail("forbidden", "Seuls les parents suppriment une page d'exercices.", 403);
  if (!/^[0-9a-f-]{36}$/.test(id)) throw fail("not_found", "Cette page n'existe plus.", 404);
  const done = await ctx.db.deleteFrom("homework_exercise_pages").where("id", "=", id).where("account_id", "=", v.accountId).executeTakeFirst();
  if (!Number(done.numDeletedRows)) throw fail("not_found", "Cette page n'existe plus.", 404);
}
