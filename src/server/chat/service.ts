import { sql } from "kysely";
import { digitorn, type ActionProposal, type ChatEvent, type RequesterRank } from "@/server/adapters/digitorn";
import { messenger } from "@/server/adapters/messaging";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { autoParticipants } from "@/server/connectors/service";
import { Rejection } from "@/server/http";
import { getAgentInfoForm } from "@/server/profile/agent-info";
import { ensureDigitornRef } from "@/server/profile/digitorn-ref";
import { HISTORY_DAYS, LOW_CAP_THRESHOLD, MAX_REPORT_COMMENT, MAX_REQUEST_LENGTH } from "./rules";

/** Tchat avec un agent (US-37 à US-39, US-41, US-42, US-44, US-60, US-61, US-70). */

export { HISTORY_DAYS, LOW_CAP_THRESHOLD, MAX_REPORT_COMMENT, MAX_REQUEST_LENGTH };

export interface ChatGateItem {
  kind: "connector" | "info";
  label: string;
  responsible: "profile" | "primary_user";
  /** Connecteur déjà configuré un jour, dont l'autorisation a expiré ou été retirée : « À reconnecter ». */
  reconnect: boolean;
}

/** Écran informatif d'un agent « À configurer » : pas de champ de saisie (US-29). */
export interface ChatGate {
  items: ChatGateItem[];
  /** Le profil peut lui-même compléter au moins un élément. */
  canFix: boolean;
  primaryFirstName: string | null;
}

export type ChatItem =
  | { kind: "user"; id: string; requestId: string; text: string; at: string }
  | { kind: "agent"; id: string; requestId: string; text: string; at: string; reported: boolean }
  | {
      kind: "action";
      id: string;
      requestId: string;
      at: string;
      reported: boolean;
      proposal: ActionProposal;
      /** Moment de la décision de l'utilisateur, pour signaler une exécution trop longue (US-39 RF9). */
      decidedAt: string | null;
    };

export interface DailyCap {
  limit: number;
  used: number;
  remaining: number;
}

export interface ChatView {
  agent: { id: string; name: string; shortDescription: string };
  /** Message de maintenance quand l'agent est bloqué (US-42). */
  blocked: { message: string } | null;
  gate: ChatGate | null;
  suggestions: string[];
  items: ChatItem[];
  cap: DailyCap;
  now: string;
}

function requireProfile(session: SessionContext): void {
  if (session.user.role === "admin") throw new Rejection("forbidden", "Un administrateur n'a pas de tchat.", 403);
}

async function loadAgent(ctx: Ctx, session: SessionContext, agentId: string) {
  requireProfile(session);
  const agent = await ctx.db
    .selectFrom("profile_agents as pa")
    .innerJoin("agents as a", "a.id", "pa.agent_id")
    .select(["a.id", "a.name", "a.short_description", "a.status", "a.maintenance_message", "a.digitorn_agent_ref"])
    .where("pa.user_id", "=", session.user.id)
    .where("pa.agent_id", "=", agentId)
    .where("pa.removed_at", "is", null)
    .executeTakeFirst();
  if (!agent) throw new Rejection("not_found", "Cet agent n'est pas sur votre dashboard.", 404);
  return agent;
}

type LoadedAgent = Awaited<ReturnType<typeof loadAgent>>;

function blockedMessage(agent: LoadedAgent): string | null {
  return agent.status === "blocked" ? (agent.maintenance_message ?? "Cet agent est temporairement indisponible.") : null;
}

/** Jour calendaire dans le fuseau de l'appareil (US-70 RF5, hypothèse H35). */
export function localDay(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

async function dailyCap(ctx: Ctx, session: SessionContext): Promise<DailyCap> {
  const account = await ctx.db.selectFrom("accounts").select("daily_request_limit").where("id", "=", session.user.accountId!).executeTakeFirstOrThrow();
  const counter = await ctx.db
    .selectFrom("daily_request_counters")
    .select("request_count")
    .where("user_id", "=", session.user.id)
    .where("request_date", "=", sql<Date>`${localDay(ctx.now, session.device.timezone)}::date`)
    .executeTakeFirst();
  const used = counter?.request_count ?? 0;
  return { limit: account.daily_request_limit, used, remaining: Math.max(account.daily_request_limit - used, 0) };
}

async function gateOf(ctx: Ctx, session: SessionContext, agentId: string): Promise<ChatGate | null> {
  const rows = await ctx.db
    .selectFrom("v_profile_agent_missing_items")
    .select(["item_kind", "item_code", "responsible"])
    .where("user_id", "=", session.user.id)
    .where("agent_id", "=", agentId)
    .execute();
  if (rows.length === 0) return null;

  const connectorLabels = new Map(
    (await ctx.db.selectFrom("connector_types").select(["code", "label"]).execute()).map((c) => [c.code, c.label]),
  );
  const isPrimary = session.user.role === "primary_user";

  // Connexions à reconnecter : celles du profil, de l'utilisateur principal ou du compte (US-13 RT3).
  const primaryRow = isPrimary
    ? { id: session.user.id }
    : await ctx.db.selectFrom("users").select("id").where("account_id", "=", session.user.accountId!).where("role", "=", "primary_user").executeTakeFirstOrThrow();
  const stale = new Set<string>();
  for (const row of await ctx.db
    .selectFrom("agent_connections as c")
    .innerJoin("connector_types as t", "t.id", "c.connector_type_id")
    .select("t.code")
    .where("c.agent_id", "=", agentId)
    .where("c.user_id", "in", [session.user.id, primaryRow.id])
    .where("c.status", "=", "reconnect_required")
    .execute()) stale.add(row.code);
  for (const row of await ctx.db
    .selectFrom("account_connections as c")
    .innerJoin("connector_types as t", "t.id", "c.connector_type_id")
    .select("t.code")
    .where("c.account_id", "=", session.user.accountId!)
    .where("c.status", "=", "reconnect_required")
    .execute()) stale.add(row.code);

  const items = rows.map<ChatGateItem>((row) => ({
    kind: row.item_kind as "connector" | "info",
    label: row.item_kind === "connector" ? (connectorLabels.get(row.item_code!) ?? row.item_code!) : row.item_code!,
    responsible: row.responsible as "profile" | "primary_user",
    reconnect: row.item_kind === "connector" && stale.has(row.item_code!),
  }));
  const primary = isPrimary
    ? null
    : await ctx.db.selectFrom("users").select("first_name").where("account_id", "=", session.user.accountId!).where("role", "=", "primary_user").executeTakeFirst();
  return {
    items,
    canFix: isPrimary || items.some((item) => item.responsible === "profile"),
    primaryFirstName: primary?.first_name ?? null,
  };
}

/** Événements encore visibles : au plus 4 jours (US-44). */
function recent(events: ChatEvent[], now: Date): ChatEvent[] {
  const limit = now.getTime() - HISTORY_DAYS * 86_400_000;
  return events.filter((event) => new Date(event.at).getTime() >= limit);
}

async function conversationOf(ctx: Ctx, session: SessionContext, agent: LoadedAgent): Promise<ChatEvent[]> {
  const userRef = await ensureDigitornRef(ctx.db, session.user.id);
  return recent(await digitorn().getConversation(userRef, agent.digitorn_agent_ref), ctx.now);
}

/** Texte conservé avec un signalement pour une carte d'action. */
function describeProposal(proposal: ActionProposal): string {
  return [
    proposal.summary,
    proposal.when ? `Date : ${proposal.when}` : null,
    proposal.place ? `Lieu : ${proposal.place}` : null,
    proposal.subject ? `Objet : ${proposal.subject}` : null,
    proposal.draftPreview ? `Brouillon : ${proposal.draftPreview}` : null,
    proposal.recipient ? `Destinataire : ${proposal.recipient}` : null,
    proposal.participants.length ? `Participants : ${proposal.participants.join(", ")}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Contenu du tchat : état de l'agent (bloqué, à configurer), suggestions d'accueil, historique de
 * 4 jours, signalements déjà faits et reste de demandes du jour. Relu régulièrement par l'écran.
 */
export async function getChat(ctx: Ctx, session: SessionContext, agentId: string): Promise<ChatView> {
  const agent = await loadAgent(ctx, session, agentId);
  const base = {
    agent: { id: agent.id, name: agent.name, shortDescription: agent.short_description },
    cap: await dailyCap(ctx, session),
    now: ctx.now.toISOString(),
  };
  const blockedText = blockedMessage(agent);
  const gate = blockedText === null ? await gateOf(ctx, session, agentId) : null;

  const suggestions = (
    await ctx.db
      .selectFrom("agent_sample_prompts")
      .select("content")
      .where("agent_id", "=", agentId)
      .where("kind", "=", "first_suggestion")
      .orderBy("sort_order")
      .limit(3)
      .execute()
  ).map((p) => p.content);

  // Un agent à configurer n'ouvre pas de conversation (US-29) ; un agent bloqué garde son historique lisible (US-42).
  const events = gate ? [] : await conversationOf(ctx, session, agent);

  const reported = new Set(
    (await ctx.db.selectFrom("error_reports").select("message_ref").where("reporter_user_id", "=", session.user.id).where("agent_id", "=", agentId).execute()).map((r) => r.message_ref),
  );

  const proposalIds = events.filter((e) => e.type === "action_proposal").map((e) => (e as Extract<ChatEvent, { type: "action_proposal" }>).proposal.proposalId);
  const decisions = new Map(
    proposalIds.length
      ? (
          await ctx.db
            .selectFrom("action_decisions")
            .select(["external_action_ref", "decided_at", "execution_status"])
            .where("agent_id", "=", agentId)
            .where("external_action_ref", "in", proposalIds)
            .execute()
        ).map((d) => [d.external_action_ref, d] as const)
      : [],
  );

  const items: ChatItem[] = [];
  for (const event of events) {
    if (event.type === "user_message") {
      items.push({ kind: "user", id: event.id, requestId: event.requestId, text: event.text, at: event.at });
    } else if (event.type === "agent_message") {
      items.push({ kind: "agent", id: event.id, requestId: event.requestId, text: event.text, at: event.at, reported: reported.has(event.id) });
    } else {
      const decision = decisions.get(event.proposal.proposalId);
      // L'état d'exécution suit celui de Digitorn (US-39 RF9).
      if (decision && decision.execution_status === "running" && (event.proposal.status === "succeeded" || event.proposal.status === "failed")) {
        await ctx.db
          .updateTable("action_decisions")
          .set({ execution_status: event.proposal.status, updated_at: ctx.now })
          .where("agent_id", "=", agentId)
          .where("external_action_ref", "=", event.proposal.proposalId)
          .execute();
      }
      items.push({
        kind: "action",
        id: event.id,
        requestId: event.requestId,
        at: event.at,
        reported: reported.has(event.id),
        proposal: event.proposal,
        decidedAt: decision?.decided_at ? new Date(decision.decided_at).toISOString() : null,
      });
    }
  }

  return { ...base, blocked: blockedText === null ? null : { message: blockedText }, gate, suggestions, items, cap: base.cap };
}

// ---------------------------------------------------------------------------
// Envoi d'une demande (US-38, US-70)
// ---------------------------------------------------------------------------

export interface SendResult {
  requestId: string;
  cap: DailyCap;
}

function rankOf(session: SessionContext): RequesterRank {
  if (session.user.role === "primary_user") return "primary_user";
  return session.user.guestRank === "core" ? "core_guest" : "secondary_guest";
}

export function capReachedMessage(limit: number): string {
  return `Vous avez atteint le nombre maximum de demandes pour aujourd'hui (${limit}). Vous pourrez de nouveau solliciter les agents demain.`;
}

/**
 * Envoie une demande à l'agent. Le plafond du jour est vérifié avant tout appel à Digitorn et une
 * même demande (même identifiant) n'est comptée qu'une fois, même renvoyée (US-38 RT2, US-70 RF6).
 * Si l'envoi échoue, la demande n'est pas comptée (US-70 RF7).
 */
export async function sendMessage(
  ctx: Ctx,
  session: SessionContext,
  input: { agentId: string; requestId: string; text: string },
): Promise<SendResult> {
  const agent = await loadAgent(ctx, session, input.agentId);
  const blockedText = blockedMessage(agent);
  if (blockedText !== null) throw new Rejection("agent_blocked", `Cet agent est en maintenance : ${blockedText}`, 409);
  if (await gateOf(ctx, session, input.agentId)) throw new Rejection("agent_to_configure", "Cet agent doit d'abord être configuré.", 409);

  const text = input.text.trim();
  if (!text) throw new Rejection("empty_request", "Écrivez votre demande avant de l'envoyer.", 422);
  if (text.length > MAX_REQUEST_LENGTH) throw new Rejection("request_too_long", `Votre demande dépasse ${MAX_REQUEST_LENGTH} caractères.`, 422);

  const day = localDay(ctx.now, session.device.timezone);
  const counted = await ctx.db
    .insertInto("chat_requests")
    .values({ user_id: session.user.id, request_id: input.requestId, agent_id: input.agentId, counted_date: day, created_at: ctx.now })
    .onConflict((oc) => oc.columns(["user_id", "request_id"]).doNothing())
    .returning("request_id")
    .executeTakeFirst();

  // Première fois que cette demande arrive : elle compte dans le plafond du jour.
  if (counted) {
    const accepted = await sql<{ accepted: boolean }>`select register_agent_request(${session.user.id}::uuid, ${day}::date) as accepted`.execute(ctx.db);
    if (!accepted.rows[0]?.accepted) {
      await ctx.db.deleteFrom("chat_requests").where("user_id", "=", session.user.id).where("request_id", "=", input.requestId).execute();
      const { limit } = await dailyCap(ctx, session);
      throw new Rejection("daily_cap_reached", capReachedMessage(limit), 429, { limit });
    }
  }

  try {
    const [userRef, form, autoPeople, cc] = await Promise.all([
      ensureDigitornRef(ctx.db, session.user.id),
      getAgentInfoForm(ctx, session, session.user.id, input.agentId),
      autoParticipants(ctx.db, session),
      ctx.db.selectFrom("cc_addresses").select("email").where("user_id", "=", session.user.id).where("agent_id", "=", input.agentId).orderBy("created_at").orderBy("id").execute(),
    ]);
    await digitorn().submitRequest({
      requestId: input.requestId,
      userRef,
      agentRef: agent.digitorn_agent_ref,
      text,
      context: {
        rank: rankOf(session),
        autoParticipants: autoPeople.map((p) => p.email),
        ccAddresses: cc.map((c) => c.email),
        info: Object.fromEntries(form.fields.map((f) => [f.label, f.maxItems > 1 ? f.values : (f.values[0] ?? "")])),
      },
    });
  } catch (error) {
    // La demande n'est pas partie : elle ne compte pas, et un nouvel essai repart de zéro.
    if (counted) {
      await ctx.db.deleteFrom("chat_requests").where("user_id", "=", session.user.id).where("request_id", "=", input.requestId).execute();
      await ctx.db
        .updateTable("daily_request_counters")
        .set({ request_count: sql`greatest(request_count - 1, 0)` })
        .where("user_id", "=", session.user.id)
        .where("request_date", "=", sql<Date>`${day}::date`)
        .execute();
    }
    throw error;
  }
  return { requestId: input.requestId, cap: await dailyCap(ctx, session) };
}

// ---------------------------------------------------------------------------
// Validation d'une action proposée (US-39)
// ---------------------------------------------------------------------------

export interface DecisionResult {
  proposal: ActionProposal;
  decidedAt: string;
  /** La carte avait déjà reçu une décision : rien n'a été refait (US-39 RT1). */
  alreadyDecided: boolean;
}

/**
 * Valide ou refuse une carte d'action. Une carte ne reçoit qu'une décision (RF1, RT1), seul son
 * auteur peut décider (RF5) et rien ne se décide tant que l'agent est bloqué (US-42 RF3).
 */
export async function decideAction(
  ctx: Ctx,
  session: SessionContext,
  input: { agentId: string; proposalId: string; decision: "validate" | "refuse" },
): Promise<DecisionResult> {
  const agent = await loadAgent(ctx, session, input.agentId);
  if (blockedMessage(agent) !== null) {
    throw new Rejection("agent_blocked", "Cet agent est en maintenance : vous pourrez valider ou refuser dès sa remise en service.", 409);
  }

  const events = await conversationOf(ctx, session, agent);
  const found = events.find((e): e is Extract<ChatEvent, { type: "action_proposal" }> => e.type === "action_proposal" && e.proposal.proposalId === input.proposalId);
  if (!found) throw new Rejection("action_unavailable", "Cette action n'est plus disponible.", 404);

  await ctx.db
    .insertInto("action_decisions")
    .values({ agent_id: input.agentId, external_action_ref: input.proposalId, requester_user_id: session.user.id, created_at: ctx.now })
    .onConflict((oc) => oc.columns(["agent_id", "external_action_ref"]).doNothing())
    .execute();
  const row = await ctx.db
    .selectFrom("action_decisions")
    .select(["id", "requester_user_id", "decision", "decided_at"])
    .where("agent_id", "=", input.agentId)
    .where("external_action_ref", "=", input.proposalId)
    .executeTakeFirstOrThrow();
  if (row.requester_user_id !== session.user.id) throw new Rejection("forbidden", "Seul l'auteur de la demande peut valider ou refuser cette action.", 403);

  // Décision déjà prise (double envoi, autre appareil) : on rend l'état actuel sans rien refaire.
  if (row.decision !== "pending") {
    return { proposal: found.proposal, decidedAt: new Date(row.decided_at ?? ctx.now).toISOString(), alreadyDecided: true };
  }

  // La première décision l'emporte, même si deux arrivent en même temps.
  const claimed = await ctx.db
    .updateTable("action_decisions")
    .set({
      decision: input.decision === "validate" ? "validated" : "refused",
      decided_by_user_id: session.user.id,
      decided_at: ctx.now,
      execution_status: input.decision === "validate" ? "running" : "not_started",
      updated_at: ctx.now,
    })
    .where("id", "=", row.id)
    .where("decision", "=", "pending")
    .returning("id")
    .executeTakeFirst();
  if (!claimed) return { proposal: found.proposal, decidedAt: ctx.now.toISOString(), alreadyDecided: true };

  try {
    const proposal = await digitorn().decideAction({
      proposalId: input.proposalId,
      userRef: await ensureDigitornRef(ctx.db, session.user.id),
      decision: input.decision,
    });
    return { proposal, decidedAt: ctx.now.toISOString(), alreadyDecided: false };
  } catch (error) {
    // Digitorn n'a pas reçu la décision : la carte reste à décider.
    await ctx.db
      .updateTable("action_decisions")
      .set({ decision: "pending", decided_by_user_id: null, decided_at: null, execution_status: "not_started", updated_at: ctx.now })
      .where("id", "=", row.id)
      .execute();
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Signalement d'une erreur (US-61)
// ---------------------------------------------------------------------------

export type ReportCategory = "incorrect_response" | "wrong_action" | "other";

const CATEGORY_LABEL: Record<ReportCategory, string> = {
  incorrect_response: "Réponse incorrecte",
  wrong_action: "Action erronée",
  other: "Autre",
};

/**
 * Enregistre le signalement d'une réponse ou d'une action et le transmet au support (RF3 à RF7).
 * Une réponse ne se signale qu'une fois par personne (RF4). Le texte de la demande et de la réponse
 * est copié car l'historique du tchat disparaît (RF5).
 */
export async function reportError(
  ctx: Ctx,
  session: SessionContext,
  input: { agentId: string; messageRef: string; category: ReportCategory; comment?: string },
): Promise<{ alreadyReported: boolean }> {
  const agent = await loadAgent(ctx, session, input.agentId);
  const comment = input.comment?.trim() || null;
  if (comment && comment.length > MAX_REPORT_COMMENT) throw new Rejection("comment_too_long", `Le commentaire dépasse ${MAX_REPORT_COMMENT} caractères.`, 422);

  const events = await conversationOf(ctx, session, agent);
  const target = events.find((e) => e.id === input.messageRef && e.type !== "user_message");
  if (!target) throw new Rejection("message_unavailable", "Ce message n'est plus disponible.", 404);
  const responseText = target.type === "agent_message" ? target.text : target.type === "action_proposal" ? describeProposal(target.proposal) : "";
  const request = target.requestId ? events.find((e) => e.type === "user_message" && e.requestId === target.requestId) : undefined;
  const requestText = request?.type === "user_message" ? request.text : null;

  const inserted = await ctx.db
    .insertInto("error_reports")
    .values({
      reporter_user_id: session.user.id,
      reporter_role: session.user.role,
      agent_id: input.agentId,
      category: input.category,
      user_comment: comment,
      message_ref: input.messageRef,
      request_text: requestText,
      response_text: responseText,
      reported_at: ctx.now,
    })
    .onConflict((oc) => oc.columns(["reporter_user_id", "agent_id", "message_ref"]).doNothing())
    .returning("id")
    .executeTakeFirst();
  if (!inserted) return { alreadyReported: true };

  // Transmission au support : un échec d'envoi ne fait pas perdre le signalement, déjà enregistré.
  const support = await ctx.db.selectFrom("platform_settings").select("value_text").where("setting_key", "=", "support_email").executeTakeFirst();
  if (support?.value_text) {
    try {
      await messenger().sendEmail({
        to: support.value_text,
        subject: `Signalement d'erreur — ${agent.name}`,
        text:
          `Agent : ${agent.name}\nProfil : ${session.user.firstName} ${session.user.lastName} (${session.user.email})\n` +
          `Catégorie : ${CATEGORY_LABEL[input.category]}\n` +
          (comment ? `Commentaire : ${comment}\n` : "") +
          `\nDemande :\n${requestText ?? "(non disponible)"}\n\nRéponse signalée :\n${responseText}\n`,
      });
    } catch (error) {
      console.error("Signalement enregistré mais non transmis au support :", error);
    }
  }
  return { alreadyReported: false };
}
