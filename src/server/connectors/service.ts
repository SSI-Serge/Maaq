import { messenger } from "@/server/adapters/messaging";
import { digitorn, type AgentConfiguration, type GoogleConnector } from "@/server/adapters/digitorn";
import { codeRejection, sendRejection } from "@/server/auth/responses";
import { checkCode, issueCode } from "@/server/auth/codes";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { signToken, verifyToken } from "@/server/auth/tokens";
import { CODE_TTL_MINUTES } from "@/server/auth/rules";
import type { DB } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { Rejection } from "@/server/http";
import { ensureDigitornRef } from "@/server/profile/digitorn-ref";
import type { Kysely } from "kysely";

/** Connecteurs des agents (US-13 à US-17, US-67) : comptes Google, boîte de validation, adresses en copie. */

export type ConnectorCode = "google_drive" | "google_calendar" | "validation_mailbox";
export type Scope = "each_profile" | "primary_user" | "account";
export type ConnectionStatus = "none" | "pending" | "connected" | "refused" | "partial" | "reconnect_required";

const EMAIL_FORMAT = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const AUTHORIZATION_MINUTES = 30;

/** Permissions demandées, en langage courant (US-14 RF2). Seules les permissions nécessaires sont demandées. */
export const PERMISSIONS: Record<GoogleConnector, string[]> = {
  google_drive: ["Lire vos documents Google Drive", "Créer et déplacer des fichiers dans les dossiers dédiés"],
  google_calendar: ["Consulter et créer des événements dans votre agenda"],
};

export interface ConnectorView {
  code: ConnectorCode;
  label: string;
  kind: "google" | "mailbox";
  scope: Scope;
  status: ConnectionStatus;
  email: string | null;
  /** Le profil peut-il modifier ce connecteur ? Faux pour un invité devant une connexion de l'utilisateur principal. */
  editable: boolean;
  /** Prénom de l'utilisateur principal, quand c'est à lui de configurer. */
  ownerFirstName: string | null;
  permissions: string[];
}

export interface CcView {
  max: number;
  autoParticipants: { email: string; name: string }[];
  addresses: string[];
}

export interface AgentTab {
  agentId: string;
  name: string;
  connectors: ConnectorView[];
  cc: CcView | null;
}

export interface ConnectorsOverview {
  agents: AgentTab[];
  /** Compte Google déjà connecté par ce profil pour un autre agent, proposé pour éviter de le ressaisir (US-13 RF7). */
  suggestedEmail: string | null;
}

type Target = { kind: "profile"; userId: string } | { kind: "account"; accountId: string };

interface Requirement {
  connectorTypeId: number;
  code: ConnectorCode;
  label: string;
  scope: Scope;
}

interface Connection {
  id: string;
  email: string;
  status: Exclude<ConnectionStatus, "none">;
}

function requireProfile(session: SessionContext): void {
  if (session.user.role === "admin") throw new Rejection("forbidden", "Un administrateur n'a pas de connecteurs.", 403);
}

async function primaryOf(db: Kysely<DB>, accountId: string) {
  return db
    .selectFrom("users")
    .select(["id", "first_name", "last_name", "email"])
    .where("account_id", "=", accountId)
    .where("role", "=", "primary_user")
    .executeTakeFirstOrThrow();
}

/**
 * Qui détient la connexion et qui peut la modifier : chaque profil gère la sienne ; la connexion
 * « utilisateur principal » et celle du compte ne se modifient que par l'utilisateur principal (US-13 RF3, US-67 RF3).
 */
function targetFor(session: SessionContext, scope: Scope, primaryId: string): { target: Target; editable: boolean } {
  const isPrimary = session.user.role === "primary_user";
  if (scope === "account") return { target: { kind: "account", accountId: session.user.accountId! }, editable: isPrimary };
  if (scope === "primary_user") return { target: { kind: "profile", userId: primaryId }, editable: isPrimary };
  return { target: { kind: "profile", userId: session.user.id }, editable: true };
}

async function loadConnection(db: Kysely<DB>, target: Target, agentId: string, connectorTypeId: number): Promise<Connection | null> {
  if (target.kind === "account") {
    const row = await db
      .selectFrom("account_connections")
      .select(["id", "connected_email", "status"])
      .where("account_id", "=", target.accountId)
      .where("connector_type_id", "=", connectorTypeId)
      .executeTakeFirst();
    return row ? { id: row.id, email: row.connected_email, status: row.status } : null;
  }
  const row = await db
    .selectFrom("agent_connections")
    .select(["id", "connected_email", "status"])
    .where("user_id", "=", target.userId)
    .where("agent_id", "=", agentId)
    .where("connector_type_id", "=", connectorTypeId)
    .executeTakeFirst();
  return row ? { id: row.id, email: row.connected_email, status: row.status } : null;
}

async function saveConnection(
  ctx: Ctx,
  actingUserId: string,
  target: Target,
  agentId: string,
  connectorTypeId: number,
  email: string,
  status: Exclude<ConnectionStatus, "none">,
): Promise<string> {
  if (target.kind === "account") {
    const row = await ctx.db
      .insertInto("account_connections")
      .values({ account_id: target.accountId, connector_type_id: connectorTypeId, connected_email: email, status, connected_by_user_id: actingUserId, status_changed_at: ctx.now })
      .onConflict((oc) =>
        oc.columns(["account_id", "connector_type_id"]).doUpdateSet({
          connected_email: email,
          status,
          connected_by_user_id: actingUserId,
          status_changed_at: ctx.now,
          updated_at: ctx.now,
        }),
      )
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  }
  const row = await ctx.db
    .insertInto("agent_connections")
    .values({ user_id: target.userId, agent_id: agentId, connector_type_id: connectorTypeId, connected_email: email, status, status_changed_at: ctx.now })
    .onConflict((oc) =>
      oc.columns(["user_id", "agent_id", "connector_type_id"]).doUpdateSet({ connected_email: email, status, status_changed_at: ctx.now, updated_at: ctx.now }),
    )
    .returning("id")
    .executeTakeFirstOrThrow();
  return row.id;
}

async function deleteConnection(ctx: Ctx, target: Target, agentId: string, connectorTypeId: number): Promise<void> {
  if (target.kind === "account") {
    await ctx.db.deleteFrom("account_connections").where("account_id", "=", target.accountId).where("connector_type_id", "=", connectorTypeId).execute();
  } else {
    await ctx.db
      .deleteFrom("agent_connections")
      .where("user_id", "=", target.userId)
      .where("agent_id", "=", agentId)
      .where("connector_type_id", "=", connectorTypeId)
      .execute();
  }
}

async function requirementsOf(db: Kysely<DB>, agentId: string): Promise<Requirement[]> {
  const rows = await db
    .selectFrom("agent_requirements as r")
    .innerJoin("connector_types as t", "t.id", "r.connector_type_id")
    .select(["t.id", "t.code", "t.label", "r.owner_scope"])
    .where("r.agent_id", "=", agentId)
    .orderBy("t.id")
    .execute();
  return rows.map((r) => ({ connectorTypeId: r.id, code: r.code as ConnectorCode, label: r.label, scope: r.owner_scope }));
}

/** Agent présent sur le dashboard du profil, avec le connecteur demandé (sinon 404). */
async function requireAgentConnector(ctx: Ctx, session: SessionContext, agentId: string, connector: ConnectorCode) {
  requireProfile(session);
  const agent = await ctx.db
    .selectFrom("profile_agents as pa")
    .innerJoin("agents as a", "a.id", "pa.agent_id")
    .select(["a.id", "a.name", "a.digitorn_agent_ref", "a.cc_addresses_max_count"])
    .where("pa.user_id", "=", session.user.id)
    .where("pa.agent_id", "=", agentId)
    .where("pa.removed_at", "is", null)
    .executeTakeFirst();
  const requirement = agent ? (await requirementsOf(ctx.db, agentId)).find((r) => r.code === connector) : undefined;
  if (!agent || !requirement) throw new Rejection("not_found", "Ce connecteur n'existe pas pour cet agent.", 404);
  const primary = await primaryOf(ctx.db, session.user.accountId!);
  const { target, editable } = targetFor(session, requirement.scope, primary.id);
  return { agent, requirement, target, editable, primary };
}

function notEditable(primaryFirstName: string): Rejection {
  return new Rejection("forbidden", `Seul ${primaryFirstName}, l'utilisateur principal, peut configurer ce connecteur.`, 403);
}

// ---------------------------------------------------------------------------
// Vue d'ensemble (US-13 RF1, RF3, RF6, RF7)
// ---------------------------------------------------------------------------

export async function getOverview(ctx: Ctx, session: SessionContext): Promise<ConnectorsOverview> {
  requireProfile(session);
  const primary = await primaryOf(ctx.db, session.user.accountId!);
  const agents = await ctx.db
    .selectFrom("profile_agents as pa")
    .innerJoin("agents as a", "a.id", "pa.agent_id")
    .select(["a.id", "a.name", "a.cc_addresses_max_count"])
    .where("pa.user_id", "=", session.user.id)
    .where("pa.removed_at", "is", null)
    .orderBy("pa.added_at")
    .execute();

  const tabs: AgentTab[] = [];
  for (const agent of agents) {
    const requirements = await requirementsOf(ctx.db, agent.id);
    if (requirements.length === 0 && agent.cc_addresses_max_count === 0) continue;

    const connectors: ConnectorView[] = [];
    for (const requirement of requirements) {
      const { target, editable } = targetFor(session, requirement.scope, primary.id);
      const connection = await loadConnection(ctx.db, target, agent.id, requirement.connectorTypeId);
      const kind = requirement.code === "validation_mailbox" ? "mailbox" : "google";
      connectors.push({
        code: requirement.code,
        label: requirement.scope === "account" && requirement.code === "google_drive" ? "Google Drive du compte" : requirement.label,
        kind,
        scope: requirement.scope,
        status: connection?.status ?? "none",
        email: connection?.email ?? null,
        editable,
        ownerFirstName: editable ? null : primary.first_name,
        permissions: kind === "google" ? PERMISSIONS[requirement.code as GoogleConnector] : [],
      });
    }
    tabs.push({ agentId: agent.id, name: agent.name, connectors, cc: agent.cc_addresses_max_count > 0 ? await ccView(ctx, session, agent.id, agent.cc_addresses_max_count) : null });
  }

  return { agents: tabs, suggestedEmail: await suggestedEmail(ctx, session) };
}

async function suggestedEmail(ctx: Ctx, session: SessionContext): Promise<string | null> {
  const own = await ctx.db
    .selectFrom("agent_connections as c")
    .innerJoin("connector_types as t", "t.id", "c.connector_type_id")
    .select("c.connected_email")
    .where("c.user_id", "=", session.user.id)
    .where("c.status", "=", "connected")
    .where("t.code", "in", ["google_drive", "google_calendar"])
    .orderBy("c.status_changed_at", "desc")
    .executeTakeFirst();
  if (own) return own.connected_email;
  if (session.user.role !== "primary_user" || !session.user.accountId) return null;
  const account = await ctx.db
    .selectFrom("account_connections")
    .select("connected_email")
    .where("account_id", "=", session.user.accountId)
    .where("status", "=", "connected")
    .executeTakeFirst();
  return account?.connected_email ?? null;
}

// ---------------------------------------------------------------------------
// Comptes Google (US-13, US-14, US-67)
// ---------------------------------------------------------------------------

function googleOnly(connector: ConnectorCode): GoogleConnector {
  if (connector === "validation_mailbox") throw new Rejection("invalid_connector", "Ce connecteur ne passe pas par Google.", 422);
  return connector;
}

function checkEmail(email: string): string {
  const value = email.trim();
  if (!EMAIL_FORMAT.test(value)) throw new Rejection("invalid_email", "Adresse email invalide", 422, { email: "Adresse email invalide" });
  return value;
}

export interface AuthorizeResult {
  /** Page de consentement Google vers laquelle envoyer l'utilisateur ; absente si le compte est déjà connecté. */
  consentUrl: string | null;
}

/**
 * Enregistre l'adresse (statut « Autorisation en attente ») et démarre le consentement Google (US-13 RF5, US-14 RF3).
 * Sans adresse, reprend le parcours avec celle déjà enregistrée (US-14 RF11).
 */
export async function authorizeConnection(
  ctx: Ctx,
  session: SessionContext,
  input: { agentId: string; connector: ConnectorCode; email?: string },
): Promise<AuthorizeResult> {
  const connector = googleOnly(input.connector);
  const { requirement, target, editable, primary } = await requireAgentConnector(ctx, session, input.agentId, input.connector);
  if (!editable) throw notEditable(primary.first_name);

  const existing = await loadConnection(ctx.db, target, input.agentId, requirement.connectorTypeId);
  const email = input.email !== undefined ? checkEmail(input.email) : existing?.email;
  if (!email) throw new Rejection("invalid_email", "Indiquez l'adresse du compte Google.", 422, { email: "Adresse email invalide" });

  // Même compte déjà connecté : rien à faire (le panneau ne s'ouvre que s'il manque des permissions, US-14 RF1).
  if (existing?.status === "connected" && existing.email.toLowerCase() === email.toLowerCase()) return { consentUrl: null };

  const profileRef = await ensureDigitornRef(ctx.db, session.user.id);
  // Changer d'adresse retire l'autorisation de l'ancien compte (US-13 RF8, US-67 RF9).
  if (existing && existing.status !== "pending" && existing.email.toLowerCase() !== email.toLowerCase()) {
    await digitorn().revokeAuthorization(profileRef, connector, existing.email);
  }

  await saveConnection(ctx, session.user.id, target, input.agentId, requirement.connectorTypeId, email, "pending");
  const state = signToken({ kind: "connector", userId: session.user.id, agentId: input.agentId, connector, email, exp: ctx.now.getTime() + AUTHORIZATION_MINUTES * 60_000 });
  const returnUrl = `${env().APP_URL.replace(/\/$/, "")}/connecteurs/retour?etat=${encodeURIComponent(state)}`;
  const { consentUrl } = await digitorn().beginAuthorization({ state, profileRef, connector, email, returnUrl });
  return { consentUrl };
}

/** Refus du panneau de permissions : le connecteur passe à « Autorisation refusée » (US-14 RF4). */
export async function refuseConnection(ctx: Ctx, session: SessionContext, input: { agentId: string; connector: ConnectorCode; email: string }): Promise<void> {
  googleOnly(input.connector);
  const { requirement, target, editable, primary } = await requireAgentConnector(ctx, session, input.agentId, input.connector);
  if (!editable) throw notEditable(primary.first_name);
  await saveConnection(ctx, session.user.id, target, input.agentId, requirement.connectorTypeId, checkEmail(input.email), "refused");
}

export type FinalizeOutcome = "authorized" | "partial" | "denied" | "pending";

export interface FinalizeResult {
  outcome: FinalizeOutcome;
  agentId: string;
  agentName: string;
  connector: GoogleConnector;
  email: string;
  /** L'utilisateur a autorisé un autre compte que celui saisi : l'adresse enregistrée est remplacée (US-14 RF6). */
  emailReplaced: boolean;
  /** Permissions non accordées en cas d'autorisation partielle (US-14 RF5). */
  missing: string[];
}

const STATUS_OUTCOME: Record<Exclude<ConnectionStatus, "none">, FinalizeOutcome> = {
  connected: "authorized",
  partial: "partial",
  refused: "denied",
  pending: "pending",
  reconnect_required: "pending",
};

/** Retour de la page Google : lit le résultat auprès de Digitorn et met à jour le statut (US-14 RF3 à RF6, RF8). */
export async function finalizeConnection(ctx: Ctx, session: SessionContext, state: string): Promise<FinalizeResult> {
  const payload = verifyToken<{ exp: number; kind?: string; userId: string; agentId: string; connector: GoogleConnector; email: string }>(state, ctx.now);
  if (!payload || payload.kind !== "connector" || payload.userId !== session.user.id) {
    throw new Rejection("invalid_state", "Ce retour de connexion n'est plus valable. Recommencez la connexion.", 400);
  }
  const { agent, requirement, target } = await requireAgentConnector(ctx, session, payload.agentId, payload.connector);
  const base = { agentId: agent.id, agentName: agent.name, connector: payload.connector };
  const current = await loadConnection(ctx.db, target, agent.id, requirement.connectorTypeId);

  // Une connexion plus récente a pris la place, ou ce retour a déjà été traité : on rend l'état actuel.
  if (!current || current.status !== "pending" || current.email.toLowerCase() !== payload.email.toLowerCase()) {
    const status = current?.status ?? "refused";
    return { ...base, outcome: STATUS_OUTCOME[status], email: current?.email ?? payload.email, emailReplaced: false, missing: [] };
  }

  const result = await digitorn().getAuthorizationResult(state);
  if (result.status === "pending") return { ...base, outcome: "pending", email: payload.email, emailReplaced: false, missing: [] };

  const status = result.status === "authorized" ? "connected" : result.status === "partial" ? "partial" : "refused";
  const email = result.status === "denied" ? payload.email : result.accountEmail;
  await saveConnection(ctx, session.user.id, target, agent.id, requirement.connectorTypeId, email, status);
  if (status === "connected") await syncAgentConfiguration(ctx, session.user.id, agent.id);
  return { ...base, outcome: result.status, email, emailReplaced: email.toLowerCase() !== payload.email.toLowerCase(), missing: result.status === "partial" ? result.missing : [] };
}

/** Retire un connecteur après confirmation : les actions qui en dépendent deviennent indisponibles (US-13 RF9, US-67 RF10). */
export async function disconnect(ctx: Ctx, session: SessionContext, input: { agentId: string; connector: ConnectorCode }): Promise<void> {
  const { requirement, target, editable, primary } = await requireAgentConnector(ctx, session, input.agentId, input.connector);
  if (!editable) throw notEditable(primary.first_name);
  const existing = await loadConnection(ctx.db, target, input.agentId, requirement.connectorTypeId);
  if (!existing) return; // déjà déconnecté (double envoi)
  if (input.connector !== "validation_mailbox") {
    await digitorn().revokeAuthorization(await ensureDigitornRef(ctx.db, session.user.id), input.connector, existing.email);
  }
  await deleteConnection(ctx, target, input.agentId, requirement.connectorTypeId);
  await syncAgentConfiguration(ctx, session.user.id, input.agentId);
}

/**
 * Digitorn signale une autorisation expirée ou révoquée depuis le compte Google : les connexions
 * concernées passent à « À reconnecter » (US-13 RT3, US-14 RF7, US-67 RT3).
 */
export async function reportRevokedAuthorization(
  ctx: Ctx,
  input: { profileRef: string; connector: GoogleConnector; email: string },
): Promise<number> {
  const type = await ctx.db.selectFrom("connector_types").select("id").where("code", "=", input.connector).executeTakeFirstOrThrow();
  const user = await ctx.db.selectFrom("users").select(["id", "account_id", "role"]).where("digitorn_user_ref", "=", input.profileRef).executeTakeFirst();
  if (!user) return 0;
  const own = await ctx.db
    .updateTable("agent_connections")
    .set({ status: "reconnect_required", status_changed_at: ctx.now, updated_at: ctx.now })
    .where("user_id", "=", user.id)
    .where("connector_type_id", "=", type.id)
    .where("connected_email", "=", input.email)
    .where("status", "=", "connected")
    .executeTakeFirst();
  let count = Number(own.numUpdatedRows);
  if (user.account_id) {
    const account = await ctx.db
      .updateTable("account_connections")
      .set({ status: "reconnect_required", status_changed_at: ctx.now, updated_at: ctx.now })
      .where("account_id", "=", user.account_id)
      .where("connector_type_id", "=", type.id)
      .where("connected_email", "=", input.email)
      .where("status", "=", "connected")
      .executeTakeFirst();
    count += Number(account.numUpdatedRows);
  }
  return count;
}

// ---------------------------------------------------------------------------
// Boîte de validation (US-15)
// ---------------------------------------------------------------------------

export interface MailboxResult {
  status: ConnectionStatus;
  resendAvailableAt: string | null;
}

async function sendMailboxCode(ctx: Ctx, session: SessionContext, connectionId: string, email: string, agentName: string): Promise<Date> {
  const issued = await issueCode(ctx.db, {
    userId: session.user.id,
    purpose: "validation_mailbox",
    channel: "email",
    target: email,
    agentConnectionId: connectionId,
    now: ctx.now,
  });
  if (!issued.ok) throw sendRejection({ kind: issued.reason, retryAt: issued.retryAt });
  await messenger().sendEmail({
    to: email,
    subject: `Votre code MAAQ : ${issued.code}`,
    text:
      `Bonjour ${session.user.firstName},\n\n` +
      `Voici le code pour vérifier cette adresse comme boîte de validation de ${agentName} : ${issued.code}\n\n` +
      `Il est valable ${CODE_TTL_MINUTES.validation_mailbox} minutes. Cette boîte recevra les brouillons à relire avant tout envoi en votre nom ; ` +
      `la validation se fait ensuite dans le tchat de l'agent.\n\nL'équipe MAAQ`,
  });
  return issued.resendAvailableAt;
}

/**
 * Enregistre l'adresse de validation et envoie le code de vérification (US-15 RF2 à RF4). Modifier
 * l'adresse relance la vérification (RF7).
 */
export async function saveMailbox(ctx: Ctx, session: SessionContext, input: { agentId: string; email: string }): Promise<MailboxResult> {
  const { agent, requirement, target, editable, primary } = await requireAgentConnector(ctx, session, input.agentId, "validation_mailbox");
  if (!editable) throw notEditable(primary.first_name);
  const email = checkEmail(input.email);

  const existing = await loadConnection(ctx.db, target, input.agentId, requirement.connectorTypeId);
  if (existing?.status === "connected" && existing.email.toLowerCase() === email.toLowerCase()) return { status: "connected", resendAvailableAt: null };

  const id = await saveConnection(ctx, session.user.id, target, input.agentId, requirement.connectorTypeId, email, "pending");
  const resendAt = await sendMailboxCode(ctx, session, id, email, agent.name);
  return { status: "pending", resendAvailableAt: resendAt.toISOString() };
}

/** Nouveau code pour l'adresse en cours de vérification. */
export async function resendMailboxCode(ctx: Ctx, session: SessionContext, input: { agentId: string }): Promise<MailboxResult> {
  const { agent, requirement, target, editable, primary } = await requireAgentConnector(ctx, session, input.agentId, "validation_mailbox");
  if (!editable) throw notEditable(primary.first_name);
  const existing = await loadConnection(ctx.db, target, input.agentId, requirement.connectorTypeId);
  if (!existing || existing.status !== "pending") throw new Rejection("nothing_to_verify", "Aucune adresse n'attend de vérification.", 409);
  const resendAt = await sendMailboxCode(ctx, session, existing.id, existing.email, agent.name);
  return { status: "pending", resendAvailableAt: resendAt.toISOString() };
}

/** Vérifie le code : la boîte devient active et la configuration est transmise à Digitorn (US-15 RF4, RT1). */
export async function verifyMailbox(ctx: Ctx, session: SessionContext, input: { agentId: string; code: string }): Promise<MailboxResult> {
  const { requirement, target, editable, primary } = await requireAgentConnector(ctx, session, input.agentId, "validation_mailbox");
  if (!editable) throw notEditable(primary.first_name);
  const existing = await loadConnection(ctx.db, target, input.agentId, requirement.connectorTypeId);
  if (existing?.status === "connected") return { status: "connected", resendAvailableAt: null };
  if (!existing) throw new Rejection("nothing_to_verify", "Aucune adresse n'attend de vérification.", 409);

  const result = await checkCode(ctx.db, {
    userId: session.user.id,
    purpose: "validation_mailbox",
    code: input.code,
    agentConnectionId: existing.id,
    now: ctx.now,
  });
  if (result !== "ok") throw codeRejection(result);
  await saveConnection(ctx, session.user.id, target, input.agentId, requirement.connectorTypeId, existing.email, "connected");
  await syncAgentConfiguration(ctx, session.user.id, input.agentId);
  return { status: "connected", resendAvailableAt: null };
}

// ---------------------------------------------------------------------------
// Adresses en copie systématique (US-16, US-17)
// ---------------------------------------------------------------------------

/**
 * Participants ajoutés d'office aux rendez-vous du profil selon son rang (décision D2) :
 * utilisateur principal → invité 1 ; invité 1 → utilisateur principal ; invité secondaire → les deux.
 */
export async function autoParticipants(db: Kysely<DB>, session: SessionContext): Promise<{ email: string; name: string }[]> {
  const accountId = session.user.accountId!;
  const people = await db
    .selectFrom("users")
    .select(["email", "first_name", "last_name", "role", "guest_rank"])
    .where("account_id", "=", accountId)
    .where("status", "<>", "removed")
    .where((eb) => eb.or([eb("role", "=", "primary_user"), eb("guest_rank", "=", "core")]))
    .execute();
  const named = (p: (typeof people)[number]) => ({ email: p.email, name: `${p.first_name} ${p.last_name}` });
  const primary = people.find((p) => p.role === "primary_user");
  const core = people.find((p) => p.guest_rank === "core");
  if (session.user.role === "primary_user") return core ? [named(core)] : [];
  if (session.user.guestRank === "core") return primary ? [named(primary)] : [];
  return [primary, core].filter((p): p is (typeof people)[number] => p !== undefined).map(named);
}

async function ccView(ctx: Ctx, session: SessionContext, agentId: string, max: number): Promise<CcView> {
  const addresses = await ctx.db
    .selectFrom("cc_addresses")
    .select("email")
    .where("user_id", "=", session.user.id)
    .where("agent_id", "=", agentId)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  return { max, autoParticipants: await autoParticipants(ctx.db, session), addresses: addresses.map((a) => a.email) };
}

async function requireCcAgent(ctx: Ctx, session: SessionContext, agentId: string) {
  requireProfile(session);
  const agent = await ctx.db
    .selectFrom("profile_agents as pa")
    .innerJoin("agents as a", "a.id", "pa.agent_id")
    .select(["a.id", "a.cc_addresses_max_count"])
    .where("pa.user_id", "=", session.user.id)
    .where("pa.agent_id", "=", agentId)
    .where("pa.removed_at", "is", null)
    .executeTakeFirst();
  if (!agent || agent.cc_addresses_max_count === 0) throw new Rejection("not_found", "Cet agent ne propose pas d'adresses en copie.", 404);
  return agent;
}

/** Ajoute une adresse en copie ; refus si elle est déjà couverte (US-16 RF3, US-17 RF4) ou si la limite est atteinte (RF4). */
export async function addCcAddress(ctx: Ctx, session: SessionContext, input: { agentId: string; email: string }): Promise<CcView> {
  const agent = await requireCcAgent(ctx, session, input.agentId);
  const email = checkEmail(input.email);
  const lower = email.toLowerCase();

  const view = await ccView(ctx, session, input.agentId, agent.cc_addresses_max_count);
  if (view.addresses.some((a) => a.toLowerCase() === lower)) throw new Rejection("duplicate_cc", "Cette adresse est déjà dans la liste.", 409, { email: "Cette adresse est déjà dans la liste." });
  // Le profil lui-même et ses participants automatiques sont déjà en copie.
  if (lower === session.user.email.toLowerCase() || view.autoParticipants.some((p) => p.email.toLowerCase() === lower)) {
    throw new Rejection("already_cc", "Cette personne est déjà en copie", 409, { email: "Cette personne est déjà en copie" });
  }

  try {
    await ctx.db.insertInto("cc_addresses").values({ user_id: session.user.id, agent_id: input.agentId, email, created_at: ctx.now }).execute();
  } catch (error) {
    if (/Limite d'adresses en copie/.test((error as Error).message)) {
      throw new Rejection(
        "cc_limit",
        `Vous avez atteint le maximum de ${agent.cc_addresses_max_count} adresses en copie pour cet agent. Retirez une adresse pour en ajouter une nouvelle.`,
        409,
        { max: agent.cc_addresses_max_count },
      );
    }
    throw error;
  }
  await syncAgentConfiguration(ctx, session.user.id, input.agentId);
  return ccView(ctx, session, input.agentId, agent.cc_addresses_max_count);
}

/** Retire une adresse ; les événements déjà créés ne changent pas (US-16 RF8, US-17 RF6). */
export async function removeCcAddress(ctx: Ctx, session: SessionContext, input: { agentId: string; email: string }): Promise<CcView> {
  const agent = await requireCcAgent(ctx, session, input.agentId);
  await ctx.db.deleteFrom("cc_addresses").where("user_id", "=", session.user.id).where("agent_id", "=", input.agentId).where("email", "=", input.email.trim()).execute();
  await syncAgentConfiguration(ctx, session.user.id, input.agentId);
  return ccView(ctx, session, input.agentId, agent.cc_addresses_max_count);
}

// ---------------------------------------------------------------------------
// Transmission à Digitorn (US-15 RT1, US-16 RT2)
// ---------------------------------------------------------------------------

/**
 * Transmet à Digitorn la configuration d'un agent pour un profil : comptes Google connectés, boîte de
 * validation active et adresses en copie. Appelée à chaque changement, jamais à chaque demande.
 */
export async function syncAgentConfiguration(ctx: Ctx, userId: string, agentId: string): Promise<AgentConfiguration> {
  const user = await ctx.db.selectFrom("users").select(["id", "account_id", "role"]).where("id", "=", userId).executeTakeFirstOrThrow();
  const agent = await ctx.db.selectFrom("agents").select("digitorn_agent_ref").where("id", "=", agentId).executeTakeFirstOrThrow();
  const primaryId = user.account_id ? (await primaryOf(ctx.db, user.account_id)).id : user.id;

  const config: AgentConfiguration = { validationMailbox: null, googleAccounts: {}, ccAddresses: [] };
  for (const requirement of await requirementsOf(ctx.db, agentId)) {
    const target: Target =
      requirement.scope === "account" && user.account_id
        ? { kind: "account", accountId: user.account_id }
        : { kind: "profile", userId: requirement.scope === "primary_user" ? primaryId : user.id };
    const connection = await loadConnection(ctx.db, target, agentId, requirement.connectorTypeId);
    if (connection?.status !== "connected") continue;
    if (requirement.code === "validation_mailbox") config.validationMailbox = connection.email;
    else config.googleAccounts[requirement.code] = connection.email;
  }
  const cc = await ctx.db.selectFrom("cc_addresses").select("email").where("user_id", "=", userId).where("agent_id", "=", agentId).orderBy("created_at").orderBy("id").execute();
  config.ccAddresses = cc.map((c) => c.email);

  await digitorn().updateAgentConfiguration(await ensureDigitornRef(ctx.db, userId), agent.digitorn_agent_ref, config);
  return config;
}
