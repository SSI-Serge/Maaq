import { createHmac } from "node:crypto";
import { sql, type Kysely } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB, OutingCategory } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { Rejection } from "@/server/http";
import type { EventType } from "../calendar";
import { createConfirmedEvent, type EventView } from "../events";
import { open, openOptional, seal, sealOptional } from "../fields";
import { requireParent } from "../family";
import { localDay } from "../local-time";
import { familyTimeZone } from "../reminders";
import { CATEGORY_LABEL } from "./criteria";
import { asProfile } from "./profile";

/**
 * Propositions de sorties (US-115, US-116, US-117, US-120) : données PRIVÉES du profil qui les a reçues. Toute lecture vérifie que le demandeur en est le propriétaire ;
 * un autre profil, même l'autre parent, reçoit « introuvable » comme pour une page qui n'existe pas (US-117 CA 1.2). Les textes des idées sont chiffrés : une proposition peut
 * préparer une surprise, et les administrateurs n'en voient pas le contenu. Rien ici ne finit dans un journal.
 */

const fail = (code: string, message: string, status = 409, details?: unknown) => new Rejection(code, message, status, details);
const NOT_FOUND = () => fail("not_found", "Cette page n'existe plus ou ne vous est pas accessible.", 404);

export const FINAL_NOTE = "Disponibilités non vérifiées : réservez au plus tôt.";

/** Empreinte d'une offre (nom et lieu normalisés), calculée avec un secret : la mémoire anti-répétition ne garde jamais un texte lisible (US-115 RF8). */
export function offerHash(name: string, place: string): Buffer {
  const normalize = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return createHmac("sha256", Buffer.from(env().ENCRYPTION_KEY, "base64")).update(`outing|${normalize(name)}|${normalize(place)}`).digest();
}

export interface IdeaDraft {
  section: "in_budget" | "novelty";
  category: OutingCategory | null;
  themeKey: string | null;
  name: string;
  place: string;
  description: string;
  details: string | null;
  url: string;
  priceEur: number;
  priceEstimated: boolean;
  priceBasis: string | null;
  /** Date du relevé du prix, « AAAA-MM-JJ ». */
  checkedOn: string;
  openedYear: number | null;
}

export interface NewProposal {
  userId: string;
  accountId: string;
  targetDate: string;
  budget: number;
  people: number;
  place: string;
  ideas: IdeaDraft[];
  /** Instant de la préparation : date de création de la proposition (la période de la fréquence s'en sert) et de la mémoire des offres. */
  now: Date;
}

/**
 * Enregistre une proposition complète : la proposition, ses idées et la mémoire des offres, en une transaction. Une proposition n'apparaît qu'une fois complète (RF10).
 * Sans idée, rien n'est enregistré comme proposition visible : un repère « écartée » sans idée marque la tentative de ce jour visé, pour ne pas la rejouer (RF9).
 */
export async function createProposal(db: Kysely<DB>, input: NewProposal): Promise<{ id: string; ideas: number }> {
  const id = await asProfile(db, input.userId, async (trx) => {
    const row = await trx
      .insertInto("outing_proposals")
      .values({
        account_id: input.accountId, user_id: input.userId, target_date: input.targetDate, status: input.ideas.length ? "ready" : "dismissed", budget_eur: input.budget, people_count: input.people, departure_place: input.place, created_at: input.now,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    let position = 0;
    for (const idea of input.ideas) {
      position += 1;
      await trx
        .insertInto("outing_proposal_ideas")
        .values({
          proposal_id: row.id, user_id: input.userId, idea_position: position, section: idea.section, category: idea.category, theme_key: idea.themeKey, name: seal(idea.name), place: seal(idea.place), description: seal(idea.description),
          details: sealOptional(idea.details), offer_url: seal(idea.url), price_eur: idea.priceEur.toFixed(2), price_is_estimated: idea.priceEstimated, price_basis: idea.priceEstimated ? sealOptional(idea.priceBasis) : null,
          price_checked_on: idea.checkedOn, opened_year: idea.section === "novelty" ? idea.openedYear : null,
        })
        .execute();
      await trx
        .insertInto("outing_offer_memory")
        .values({ user_id: input.userId, account_id: input.accountId, offer_hash: offerHash(idea.name, idea.place), proposed_at: input.now })
        .onConflict((oc) => oc.columns(["user_id", "offer_hash"]).doUpdateSet({ proposed_at: input.now }))
        .execute();
    }
    return row.id;
  });
  return { id, ideas: input.ideas.length };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------------------------------------------------------

export interface IdeaView {
  id: string;
  section: "in_budget" | "novelty";
  /** Thème de l'idée « dans le budget », pour l'écran présenté par thème. */
  themeLabel: string | null;
  categoryLabel: string | null;
  name: string;
  place: string;
  description: string;
  details: string | null;
  url: string;
  priceEur: number;
  /** « estimé » (ou « ≈ » pour une nouveauté) quand le prix n'est pas affiché par la source. */
  estimated: boolean;
  priceBasis: string | null;
  checkedOn: string;
  openedYear: number | null;
  /** Largeur de la jauge « X % du budget » ; vide pour une nouveauté : ni jauge ni repère de budget (RF3). */
  budgetPercent: number | null;
  status: "proposed" | "dismissed" | "added";
}

export interface ProposalView {
  id: string;
  targetDate: string;
  status: "ready" | "dismissed" | "added";
  budget: number;
  people: number;
  place: string;
  ideas: IdeaView[];
  /** Date du relevé la plus ancienne des prix affichés. */
  checkedOn: string | null;
  note: string;
}

async function ownerOf(ctx: Ctx, session: SessionContext): Promise<{ accountId: string; userId: string }> {
  return { accountId: requireParent(session), userId: session.user.id };
}

/** La carte « L'heure de penser à vous » de l'accueil : la prochaine proposition prête, dont le jour visé n'est pas passé et qui a encore une idée à voir (RF5, RF7). */
export async function homeCard(ctx: Ctx, session: SessionContext): Promise<{ id: string; targetDate: string; ideas: number } | null> {
  const { accountId, userId } = await ownerOf(ctx, session);
  const today = localDay(ctx.now, await familyTimeZone(ctx.db, accountId));
  return asProfile(ctx.db, userId, async (trx) => {
    const row = await trx
      .selectFrom("outing_proposals as p")
      .select(["p.id", sql<string>`p.target_date::text`.as("target"), sql<number>`(select count(*)::int from outing_proposal_ideas i where i.proposal_id = p.id and i.status = 'proposed')`.as("ideas")])
      .where("p.user_id", "=", userId)
      .where("p.status", "=", "ready")
      .where(sql<boolean>`p.target_date >= ${today}::date`)
      .orderBy("p.target_date")
      .executeTakeFirst();
    return row && row.ideas > 0 ? { id: row.id, targetDate: row.target, ideas: row.ideas } : null;
  });
}

export async function getProposal(ctx: Ctx, session: SessionContext, id: string): Promise<ProposalView> {
  const { userId } = await ownerOf(ctx, session);
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw NOT_FOUND();
  return asProfile(ctx.db, userId, async (trx) => {
    const p = await trx
      .selectFrom("outing_proposals")
      .select(["id", sql<string>`target_date::text`.as("target"), "status", "budget_eur", "people_count", "departure_place"])
      .where("id", "=", id)
      .where("user_id", "=", userId)
      .executeTakeFirst();
    if (!p) throw NOT_FOUND();
    const rows = await trx
      .selectFrom("outing_proposal_ideas as i")
      .leftJoin("outing_themes as t", (j) => j.onRef("t.category", "=", "i.category").onRef("t.theme_key", "=", "i.theme_key"))
      .select([
        "i.id", "i.section", "i.category", "t.label as theme_label", "i.name", "i.place", "i.description", "i.details", "i.offer_url", "i.price_eur", "i.price_is_estimated", "i.price_basis",
        sql<string>`i.price_checked_on::text`.as("checked_on"), "i.opened_year", "i.status",
      ])
      .where("i.proposal_id", "=", id)
      .where("i.user_id", "=", userId)
      .orderBy("i.idea_position")
      .execute();
    const ideas = rows.map((r): IdeaView => {
      const price = Number(r.price_eur);
      return {
        id: String(r.id), section: r.section, themeLabel: r.theme_label, categoryLabel: r.category ? CATEGORY_LABEL[r.category] : null, name: open(r.name), place: open(r.place), description: open(r.description),
        details: openOptional(r.details), url: open(r.offer_url), priceEur: price, estimated: r.price_is_estimated, priceBasis: openOptional(r.price_basis), checkedOn: r.checked_on, openedYear: r.opened_year,
        budgetPercent: r.section === "in_budget" ? Math.min(100, Math.round((price / p.budget_eur) * 100)) : null, status: r.status,
      };
    });
    return { id: p.id, targetDate: p.target, status: p.status, budget: p.budget_eur, people: p.people_count, place: p.departure_place, ideas, checkedOn: ideas.map((i) => i.checkedOn).sort()[0] ?? null, note: FINAL_NOTE };
  });
}

// ---------------------------------------------------------------------------------------------------------------------------
// Écarter (US-116)
// ---------------------------------------------------------------------------------------------------------------------------

function translate(error: unknown): unknown {
  if ((error as { code?: string }).code === "23514") return fail("not_allowed", (error as Error).message, 409);
  return error;
}

/** « Annuler » sur la carte : retire toute la proposition, sans confirmation (RF1). Rien n'est dit à personne, aucun compteur (RF4, RF5). */
export async function dismissProposal(ctx: Ctx, session: SessionContext, id: string): Promise<void> {
  const { userId } = await ownerOf(ctx, session);
  try {
    await asProfile(ctx.db, userId, async (trx) => {
      const done = await trx.updateTable("outing_proposals").set({ status: "dismissed" }).where("id", "=", id).where("user_id", "=", userId).where("status", "=", "ready").returning("id").executeTakeFirst();
      if (!done) {
        const exists = await trx.selectFrom("outing_proposals").select("status").where("id", "=", id).where("user_id", "=", userId).executeTakeFirst();
        if (!exists) throw NOT_FOUND();
      }
    });
  } catch (error) {
    throw translate(error);
  }
}

/** « Annuler » du message « Proposition retirée » : la proposition revient, tant qu'il reste une idée à voir (RF1, CA 1.2). */
export async function restoreProposal(ctx: Ctx, session: SessionContext, id: string): Promise<void> {
  const { userId } = await ownerOf(ctx, session);
  try {
    await asProfile(ctx.db, userId, async (trx) => {
      const row = await trx.selectFrom("outing_proposals").select("status").where("id", "=", id).where("user_id", "=", userId).executeTakeFirst();
      if (!row) throw NOT_FOUND();
      if (row.status === "dismissed") await trx.updateTable("outing_proposals").set({ status: "ready" }).where("id", "=", id).where("user_id", "=", userId).execute();
    });
  } catch (error) {
    throw translate(error);
  }
}

/** « Pas cette fois » : retire cette seule idée ; la dernière idée retirée retire la proposition entière (RF2). */
export async function dismissIdea(ctx: Ctx, session: SessionContext, ideaId: string, restore = false): Promise<void> {
  const { userId } = await ownerOf(ctx, session);
  if (!/^\d{1,18}$/.test(ideaId)) throw NOT_FOUND();
  try {
    await asProfile(ctx.db, userId, async (trx) => {
      const row = await trx.selectFrom("outing_proposal_ideas").select("status").where("id", "=", ideaId).where("user_id", "=", userId).executeTakeFirst();
      if (!row) throw NOT_FOUND();
      await trx.updateTable("outing_proposal_ideas").set({ status: restore ? "proposed" : "dismissed" }).where("id", "=", ideaId).where("user_id", "=", userId).execute();
    });
  } catch (error) {
    throw translate(error);
  }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Ajouter au calendrier (US-120, US-121)
// ---------------------------------------------------------------------------------------------------------------------------

export interface IdeaFormView {
  title: string;
  place: string;
  notes: string;
  /** « family » ou « personal » selon la catégorie (RF1). */
  type: EventType;
  /** Le parent seul, modifiable (RF1). */
  memberId: string | null;
  members: { id: string; firstName: string }[];
  /** « Proposé pour le samedi 14/11 » : seulement suggéré, la date et l'heure restent vides (RF2). */
  suggestedDate: string;
  /** Avertissement de visibilité (US-121 RF1, RF5) ; vide sans autre parent (RF4). */
  visibleTo: string[];
  warning: string | null;
  help: string;
}

const typeOfCategory = (category: OutingCategory | null): EventType => (category === "self" ? "personal" : "family");
const euro = (value: number) => `${value.toLocaleString("fr-FR", { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 })} €`;

/** « Ce RDV sera visible par Julien dans le calendrier familial dès son enregistrement. » (US-121 RF1) ; avec des invités secondaires concernés : « … par Julien et Élodie … » (RF5). */
export function visibilityWarning(names: string[]): string | null {
  if (!names.length) return null;
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} et ${names[names.length - 1]}`;
  return `Ce RDV sera visible par ${who} dans le calendrier familial dès son enregistrement.`;
}

/** Formulaire de RDV prérempli depuis une idée : titre, lieu, note (description, prix, lien), type et membres. La date et l'heure ne sont pas préremplies (RF1, RF2). */
export async function ideaForm(ctx: Ctx, session: SessionContext, ideaId: string, memberIds?: string[]): Promise<IdeaFormView> {
  const { accountId, userId } = await ownerOf(ctx, session);
  if (!/^\d{1,18}$/.test(ideaId)) throw NOT_FOUND();
  const idea = await asProfile(ctx.db, userId, async (trx) =>
    trx
      .selectFrom("outing_proposal_ideas as i")
      .innerJoin("outing_proposals as p", "p.id", "i.proposal_id")
      .select(["i.name", "i.place", "i.description", "i.offer_url", "i.price_eur", "i.price_is_estimated", "i.section", "i.category", "i.status", "p.status as proposal_status", sql<string>`p.target_date::text`.as("target"), "p.people_count"])
      .where("i.id", "=", ideaId)
      .where("i.user_id", "=", userId)
      .where("p.user_id", "=", userId)
      .executeTakeFirst(),
  );
  if (!idea) throw NOT_FOUND();
  const members = await ctx.db
    .selectFrom("family_members")
    .select(["id", "first_name", "user_id", "role"])
    .where("account_id", "=", accountId)
    .where("archived_at", "is", null)
    .where("role", "in", ["parent", "child"])
    .orderBy("role")
    .orderBy("alias_number")
    .execute();
  const own = members.find((m) => m.user_id === userId);
  const chosen = memberIds?.length ? memberIds : own ? [own.id] : [];
  // Qui verra ce RDV : l'autre parent (et les invités secondaires concernés, D26) ; tout parent le voit, un invité secondaire seulement s'il est concerné.
  const guests = await ctx.db
    .selectFrom("users as u")
    .leftJoin("family_members as m", "m.user_id", "u.id")
    .select(["u.id", "u.first_name", "u.role", "u.guest_rank", "m.id as member_id"])
    .where("u.account_id", "=", accountId)
    .where("u.id", "<>", userId)
    .where("u.status", "in", ["active", "grace_period"])
    .where("u.role", "in", ["primary_user", "guest"])
    .execute();
  const visibleTo = guests.filter((g) => g.role === "primary_user" || g.guest_rank === "core" || (g.member_id !== null && chosen.includes(g.member_id))).map((g) => g.first_name ?? "");
  const price = Number(idea.price_eur);
  const priceText = `${idea.section === "novelty" && idea.price_is_estimated ? "≈ " : ""}${euro(price)}${idea.price_is_estimated ? " (estimé)" : ""}`;
  return {
    title: open(idea.name).slice(0, 100),
    place: open(idea.place).slice(0, 200),
    notes: `${open(idea.description)}\nPrix : ${priceText}\nVoir l'offre : ${open(idea.offer_url)}`.slice(0, 500),
    type: typeOfCategory(idea.category),
    memberId: own?.id ?? null,
    members: members.map((m) => ({ id: m.id, firstName: m.first_name ?? "" })),
    suggestedDate: idea.target,
    visibleTo,
    warning: visibilityWarning(visibleTo),
    help: "Pour garder la surprise, vous pouvez choisir un titre discret.",
  };
}

export interface AddIdeaInput {
  title: string;
  place: string | null;
  notes: string | null;
  type: EventType;
  memberIds: string[];
  start: string;
  end: string;
  allowConflict?: boolean;
}

/**
 * « Ajouter au calendrier » (US-120) : le RDV est enregistré directement confirmé, source « sortie », sans lien vers la proposition ; l'idée passe à « ajoutée » dans la même
 * transaction et la proposition quitte l'accueil (RF6). L'autre parent n'est pas notifié (RF5).
 */
export async function addIdeaToCalendar(ctx: Ctx, session: SessionContext, ideaId: string, input: AddIdeaInput): Promise<EventView> {
  const { userId } = await ownerOf(ctx, session);
  if (!/^\d{1,18}$/.test(ideaId)) throw NOT_FOUND();
  const idea = await asProfile(ctx.db, userId, async (trx) =>
    trx
      .selectFrom("outing_proposal_ideas as i")
      .innerJoin("outing_proposals as p", "p.id", "i.proposal_id")
      .select(["i.id", "i.status", "p.status as proposal_status"])
      .where("i.id", "=", ideaId)
      .where("i.user_id", "=", userId)
      .executeTakeFirst(),
  );
  if (!idea) throw NOT_FOUND();
  if (idea.status !== "proposed" || idea.proposal_status !== "ready") throw fail("idea_gone", "Cette idée n'est plus proposée.", 409);
  return createConfirmedEvent(ctx, session, { type: input.type, title: input.title, place: input.place, notes: input.notes, start: input.start, end: input.end, memberIds: input.memberIds, allowConflict: input.allowConflict }, async (trx) => {
    // Même transaction que le RDV : le profil est indiqué à la base comme dans `asProfile`.
    await sql`select set_config('app.user_id', ${userId}, true)`.execute(trx);
    await trx.updateTable("outing_proposal_ideas").set({ status: "added" }).where("id", "=", ideaId).where("user_id", "=", userId).execute();
  });
}
