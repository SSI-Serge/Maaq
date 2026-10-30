import { readFileSync } from "node:fs";
import path from "node:path";
import { sql } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { Rejection } from "@/server/http";
import { describeError } from "@/server/safe-log";
import { estimateCostUsd } from "../cost";
import { localDay } from "../local-time";
import type { AssistantModel, ImageBlock } from "../model";
import { familyTimeZone } from "../reminders";
import { taskViewer } from "../tasks";
import { exerciseStatement, LEVEL_LABEL } from "./catalog";
import { photoDone } from "./photo-text";
import { homeworkEnabled } from "./settings";

/**
 * Photos du travail des enfants (US-119 RF5, RF6, RT6, D64 S-10). Le parent envoie une photo ; le modèle dit ce qui est réussi sans aide ; MAAQ n'enregistre comme validé
 * que cela (le code décide, pas le modèle). La photo n'est jamais écrite nulle part : elle vit dans la mémoire de la requête et disparaît avec elle. Elle compte comme une demande
 * dans le plafond quotidien du profil (SG-5). Le modèle ne reçoit ni prénom, ni date de naissance, ni adresse : seulement le niveau et les exercices (AF-8).
 */

export const MAX_PHOTO_BYTES = 6 * 1024 * 1024;
export const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];

const fail = (code: string, message: string, status = 422, details?: unknown) => new Rejection(code, message, status, details);


const instructions = (): string => readFileSync(path.join(process.env.ASSISTANT_AGENT_DIR ?? path.join(process.cwd(), "agent"), "devoirs-photo-instructions.md"), "utf8");

export type PhotoState = "reussi" | "a_revoir" | "non_visible";

export interface PhotoResult {
  /** Ce que l'aide dit au parent : réussi ou à revoir, sans reproche (RF5). */
  comment: string;
  /** Numéros des exercices enregistrés comme validés (réussis sans aide). */
  validated: number[];
  /** Numéros vus mais à revoir. */
  toReview: number[];
  /** Confirmation à afficher : « Progrès de Léo notés. La photo a été supprimée. » */
  confirmation: string;
}

interface Candidate {
  id: string;
  number: number;
  textbook: string;
  theme: string;
  answer: string | null;
}

/** Les exercices que le modèle peut valider : ceux du niveau de l'enfant prévus dans une semaine (la sienne si elle est donnée), pas encore validés. */
async function candidates(ctx: Ctx, accountId: string, memberId: string, level: string, weekId: string | null): Promise<Candidate[]> {
  const rows = await ctx.db
    .selectFrom("homework_week_items as i")
    .innerJoin("homework_exercises as e", "e.id", "i.exercise_id")
    .leftJoin("homework_exercise_validations as v", (join) => join.onRef("v.exercise_id", "=", "e.id").on("v.member_id", "=", memberId))
    .select(["e.id", "e.number", "e.textbook_key", "e.theme", "e.answer"])
    .where("i.account_id", "=", accountId)
    .where("i.member_id", "=", memberId)
    .where("e.level", "=", level as "cp")
    .where("v.member_id", "is", null)
    .$if(Boolean(weekId), (qb) => qb.where("i.week_id", "=", weekId!))
    .groupBy(["e.id", "e.number", "e.textbook_key", "e.theme", "e.answer"])
    .orderBy("e.number")
    .execute();
  return rows.map((r) => ({ id: String(r.id), number: r.number, textbook: r.textbook_key, theme: r.theme, answer: r.answer }));
}

function parseAnswer(text: string): { comment: string; states: Map<number, PhotoState> } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw fail("photo_unreadable", "La photo n'a pas pu être analysée : réessayez.", 502);
  let data: { commentaire?: unknown; exercices?: unknown };
  try {
    data = JSON.parse(text.slice(start, end + 1)) as typeof data;
  } catch {
    throw fail("photo_unreadable", "La photo n'a pas pu être analysée : réessayez.", 502);
  }
  const states = new Map<number, PhotoState>();
  if (Array.isArray(data.exercices)) {
    for (const entry of data.exercices as { numero?: unknown; etat?: unknown }[]) {
      if (typeof entry?.numero === "number" && (entry.etat === "reussi" || entry.etat === "a_revoir" || entry.etat === "non_visible")) states.set(entry.numero, entry.etat);
    }
  }
  const comment = typeof data.commentaire === "string" ? data.commentaire.trim().slice(0, 600) : "";
  return { comment, states };
}

/**
 * Analyse une photo du travail d'un enfant. Seuls les exercices réussis sans aide sont validés ; une case cochée ne valide jamais (RF6). Retourne ce que l'aide dit et la
 * confirmation « La photo a été supprimée » : l'image n'a été écrite nulle part. Une erreur du modèle ne consomme pas la demande quotidienne.
 */
export async function analyzeHomeworkPhoto(
  ctx: Ctx,
  session: SessionContext,
  input: { memberId: string; weekId?: string | null; mediaType: PhotoType; data: Buffer },
  model: AssistantModel,
): Promise<PhotoResult> {
  const v = await taskViewer(ctx, session);
  if (!v.parent) throw fail("forbidden", "Seuls les parents du foyer ont accès à l'aide Devoirs.", 403);
  if (!(await homeworkEnabled(ctx, v.accountId))) throw fail("homework_disabled", "L'aide Devoirs n'est pas activée pour la famille.", 409);
  if (!PHOTO_TYPES.includes(input.mediaType)) throw fail("invalid_photo", "Envoyez une photo au format JPEG, PNG ou WebP.");
  if (input.data.length === 0 || input.data.length > MAX_PHOTO_BYTES) throw fail("invalid_photo", "La photo est vide ou trop lourde (6 Mo au plus).");
  const child = await ctx.db
    .selectFrom("homework_children as h")
    .innerJoin("family_members as m", "m.id", "h.member_id")
    .select(["h.member_id", "m.first_name", sql<string>`homework_level_for_age(h.homework_age)`.as("level")])
    .where("h.member_id", "=", input.memberId)
    .where("h.account_id", "=", v.accountId)
    .where("m.archived_at", "is", null)
    .executeTakeFirst();
  if (!child) throw fail("not_found", "Cet enfant n'est pas suivi par l'aide Devoirs.", 404);
  const level = child.level;
  const list = await candidates(ctx, v.accountId, input.memberId, level, input.weekId ?? null);
  if (!list.length) throw fail("nothing_to_check", "Aucun exercice prévu n'attend de validation pour cet enfant.", 409);

  // La photo compte comme une demande dans le plafond quotidien du profil (SG-5, RT6).
  const day = localDay(ctx.now, await familyTimeZone(ctx.db, v.accountId));
  const accepted = await sql<{ accepted: boolean }>`select register_agent_request(${session.user.id}::uuid, ${day}::date) as accepted`.execute(ctx.db);
  if (!accepted.rows[0]?.accepted) {
    const { daily_request_limit: limit } = await ctx.db.selectFrom("accounts").select("daily_request_limit").where("id", "=", v.accountId).executeTakeFirstOrThrow();
    throw fail("daily_cap_reached", `Vous avez atteint la limite de ${limit} demandes pour aujourd'hui : elle revient demain.`, 429, { limit });
  }
  const release = () =>
    ctx.db.updateTable("daily_request_counters").set({ request_count: sql`greatest(request_count - 1, 0)` }).where("user_id", "=", session.user.id).where("request_date", "=", sql<Date>`${day}::date`).execute();

  const image: ImageBlock = { type: "image", source: { type: "base64", media_type: input.mediaType, data: input.data.toString("base64") } };
  const exercises = list.map((c) => ({ numero: c.number, theme: c.theme, enonce: exerciseStatement(c.textbook, level as "cp", c.number), corrige: c.answer ?? "" }));
  let answer: Awaited<ReturnType<AssistantModel["send"]>>;
  try {
    answer = await model.send({
      system: instructions(),
      tools: [],
      messages: [{ role: "user", content: [{ type: "text", text: `<niveau>${LEVEL_LABEL[level as "cp"]}</niveau>\n<exercices>${JSON.stringify(exercises)}</exercices>` }, image] }],
    });
  } catch (error) {
    await release();
    console.error(`Photo de devoirs non analysée : ${describeError(error)}`);
    throw fail("photo_failed", "La photo n'a pas pu être analysée. Elle n'a pas été conservée : réessayez.", 502);
  }
  // Journal sans contenu : seulement le coût et le nombre d'exercices.
  console.log(JSON.stringify({ event: "homework_photo", exercises: list.length, costUsd: estimateCostUsd(model.id, answer.usage), tokens: answer.usage.inputTokens + answer.usage.outputTokens }));

  const text = answer.content.map((b) => (b.type === "text" ? String((b as { text?: unknown }).text ?? "") : "")).join("");
  let parsed: ReturnType<typeof parseAnswer>;
  try {
    parsed = parseAnswer(text);
  } catch (error) {
    await release();
    throw error;
  }
  const validated = list.filter((c) => parsed.states.get(c.number) === "reussi");
  for (const c of validated) {
    await ctx.db.insertInto("homework_exercise_validations").values({ member_id: input.memberId, exercise_id: c.id }).onConflict((oc) => oc.doNothing()).execute();
  }
  // Rien n'est dit d'un manuel étranger ici : il est proposé à la préparation de la semaine suivante, présenté comme une nouveauté (RF7, CA 7.2).
  return {
    comment: parsed.comment,
    validated: validated.map((c) => c.number),
    toReview: list.filter((c) => parsed.states.get(c.number) === "a_revoir").map((c) => c.number),
    confirmation: photoDone(child.first_name ?? "l'enfant"),
  };
}
