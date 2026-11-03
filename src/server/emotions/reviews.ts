import { sql, type Kysely } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { loadCalendarEventsByIds } from "@/server/assistant/calendar";
import { open } from "@/server/assistant/fields";
import { localToUtc } from "@/server/assistant/local-time";
import { asProfile } from "@/server/assistant/outings/profile";
import { familyTimeZone } from "@/server/assistant/reminders";
import { addDays } from "@/server/assistant/series";
import { selectTasks, toTaskViews, visibleTo, type TaskViewer, taskViewer } from "@/server/assistant/tasks";
import type { DB } from "@/server/db/schema.generated";
import { emotionError, partnerOf, requireCouple, type CoupleViewer } from "./couple";

/**
 * Le bilan de la semaine (US-142, US-144, E-13, E-17). Une ligne par parent du couple et par semaine (`weekly_reviews`), créée avec le point, sans contenu : ce que le bilan montre est
 * calculé à l'ouverture, par MAAQ, sans l'agent et sans aucun chiffre. Il couvre le lundi-dimanche qui précède l'envoi (une semaine avant celle du point). Le mot du partenaire n'y entre
 * qu'à la première ouverture (POST explicite) : la base rattache alors les mots écrits et les fige.
 */

export const REVIEW_URL = "/assistant/bilan";
/** Au-delà, la liste se termine par « … et tout le reste » (US-144 RF2). */
export const REVIEW_MAX_ITEMS = 10;

export interface ReviewItem {
  kind: "task" | "event";
  id: string;
  title: string;
}

export interface ReviewView {
  id: string;
  /** Lundi de la semaine couverte, et dimanche. */
  weekStart: string;
  weekEnd: string;
  opened: boolean;
  /** Prénom du partenaire, qui a écrit les mots et posé les cœurs. */
  partner: string;
  /** Mots du partenaire, dans l'ordre où ils ont été écrits ; vides tant que le bilan n'est pas ouvert, et sans indication qu'il en manque (RF1). */
  notes: { id: string; text: string }[];
  /** « [Prénom] vous remercie pour : » (RF1.2). */
  thanks: ReviewItem[];
  /** Ce que la famille a fait ensemble, sans le nom de celui qui l'a fait (RF1.3) ; jamais plus de 10 éléments. */
  together: ReviewItem[];
  togetherMore: boolean;
  /** Semaine sans rien de fait, sans cœur et sans mot : « Une semaine tranquille. Profitez-en. » (RF3). */
  quiet: boolean;
}

export interface ReviewSummary {
  id: string;
  weekStart: string;
  opened: boolean;
}

/** Lundi de la semaine couverte par le bilan, d'après le lundi de la semaine du point. */
export const reviewWeekOf = (digestWeekStart: string) => addDays(digestWeekStart, -7);

/** Crée le bilan d'un parent du couple pour cette semaine (une seule fois). Sans effet hors couple. */
export async function ensureReview(db: Kysely<DB>, accountId: string, userId: string, weekStart: string, now: Date): Promise<boolean> {
  if (!(await partnerOf(db, userId))) return false;
  const row = await db
    .insertInto("weekly_reviews")
    .values({ account_id: accountId, user_id: userId, week_start: weekStart, generated_at: now })
    .onConflict((oc) => oc.columns(["account_id", "user_id", "week_start"]).doNothing())
    .returning("id")
    .executeTakeFirst();
  return Boolean(row);
}

/** Le dernier bilan de ce profil : il reste consultable jusqu'au suivant (RF5). Vide hors couple ou avant le premier envoi. */
export async function currentReview(ctx: Ctx, session: SessionContext): Promise<ReviewSummary | null> {
  if (!session.user.accountId || session.user.role === "admin") return null;
  if (!(await partnerOf(ctx.db, session.user.id))) return null;
  const row = await ctx.db
    .selectFrom("weekly_reviews")
    .select(["id", sql<string>`week_start::text`.as("week_start"), "opened_at"])
    .where("user_id", "=", session.user.id)
    .where("account_id", "=", session.user.accountId)
    .orderBy("week_start", "desc")
    .limit(1)
    .executeTakeFirst();
  return row ? { id: row.id, weekStart: row.week_start, opened: row.opened_at !== null } : null;
}

async function content(ctx: Ctx, v: TaskViewer, couple: CoupleViewer, weekStart: string): Promise<Pick<ReviewView, "thanks" | "together" | "togetherMore">> {
  const timeZone = await familyTimeZone(ctx.db, couple.accountId);
  const from = localToUtc(weekStart, timeZone);
  const to = new Date(Math.min(localToUtc(addDays(weekStart, 7), timeZone).getTime(), ctx.now.getTime()));

  // Tâches faites dans la semaine, que ce profil a le droit de voir ; titres génériques pour une tâche médicale (AT-4).
  const taskRows = await selectTasks(ctx.db)
    .where("t.account_id", "=", couple.accountId)
    .where(visibleTo(couple.userId))
    .where("t.status", "=", "done")
    .where("t.done_at", ">=", from)
    .where("t.done_at", "<", to)
    .orderBy("t.done_at")
    .execute();
  const tasks = await toTaskViews(ctx.db, v, taskRows);
  const doneAt = new Map(taskRows.map((r) => [r.id, r.done_at!.getTime()]));

  // RDV confirmés et terminés dans la semaine.
  const visible = await sql<{ id: string; ends_at: Date }>`select e.id, e.ends_at from family_events_visible_to(${couple.userId}::uuid) e where e.account_id = ${couple.accountId}::uuid and e.status = 'confirmed' and e.ends_at >= ${from} and e.ends_at < ${to} order by e.ends_at`.execute(ctx.db);
  const events = await loadCalendarEventsByIds(ctx.db, couple.accountId, visible.rows.map((r) => r.id));
  const endedAt = new Map(visible.rows.map((r) => [r.id, new Date(r.ends_at).getTime()]));

  // Cœurs reçus : posés par le partenaire sur ce que ce profil a fait ou créé dans la semaine.
  const hearts = await ctx.db.selectFrom("appreciation_hearts").select(["task_id", "event_id"]).where("account_id", "=", couple.accountId).where("author_user_id", "=", couple.partner.id).execute();
  const thankedTasks = new Set(hearts.map((h) => h.task_id).filter((x): x is string => Boolean(x)));
  const thankedEvents = new Set(hearts.map((h) => h.event_id).filter((x): x is string => Boolean(x)));

  const done: (ReviewItem & { at: number })[] = [
    ...tasks.map((t) => ({ kind: "task" as const, id: t.id, title: t.title, at: doneAt.get(t.id) ?? 0 })),
    ...events.map((e) => ({ kind: "event" as const, id: e.id, title: e.title, at: endedAt.get(e.id) ?? 0 })),
  ].sort((a, b) => a.at - b.at);
  const strip = ({ kind, id, title }: ReviewItem & { at: number }): ReviewItem => ({ kind, id, title });
  return {
    thanks: done.filter((i) => (i.kind === "task" ? thankedTasks.has(i.id) : thankedEvents.has(i.id))).map(strip),
    together: done.slice(0, REVIEW_MAX_ITEMS).map(strip),
    togetherMore: done.length > REVIEW_MAX_ITEMS,
  };
}

async function viewOf(ctx: Ctx, session: SessionContext, row: { id: string; week_start: string; opened_at: Date | null }): Promise<ReviewView> {
  const couple = await requireCouple(ctx, session);
  const v = await taskViewer(ctx, session);
  const opened = row.opened_at !== null;
  // Les mots ne sont lisibles qu'une fois le bilan ouvert (la base les rattache à ce moment) ; la sécurité par ligne les protège aussi.
  const notes = opened
    ? await asProfile(ctx.db, couple.userId, (trx) =>
        trx.selectFrom("partner_notes").select(["id", "body"]).where("weekly_review_id", "=", row.id).where("recipient_user_id", "=", couple.userId).orderBy("created_at").execute(),
      )
    : [];
  const shown = await content(ctx, v, couple, row.week_start);
  return {
    id: row.id, weekStart: row.week_start, weekEnd: addDays(row.week_start, 6), opened, partner: couple.partner.firstName,
    notes: notes.map((n) => ({ id: n.id, text: open(n.body) })),
    ...shown,
    quiet: notes.length === 0 && shown.thanks.length === 0 && shown.together.length === 0,
  };
}

/**
 * Ouvre le bilan (POST, US-143 RF8) : la première fois, la date d'ouverture est posée, ce qui rattache et fige les mots du partenaire ; les fois suivantes, le même bilan est relu.
 * Sans `id`, c'est le dernier bilan du profil.
 */
export async function openReview(ctx: Ctx, session: SessionContext, id?: string): Promise<ReviewView> {
  const couple = await requireCouple(ctx, session);
  const found = await ctx.db
    .selectFrom("weekly_reviews")
    .select(["id", sql<string>`week_start::text`.as("week_start"), "opened_at"])
    .where("user_id", "=", couple.userId)
    .where("account_id", "=", couple.accountId)
    .$if(Boolean(id), (qb) => qb.where("id", "=", id!))
    .orderBy("week_start", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!found) throw emotionError("no_review", "Votre bilan n'est pas encore prêt.", 404);
  let opened = found.opened_at;
  if (!opened) {
    // Le rattachement des mots se fait dans la base (déclencheur) : une seule première ouverture, même en cas de double appui.
    const updated = await ctx.db.updateTable("weekly_reviews").set({ opened_at: ctx.now }).where("id", "=", found.id).where("opened_at", "is", null).returning("opened_at").executeTakeFirst();
    opened = updated?.opened_at ?? (await ctx.db.selectFrom("weekly_reviews").select("opened_at").where("id", "=", found.id).executeTakeFirstOrThrow()).opened_at;
  }
  return viewOf(ctx, session, { ...found, opened_at: opened });
}
