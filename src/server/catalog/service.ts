import type { Ctx, SessionContext } from "@/server/auth/service";
import { processChatErasure } from "@/server/auth/service";
import { Rejection } from "@/server/http";
import { integerSetting } from "@/server/settings";

/** Catalogue d'agents et dashboard d'un profil (US-22 à US-28). */

export type CategoryCode = "pro" | "perso" | "contracts";
export type DisplayStatus = "ready" | "to_configure" | "blocked";

export const CATEGORY_LABEL: Record<CategoryCode, string> = { pro: "Pro", perso: "Perso", contracts: "Agents des Contrats" };

export interface CatalogItem {
  id: string;
  name: string;
  shortDescription: string;
  category: CategoryCode;
  categoryLabel: string;
  maintenance: boolean;
  added: boolean;
}

export interface DashboardAgent {
  id: string;
  name: string;
  shortDescription: string;
  status: DisplayStatus;
  maintenanceMessage: string | null;
}

export interface Dashboard {
  max: number;
  /** « contracts » alimente l'onglet « Agents des Contrats » de la page Contrats (US-31). */
  tabs: Record<"pro" | "perso" | "contracts", DashboardAgent[]>;
}

function requireProfileWithDashboard(session: SessionContext): void {
  if (session.user.role === "admin") throw new Rejection("forbidden", "Un administrateur n'a pas de dashboard.", 403);
}

/**
 * Rubriques visibles : un invité secondaire n'a pas accès aux Agents des Contrats, ni dans le
 * catalogue ni dans la recherche (US-23 RF11, US-25 RF9).
 */
export function visibleCategories(session: SessionContext): CategoryCode[] {
  const secondaryGuest = session.user.role === "guest" && session.user.guestRank === "secondary";
  return secondaryGuest ? ["pro", "perso"] : ["pro", "perso", "contracts"];
}

/** Sans accents ni majuscules, pour la recherche (US-25 RF2). */
export function normalizeText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

export const SEARCH_MIN_LENGTH = 2;

/**
 * Catalogue d'une rubrique, par ordre alphabétique (US-23), ou résultats d'une recherche sur le
 * nom, la description et les exemples de demandes, toutes rubriques confondues (US-25).
 */
export async function listCatalog(
  ctx: Ctx,
  session: SessionContext,
  options: { category?: CategoryCode; query?: string },
): Promise<CatalogItem[]> {
  requireProfileWithDashboard(session);
  const allowed = visibleCategories(session);
  const query = normalizeText(options.query ?? "");
  const searching = query.length >= SEARCH_MIN_LENGTH;
  const categories = searching || !options.category ? allowed : allowed.filter((c) => c === options.category);
  // Rubrique non visible pour ce profil (ex. Contrats pour un invité secondaire) : rien à montrer.
  if (categories.length === 0) return [];

  const agents = await ctx.db
    .selectFrom("agents as a")
    .innerJoin("agent_categories as c", "c.id", "a.category_id")
    .select(["a.id", "a.name", "a.short_description", "a.full_description", "a.status", "c.code", "c.label"])
    .where("c.code", "in", categories)
    .execute();

  let matching = agents;
  if (searching) {
    const prompts = agents.length
      ? await ctx.db
          .selectFrom("agent_sample_prompts")
          .select(["agent_id", "content"])
          .where("agent_id", "in", agents.map((a) => a.id))
          .where("kind", "=", "example")
          .execute()
      : [];
    matching = agents.filter((a) => {
      const haystack = normalizeText(
        [a.name, a.short_description, a.full_description, ...prompts.filter((p) => p.agent_id === a.id).map((p) => p.content)].join(" "),
      );
      return haystack.includes(query);
    });
  }

  const added = new Set(
    (
      await ctx.db
        .selectFrom("profile_agents")
        .select("agent_id")
        .where("user_id", "=", session.user.id)
        .where("removed_at", "is", null)
        .execute()
    ).map((r) => r.agent_id),
  );

  return matching
    .map<CatalogItem>((a) => ({
      id: a.id,
      name: a.name,
      shortDescription: a.short_description,
      category: a.code as CategoryCode,
      categoryLabel: a.label,
      maintenance: a.status === "blocked",
      added: added.has(a.id),
    }))
    .sort((x, y) => x.name.localeCompare(y.name, "fr", { sensitivity: "base" }));
}

export interface AgentSheet {
  id: string;
  name: string;
  category: CategoryCode;
  categoryLabel: string;
  shortDescription: string;
  description: string;
  examples: string[];
  /** Éléments à configurer, simplement annoncés : la fiche ne les demande pas (US-24 RF2). */
  requirements: { connector: string; label: string; scope: "each_profile" | "primary_user" | "account" }[];
  needsGeneralInfo: boolean;
  validatedActions: string[];
  maintenance: boolean;
  added: boolean;
  /** Nombre d'agents du profil dans cette rubrique et limite en vigueur (US-27). */
  inCategory: number;
  max: number;
}

export async function getAgentSheet(ctx: Ctx, session: SessionContext, agentId: string): Promise<AgentSheet> {
  requireProfileWithDashboard(session);
  const agent = await ctx.db
    .selectFrom("agents as a")
    .innerJoin("agent_categories as c", "c.id", "a.category_id")
    .select(["a.id", "a.name", "a.short_description", "a.full_description", "a.status", "c.code", "c.label", "c.id as category_id"])
    .where("a.id", "=", agentId)
    .where("c.code", "in", visibleCategories(session))
    .executeTakeFirst();
  if (!agent) throw new Rejection("not_found", "Cet agent n'existe pas ou n'est plus disponible.", 404);

  const [prompts, requirements, infoFields, actions, mine, max] = await Promise.all([
    ctx.db.selectFrom("agent_sample_prompts").select("content").where("agent_id", "=", agentId).where("kind", "=", "example").orderBy("sort_order").execute(),
    ctx.db
      .selectFrom("agent_requirements as r")
      .innerJoin("connector_types as t", "t.id", "r.connector_type_id")
      .select(["t.code", "t.label", "r.owner_scope"])
      .where("r.agent_id", "=", agentId)
      .orderBy("t.id")
      .execute(),
    ctx.db.selectFrom("agent_info_fields").select("id").where("agent_id", "=", agentId).limit(1).execute(),
    ctx.db.selectFrom("agent_validated_actions").select("label").where("agent_id", "=", agentId).orderBy("sort_order").execute(),
    ctx.db
      .selectFrom("profile_agents as pa")
      .innerJoin("agents as a", "a.id", "pa.agent_id")
      .select(["pa.agent_id", "a.category_id"])
      .where("pa.user_id", "=", session.user.id)
      .where("pa.removed_at", "is", null)
      .execute(),
    integerSetting(ctx.db, "max_agents_per_category", 10),
  ]);

  return {
    id: agent.id,
    name: agent.name,
    category: agent.code as CategoryCode,
    categoryLabel: agent.label,
    shortDescription: agent.short_description,
    description: agent.full_description,
    examples: prompts.map((p) => p.content),
    requirements: requirements.map((r) => ({ connector: r.code, label: r.label, scope: r.owner_scope })),
    needsGeneralInfo: infoFields.length > 0,
    validatedActions: actions.map((a) => a.label),
    maintenance: agent.status === "blocked",
    added: mine.some((m) => m.agent_id === agentId),
    inCategory: mine.filter((m) => m.category_id === agent.category_id).length,
    max,
  };
}

export async function getDashboard(ctx: Ctx, session: SessionContext): Promise<Dashboard> {
  requireProfileWithDashboard(session);
  const rows = await ctx.db
    .selectFrom("v_dashboard_agents as d")
    .innerJoin("agents as a", "a.id", "d.agent_id")
    .select(["d.agent_id", "d.name", "d.short_description", "d.category_code", "d.display_status", "a.maintenance_message"])
    .where("d.user_id", "=", session.user.id)
    .where("d.category_code", "in", ["pro", "perso", "contracts"])
    .orderBy("d.added_at")
    .orderBy("d.agent_id")
    .execute();

  const tabs: Dashboard["tabs"] = { pro: [], perso: [], contracts: [] };
  for (const row of rows) {
    tabs[row.category_code as "pro" | "perso" | "contracts"].push({
      id: row.agent_id!,
      name: row.name!,
      shortDescription: row.short_description!,
      status: row.display_status as DisplayStatus,
      maintenanceMessage: row.maintenance_message,
    });
  }
  return { max: await integerSetting(ctx.db, "max_agents_per_category", 10), tabs };
}

export interface AddResult {
  category: CategoryCode;
  categoryLabel: string;
  agentName: string;
  status: DisplayStatus;
  /** L'agent demande des informations obligatoires non encore fournies : le formulaire s'ouvre (US-10 RF12). */
  needsInfo: boolean;
  alreadyAdded: boolean;
}

/**
 * Ajoute un agent au dashboard du profil (US-26). Un même agent ne figure qu'une fois, même en cas
 * de double envoi (RT1) ; la limite par rubrique est vérifiée par la base, sous verrou (RT2, US-27).
 * Un agent déjà ajouté puis retiré retrouve sa configuration et son carnet (RF4).
 */
export async function addAgent(ctx: Ctx, session: SessionContext, agentId: string): Promise<AddResult> {
  requireProfileWithDashboard(session);
  const sheet = await getAgentSheet(ctx, session, agentId); // refuse un agent hors catalogue visible

  const alreadyAdded = await ctx.db.transaction().execute(async (trx) => {
    const existing = await trx
      .selectFrom("profile_agents")
      .select(["id", "removed_at"])
      .where("user_id", "=", session.user.id)
      .where("agent_id", "=", agentId)
      .forUpdate()
      .executeTakeFirst();
    if (existing && existing.removed_at === null) return true;
    try {
      if (existing) {
        await trx.updateTable("profile_agents").set({ removed_at: null, updated_at: ctx.now }).where("id", "=", existing.id).execute();
      } else {
        await trx.insertInto("profile_agents").values({ user_id: session.user.id, agent_id: agentId, added_at: ctx.now }).execute();
      }
    } catch (error) {
      const message = (error as Error).message;
      if (/Limite de \d+ agents/.test(message)) {
        const max = await integerSetting(ctx.db, "max_agents_per_category", 10);
        throw new Rejection(
          "limit_reached",
          `Vous avez atteint le maximum de ${max} agents dans la rubrique ${sheet.categoryLabel}. Retirez un agent de cette rubrique pour en ajouter un nouveau.`,
          409,
          { category: sheet.category, categoryLabel: sheet.categoryLabel, max },
        );
      }
      if (/réservée au noyau/.test(message)) throw new Rejection("not_found", "Cet agent n'existe pas ou n'est plus disponible.", 404);
      throw error;
    }
    return false;
  });

  const status = await ctx.db
    .selectFrom("v_dashboard_agents")
    .select("display_status")
    .where("user_id", "=", session.user.id)
    .where("agent_id", "=", agentId)
    .executeTakeFirstOrThrow();
  const missingInfo = await ctx.db
    .selectFrom("v_profile_agent_missing_items")
    .select("item_code")
    .where("user_id", "=", session.user.id)
    .where("agent_id", "=", agentId)
    .where("item_kind", "=", "info")
    .limit(1)
    .execute();

  return {
    category: sheet.category,
    categoryLabel: sheet.categoryLabel,
    agentName: sheet.name,
    status: status.display_status as DisplayStatus,
    needsInfo: missingInfo.length > 0,
    alreadyAdded,
  };
}

/**
 * Retire un agent du dashboard (US-28) : il est seulement masqué, rien n'est supprimé (RT1). Les autres
 * profils ne sont pas touchés (RF5). L'historique du tchat de cet agent est effacé (RF6).
 */
export async function removeAgent(ctx: Ctx, session: SessionContext, agentId: string): Promise<void> {
  requireProfileWithDashboard(session);
  const request = await ctx.db.transaction().execute(async (trx) => {
    const removed = await trx
      .updateTable("profile_agents")
      .set({ removed_at: ctx.now, updated_at: ctx.now })
      .where("user_id", "=", session.user.id)
      .where("agent_id", "=", agentId)
      .where("removed_at", "is", null)
      .returning("id")
      .executeTakeFirst();
    // Déjà retiré (double envoi) : rien à refaire.
    if (!removed) return null;
    return trx
      .insertInto("chat_erasure_requests")
      .values({ user_id: session.user.id, agent_id: agentId, reason: "agent_removed", requested_at: ctx.now })
      .returning("id")
      .executeTakeFirstOrThrow();
  });
  if (request) await processChatErasure(ctx, request.id);
}
