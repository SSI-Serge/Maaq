import { sql, type Kysely } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { describeError } from "@/server/safe-log";
import { integerSetting } from "@/server/settings";
import type { PlacePoint } from "./address";
import { loadCalendarEvent, type CalendarEvent } from "./calendar";
import { conversationOf } from "./conversation";
import { requireFamilyProfile } from "./family";
import { open, seal } from "./fields";
import { utcToLocal } from "./local-time";
import { PlaceServiceError, placeProvider, type FoundPlace, type PlaceCategory, type PlaceProvider } from "./place-provider";
import { dispatch, recipientsOf } from "./task-notices";
import { distanceKm } from "./travel-provider";

/**
 * « Sur place » (US-112) : où se garer et où manger près du lieu d'un RDV non médical. Une recherche est une ligne de `event_place_searches` : le travail à exécuter, son état et son
 * résultat chiffré, gardé jusqu'à la fin du RDV. La base porte les règles : 3 recherches au plus par RDV (hors échecs), plafond quotidien du profil, RDV médical refusé, résultats effacés
 * quand l'adresse change (`obsolete`). MAAQ lance la recherche dès la demande et n'a le planificateur de 5 minutes que comme filet de sécurité. Le résultat ne contient que des noms,
 * types, villes et distances à pied recalculées par MAAQ : aucune coordonnée, aucune note, aucun avis ; « Voir les avis » est une simple adresse de recherche (nom et ville).
 */
const WALK_KMH = 5;
const PER_CATEGORY: Record<PlaceCategory, number> = { parking: 2, snack: 2, restaurant: 2 };
const SEARCH_TIMEOUT_MS = 110_000;
const BATCH = 5;

type Db = Kysely<DB>;
const fail = (code: string, message: string, status = 409) => new Rejection(code, message, status);

export const CATEGORY_LABEL: Record<PlaceCategory, string> = { parking: "Se garer", snack: "Petite faim", restaurant: "Grande faim" };
const CATEGORIES: PlaceCategory[] = ["parking", "snack", "restaurant"];

export interface PlaceItem {
  name: string;
  type: string;
  city: string;
  /** Distance à pied approximative, recalculée par MAAQ depuis le vrai lieu. */
  walkMinutes: number;
}

export interface PlacePayload {
  source: string;
  parking: PlaceItem[];
  snack: PlaceItem[];
  restaurant: PlaceItem[];
}

const pointOf = (sealed: Buffer | null): PlacePoint | null => {
  if (!sealed) return null;
  const { lat, lon } = JSON.parse(open(sealed)) as Partial<PlacePoint>;
  return typeof lat === "number" && typeof lon === "number" ? { lat, lon } : null;
};

/** Coordonnées arrondies à environ 100 m (3 décimales) avant d'être envoyées au service : une adresse privée n'est jamais donnée exactement (US-112 RT2). */
export const roundedPoint = (p: PlacePoint): PlacePoint => ({ lat: Math.round(p.lat * 1000) / 1000, lon: Math.round(p.lon * 1000) / 1000 });

/** Les adresses retenues : à 15 minutes à pied au plus du vrai lieu, ouvertes autour du RDV, les plus proches d'abord, 1 ou 2 parkings et 2 adresses par faim (RF5, RF6). */
export function selectPlaces(places: FoundPlace[], origin: PlacePoint, maxWalkMinutes: number, source: string): PlacePayload {
  const payload: PlacePayload = { source, parking: [], snack: [], restaurant: [] };
  const scored = places
    .filter((p) => p.open !== false)
    .map((p) => ({ p, walk: Math.max(1, Math.ceil((distanceKm(origin, p.point) / WALK_KMH) * 60)) }))
    .filter((x) => x.walk <= maxWalkMinutes)
    .sort((a, b) => a.walk - b.walk || a.p.name.localeCompare(b.p.name, "fr"));
  for (const { p, walk } of scored) {
    if (payload[p.category].length < PER_CATEGORY[p.category]) payload[p.category].push({ name: p.name, type: p.type, city: p.city, walkMinutes: walk });
  }
  return payload;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------------------------------------------------------

export interface PlaceBlock {
  category: PlaceCategory;
  label: string;
  items: (PlaceItem & { reviewsUrl: string })[];
  /** « Une seule adresse « Petite faim » trouvée près du lieu. » (RF6) ; vide quand le compte y est. */
  note: string | null;
}

export interface PlaceSearchView {
  /** « Où se garer, où manger ? » est proposé pour ce RDV et ce profil. */
  available: boolean;
  unavailable: "medical" | "no_location" | "past" | null;
  /** Recherches comptées (hors échecs) sur le maximum de 3 par RDV (RF9). */
  searches: number;
  max: number;
  /** La dernière recherche : en attente, en cours, terminée, sans information, échouée ou périmée. */
  latest: { id: string; status: "queued" | "running" | "done" | "no_result" | "failed" | "obsolete"; failureReason: string | null } | null;
  /** Le dernier résultat gardé (une recherche terminée), affiché « jusqu'à la fin du RDV » (RF8). */
  results: { checkedOn: string; place: string; blocks: PlaceBlock[] } | null;
}

const reviewsUrl = (name: string, city: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${name} ${city}`)}`;

function noteFor(category: PlaceCategory, count: number): string | null {
  if (category === "parking" && count >= 1) return null;
  if (count === 0) return `Aucune adresse « ${CATEGORY_LABEL[category]} » trouvée près du lieu.`;
  return count < PER_CATEGORY[category] ? `Une seule adresse « ${CATEGORY_LABEL[category]} » trouvée près du lieu.` : null;
}

export function blocksOf(payload: PlacePayload): PlaceBlock[] {
  return CATEGORIES.map((category) => ({
    category, label: CATEGORY_LABEL[category], items: payload[category].map((i) => ({ ...i, reviewsUrl: reviewsUrl(i.name, i.city) })), note: noteFor(category, payload[category].length),
  }));
}

async function visibleEvent(ctx: Ctx, session: SessionContext, eventId: string): Promise<CalendarEvent> {
  const { accountId } = requireFamilyProfile(session);
  const { rows } = await sql<{ id: string }>`select id from family_events_visible_to(${session.user.id}::uuid) where id = ${eventId}::uuid`.execute(ctx.db);
  const e = rows[0] ? await loadCalendarEvent(ctx.db, accountId, eventId) : undefined;
  if (!e || (e.status !== "confirmed" && e.status !== "provisional")) throw fail("not_found", "Ce rendez-vous n'existe plus ou ne vous est pas accessible.", 404);
  return e;
}

/** « Sur place » d'un RDV : l'état de la recherche et le dernier résultat ; `null` quand le service de recherche est fermé (le bouton n'est alors pas proposé). */
export async function placeSearchView(ctx: Ctx, session: SessionContext, eventId: string, provider: PlaceProvider | null = placeProvider()): Promise<PlaceSearchView | null> {
  const e = await visibleEvent(ctx, session, eventId);
  if (!provider) return null;
  const max = await integerSetting(ctx.db, "max_place_searches_per_event", 3);
  const rows = await ctx.db.selectFrom("event_place_searches").select(["id", "status", "failure_reason", sql<string | null>`checked_on::text`.as("checked_on"), "result_payload", "seq"]).where("event_id", "=", e.id).orderBy("seq", "desc").execute();
  const latest = rows[0] ?? null;
  const done = rows.find((r) => r.status === "done" && r.result_payload);
  const results = done ? { checkedOn: String(done.checked_on), place: e.place ?? "", blocks: blocksOf(JSON.parse(open(done.result_payload!)) as PlacePayload) } : null;
  const noResult = latest?.status === "no_result" ? { checkedOn: String(latest.checked_on), place: e.place ?? "", blocks: [] as PlaceBlock[] } : null;
  const unavailable = e.type === "medical" ? "medical" : !e.place ? "no_location" : e.endsAt <= ctx.now ? "past" : null;
  return {
    available: unavailable === null, unavailable, searches: rows.filter((r) => r.status !== "failed").length, max,
    latest: latest ? { id: latest.id, status: latest.status, failureReason: latest.failure_reason } : null,
    results: latest?.status === "no_result" ? noResult : results,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Demande
// ---------------------------------------------------------------------------------------------------------------------------

const REFUSALS: Record<string, { status: number; message: (max: number) => string }> = {
  not_found: { status: 404, message: () => "Ce rendez-vous n'existe plus ou ne vous est pas accessible." },
  medical: { status: 422, message: () => "Pas de recherche « Sur place » pour un rendez-vous médical." },
  no_location: { status: 422, message: () => "La recherche « Sur place » exige un lieu." },
  ended: { status: 409, message: () => "Ce rendez-vous est terminé." },
  event_limit: { status: 409, message: (max) => `Nombre maximal de recherches pour ce RDV atteint (${max}).` },
  daily_limit: { status: 429, message: () => "Vous avez atteint le nombre de demandes de la journée. Réessayez demain." },
};

/** Le profil qui demande une recherche ou reçoit une suggestion. `parent` : il a un tchat avec l'assistant (les deux parents), où le message « Sur place » est posé. */
export interface SearchUser {
  id: string;
  accountId: string;
  timeZone: string;
  parent: boolean;
}

/** Un message de l'assistant dans le tchat du profil : sans texte pour une suggestion ou un résultat « Sur place » (leur contenu vient de la base, pas d'une copie). */
async function postMessage(db: Db, now: Date, user: SearchUser, message: { kind: "text" | "place_suggestion" | "place_results"; eventId?: string; searchId?: string; text?: string }): Promise<void> {
  const conversation = await conversationOf(db, user.accountId, user.id, now);
  await db
    .insertInto("agent_conversation_messages")
    .values({
      conversation_id: conversation.id, sender: "agent", kind: message.kind, content: message.text ? seal(message.text) : null, family_event_id: message.eventId ?? null,
      place_search_id: message.searchId ?? null, created_at: now,
    })
    .execute();
}

async function createSearch(db: Db, now: Date, user: SearchUser, eventId: string, origin: "button" | "chat" | "suggestion"): Promise<string> {
  const { rows } = await sql<{ search_id: string | null; refusal: string | null }>`
    select search_id, refusal from request_place_search(${eventId}::uuid, ${user.id}::uuid, ${origin}::place_search_origin, ${utcToLocal(now, user.timeZone).slice(0, 10)}::date)`.execute(db);
  const out = rows[0];
  if (!out?.search_id) {
    const refusal = REFUSALS[out?.refusal ?? ""] ?? REFUSALS.not_found;
    throw fail(out?.refusal ?? "not_found", refusal.message(await integerSetting(db, "max_place_searches_per_event", 3)), refusal.status);
  }
  // Le résultat arrive dans le tchat (RF4) : le message, posé dès la demande, montre « Je cherche… » puis le résultat.
  if (user.parent) await postMessage(db, now, user, { kind: "place_results", eventId, searchId: out.search_id });
  return out.search_id;
}

/**
 * Demande une recherche « Sur place » (RF1, RF2, RF9) : atomique, par la base. Elle compte dans le plafond quotidien du profil. Retourne l'identifiant de la recherche, à exécuter aussitôt
 * (`runPlaceSearch`) ; le planificateur ne la reprend que si l'exécution n'a pas eu lieu. Un parent la retrouve dans son tchat.
 */
export async function requestPlaceSearch(ctx: Ctx, session: SessionContext, eventId: string, origin: "button" | "chat" | "suggestion", provider: PlaceProvider | null = placeProvider()): Promise<string> {
  const { accountId, parent } = requireFamilyProfile(session);
  if (!provider) throw fail("place_off", "La recherche « Sur place » n'est pas ouverte.", 409);
  return createSearch(ctx.db, ctx.now, { id: session.user.id, accountId, timeZone: session.device.timezone || "Europe/Paris", parent }, eventId, origin);
}

/** La même demande, faite par l'agent pour le parent qui lui écrit (« Où peut-on se garer et manger près du château ? », CA 2.1). */
export async function requestPlaceSearchFor(db: Db, now: Date, user: SearchUser, eventId: string, provider: PlaceProvider | null = placeProvider()): Promise<string> {
  if (!provider) throw fail("place_off", "La recherche « Sur place » n'est pas ouverte.", 409);
  return createSearch(db, now, user, eventId, "chat");
}

// ---------------------------------------------------------------------------------------------------------------------------
// Suggestion automatique (RF3, D60)
// ---------------------------------------------------------------------------------------------------------------------------

/**
 * « Voulez-vous que je cherche où se garer et où manger près de [lieu] ? » : proposée une seule fois par RDV, dans le tchat du parent qui a demandé le RDV, pour un RDV familial ou
 * personnel avec un lieu (règle de la base). Le caractère public du lieu est jugé par l'agent quand il propose le RDV ; un lieu manifestement privé n'est jamais suggéré. Retourne vrai quand la
 * suggestion est posée.
 */
export async function suggestPlaceSearch(db: Db, now: Date, user: SearchUser, eventId: string, provider: PlaceProvider | null = placeProvider()): Promise<boolean> {
  if (!provider || !user.parent) return false;
  try {
    const row = await db
      .insertInto("event_place_suggestions")
      .values({ event_id: eventId, account_id: user.accountId, suggested_to_user_id: user.id })
      .onConflict((oc) => oc.column("event_id").doNothing())
      .returning("event_id")
      .executeTakeFirst();
    if (!row) return false;
    await postMessage(db, now, user, { kind: "place_suggestion", eventId });
    return true;
  } catch (error) {
    // Un RDV qui n'est ni familial ni personnel, ou sans lieu : la base refuse la suggestion, sans conséquence.
    if ((error as { code?: string }).code === "23514") return false;
    throw error;
  }
}

/** « Oui » lance la recherche (origine « suggestion ») ; « Non, merci » est mémorisé et l'assistant répond (CA 3.2). La réponse ne se donne qu'une fois, par le parent à qui la suggestion a été faite. */
export async function answerPlaceSuggestion(ctx: Ctx, session: SessionContext, eventId: string, answer: "accepted" | "declined", provider: PlaceProvider | null = placeProvider()): Promise<{ searchId: string | null }> {
  const { accountId, parent } = requireFamilyProfile(session);
  const suggestion = await ctx.db.selectFrom("event_place_suggestions").select(["answer", "suggested_to_user_id"]).where("event_id", "=", eventId).where("account_id", "=", accountId).executeTakeFirst();
  if (!suggestion || suggestion.suggested_to_user_id !== session.user.id) throw fail("not_found", "Cette suggestion n'existe plus.", 404);
  if (suggestion.answer !== "pending") throw fail("already_answered", "Vous avez déjà répondu à cette suggestion.", 409);
  const user: SearchUser = { id: session.user.id, accountId, timeZone: session.device.timezone || "Europe/Paris", parent };
  let searchId: string | null = null;
  if (answer === "accepted") {
    if (!provider) throw fail("place_off", "La recherche « Sur place » n'est pas ouverte.", 409);
    searchId = await createSearch(ctx.db, ctx.now, user, eventId, "suggestion");
  }
  const done = await ctx.db
    .updateTable("event_place_suggestions")
    .set({ answer, answered_at: ctx.now, search_id: searchId })
    .where("event_id", "=", eventId)
    .where("answer", "=", "pending")
    .returning("event_id")
    .executeTakeFirst();
  if (!done) throw fail("already_answered", "Vous avez déjà répondu à cette suggestion.", 409);
  if (answer === "declined") await postMessage(ctx.db, ctx.now, user, { kind: "text", text: "D'accord. Vous pourrez lancer la recherche depuis le détail du RDV." });
  return { searchId };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Messages du tchat
// ---------------------------------------------------------------------------------------------------------------------------

export interface PlaceSearchDetail {
  id: string;
  status: "queued" | "running" | "done" | "no_result" | "failed" | "obsolete";
  failureReason: string | null;
  checkedOn: string | null;
  place: string;
  blocks: PlaceBlock[];
}

async function searchDetail(db: Db, accountId: string, searchId: string): Promise<PlaceSearchDetail | null> {
  const s = await db.selectFrom("event_place_searches").select(["id", "event_id", "status", "failure_reason", sql<string | null>`checked_on::text`.as("checked_on"), "result_payload"]).where("id", "=", searchId).where("account_id", "=", accountId).executeTakeFirst();
  if (!s) return null;
  const e = await loadCalendarEvent(db, accountId, s.event_id);
  return {
    id: s.id, status: s.status, failureReason: s.failure_reason, checkedOn: s.checked_on ? String(s.checked_on) : null, place: e?.place ?? "",
    blocks: s.status === "done" && s.result_payload ? blocksOf(JSON.parse(open(s.result_payload)) as PlacePayload) : [],
  };
}

/** L'état d'une recherche, pour la carte du tchat qui se met à jour pendant la recherche : réservé aux profils qui voient le RDV. */
export async function placeSearchById(ctx: Ctx, session: SessionContext, searchId: string): Promise<PlaceSearchDetail> {
  const { accountId } = requireFamilyProfile(session);
  const s = await ctx.db.selectFrom("event_place_searches").select("event_id").where("id", "=", searchId).where("account_id", "=", accountId).executeTakeFirst();
  const visible = s ? await sql<{ id: string }>`select id from family_events_visible_to(${session.user.id}::uuid) where id = ${s.event_id}::uuid`.execute(ctx.db) : null;
  const detail = visible?.rows[0] ? await searchDetail(ctx.db, accountId, searchId) : null;
  if (!detail) throw fail("not_found", "Cette recherche n'existe plus.", 404);
  return detail;
}

/** Ce que montre un message « Sur place » du tchat : la suggestion et sa réponse, ou la recherche et son résultat. */
export interface PlaceMessageView {
  kind: "place_suggestion" | "place_results";
  eventId: string | null;
  /** Le lieu du RDV, tel que saisi : « Château de Chambord ». */
  place: string | null;
  suggestion: "pending" | "accepted" | "declined" | null;
  search: PlaceSearchDetail | null;
}

export async function placeMessageView(db: Db, accountId: string, row: { kind: "place_suggestion" | "place_results"; family_event_id: string | null; place_search_id: string | null }): Promise<PlaceMessageView> {
  const e = row.family_event_id ? await loadCalendarEvent(db, accountId, row.family_event_id) : undefined;
  const suggestion = row.kind === "place_suggestion" && row.family_event_id ? (await db.selectFrom("event_place_suggestions").select("answer").where("event_id", "=", row.family_event_id).executeTakeFirst())?.answer ?? null : null;
  const search = row.place_search_id ? await searchDetail(db, accountId, row.place_search_id) : null;
  return { kind: row.kind, eventId: e?.id ?? null, place: e?.place ?? search?.place ?? null, suggestion, search };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Exécution
// ---------------------------------------------------------------------------------------------------------------------------

async function complete(db: Db, id: string, status: "done" | "no_result" | "failed", options: { payload?: PlacePayload; reason?: string; checkedOn?: string; notify?: boolean }): Promise<boolean> {
  const bytes = options.payload && status === "done" ? seal(JSON.stringify(options.payload)) : null;
  const { rows } = await sql<{ ok: boolean }>`
    select complete_place_search(${id}::uuid, ${status}::place_search_status, ${bytes}::bytea, ${options.reason ?? null}, ${options.checkedOn ?? null}::date, ${options.notify ?? false}) as ok`.execute(db);
  return Boolean(rows[0]?.ok);
}

/** Exécute une recherche déjà prise (`running`) : interroge le service, retient les adresses, puis la termine. Une panne du service est un échec ; une recherche devenue obsolète est jetée. */
async function executeClaimed(ctx: Ctx, id: string, provider: PlaceProvider | null): Promise<void> {
  const row = await ctx.db.selectFrom("event_place_searches").select(["account_id", "event_id", "origin"]).where("id", "=", id).executeTakeFirst();
  if (!row) return;
  const e = await loadCalendarEvent(ctx.db, row.account_id, row.event_id);
  const notify = row.origin !== "chat";
  if (!provider) return void (await complete(ctx.db, id, "failed", { reason: "service_unavailable" }));
  if (!e || !e.place) return void (await complete(ctx.db, id, "failed", { reason: "error" }));
  const tz = (await ctx.db.selectFrom("accounts").select("family_timezone").where("id", "=", row.account_id).executeTakeFirst())?.family_timezone ?? "Europe/Paris";
  try {
    const real = pointOf(e.locationPoint);
    const found = await Promise.race([
      provider.search({ query: e.place, near: real ? roundedPoint(real) : null, at: e.startsAt }),
      new Promise<never>((_resolve, reject) => setTimeout(() => reject(new PlaceServiceError("délai dépassé")), SEARCH_TIMEOUT_MS)),
    ]);
    const maxWalk = await integerSetting(ctx.db, "place_search_max_walk_minutes", 15);
    const payload = selectPlaces(found.places, real ?? found.origin, maxWalk, provider.name);
    const any = CATEGORIES.some((c) => payload[c].length > 0);
    await complete(ctx.db, id, any ? "done" : "no_result", { payload, checkedOn: utcToLocal(ctx.now, tz).slice(0, 10), notify });
  } catch (error) {
    console.error(`Recherche « Sur place » : ${describeError(error)}`);
    await complete(ctx.db, id, "failed", { reason: error instanceof PlaceServiceError ? (error.message === "délai dépassé" ? "timeout" : "service_unavailable") : "error" });
  }
}

/** Lance la recherche qui vient d'être demandée (RT5) ; sans effet si elle a déjà été prise. */
export async function runPlaceSearch(ctx: Ctx, searchId: string, provider: PlaceProvider | null = placeProvider()): Promise<void> {
  const { rows } = await sql<{ id: string | null }>`select claim_place_search(${searchId}::uuid) as id`.execute(ctx.db);
  if (rows[0]?.id) await executeClaimed(ctx, rows[0].id, provider);
}

export interface PlacesResult {
  executed: number;
  failedStale: number;
  notified: number;
}

/**
 * Filet de sécurité du planificateur de 5 minutes (RT5) : reprend les recherches restées en attente plus de 30 secondes, fait échouer celles qui traînent (120 secondes en cours, 15 minutes
 * en attente), puis envoie « le résultat est prêt » aux profils qui ont lancé une recherche depuis le détail du RDV.
 */
export async function runPlaceSearches(ctx: Ctx, provider: PlaceProvider | null = placeProvider()): Promise<PlacesResult> {
  const totals: PlacesResult = { executed: 0, failedStale: 0, notified: 0 };
  const stale = await sql<{ n: number }>`select fail_stale_place_searches() as n`.execute(ctx.db);
  totals.failedStale = Number(stale.rows[0]?.n ?? 0);
  for (let i = 0; i < BATCH; i++) {
    const { rows } = await sql<{ id: string | null }>`select claim_place_search() as id`.execute(ctx.db);
    if (!rows[0]?.id) break;
    await executeClaimed(ctx, rows[0].id, provider);
    totals.executed += 1;
  }
  totals.notified = await sendReadyNotices(ctx);
  return totals;
}

/** « Où se garer et où manger près de [lieu] : le résultat est prêt. » : la base réserve la notification à la fin de la recherche ; elle part ici, par notification seulement (RF4). */
async function sendReadyNotices(ctx: Ctx): Promise<number> {
  const due = await sql<{ id: string; event_id: string; recipient_user_id: string; account_id: string }>`
    select n.id, n.event_id, n.recipient_user_id, e.account_id from scheduled_notifications n join family_events e on e.id = n.event_id
     where n.kind = 'place_search_ready' and n.status = 'scheduled' and n.attempts = 0 and n.due_at <= ${ctx.now} limit 50`.execute(ctx.db);
  let sent = 0;
  for (const row of due.rows) {
    try {
      // Une réservation par ligne : le premier passage qui la prend l'envoie.
      const claimed = await sql<{ id: string }>`update scheduled_notifications set attempts = 1 where id = ${row.id} and attempts = 0 returning id`.execute(ctx.db);
      if (!claimed.rows[0]) continue;
      const to = (await recipientsOf(ctx.db, row.account_id)).find((r) => r.id === row.recipient_user_id);
      const e = await loadCalendarEvent(ctx.db, row.account_id, row.event_id);
      if (!to || !e) {
        await ctx.db.updateTable("scheduled_notifications").set({ status: "not_applicable" }).where("id", "=", row.id).execute();
        continue;
      }
      const body = `Où se garer et où manger près de ${e.place ?? "ce lieu"} : le résultat est prêt.`;
      const out = await dispatch(ctx, row.account_id, to, { kind: "place_search_ready", userId: to.id, eventId: e.id, dueAt: ctx.now }, { body, url: to.parent ? "/assistant/demande" : `/calendrier/rdv/${e.id}#sur-place`, tag: `place-${e.id}`, subject: body, lines: [body] }, false);
      if (out === "sent") sent += 1;
    } catch (error) {
      console.error(`Notification « Sur place » : ${describeError(error)}`);
    }
  }
  return sent;
}
