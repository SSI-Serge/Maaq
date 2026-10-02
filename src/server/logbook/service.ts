import { sql, type Kysely } from "kysely";
import { digitorn, type LogbookItem } from "@/server/adapters/digitorn";
import { messenger } from "@/server/adapters/messaging";
import type { Ctx, SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { integerSetting } from "@/server/settings";

/** Carnet de bord des agents (US-40, US-50) : synchronisation avec Digitorn et consultation. */

export const PAGE_SIZE = 20;
/** Un lancement « en cours » plus ancien est considéré comme interrompu. */
const STALE_RUN_MINUTES = 10;
/**
 * Chaque synchronisation relit aussi les dernières 24 h déjà vues : une entrée livrée en retard par Digitorn
 * n'est pas perdue, et l'unicité des entrées (RT3) évite tout doublon. Hypothèse à confirmer avec leur API.
 */
const OVERLAP_MS = 24 * 3_600_000;

export type EntryType = "request" | "action_done" | "action_validated" | "action_refused";

export interface LogbookEntryView {
  id: string;
  occurredAt: string;
  /** Prénom de la personne concernée ; null pour un invité supprimé (US-40 RF8). */
  authorFirstName: string | null;
  type: EntryType;
  summary: string;
  result: string | null;
}

export interface LogbookAgent {
  id: string;
  name: string;
}

export interface LogbookPage {
  entries: LogbookEntryView[];
  hasMore: boolean;
  /** Dernière synchronisation réussie, qu'on précise en haut du carnet (RF5, RT4). */
  lastSyncAt: string | null;
}

// ---------------------------------------------------------------------------
// Consultation (US-40, US-50)
// ---------------------------------------------------------------------------

function requireProfile(session: SessionContext): string {
  if (session.user.role === "admin" || !session.user.accountId) throw new Rejection("forbidden", "L'administrateur n'a pas de carnet de bord.", 403);
  return session.user.accountId;
}

/**
 * Entrées visibles par le profil (règle D3) : le noyau voit tout le compte ; un invité secondaire voit ses
 * propres entrées et les demandes du noyau auxquelles il participe. Les entrées plus anciennes que la durée
 * de rétention n'apparaissent plus, même avant le passage du nettoyage quotidien (RF6).
 */
async function visibleEntries(ctx: Ctx, session: SessionContext) {
  const accountId = requireProfile(session);
  const months = await integerSetting(ctx.db, "logbook_retention_months", 14);
  const cutoff = sql<Date>`${ctx.now.toISOString()}::timestamptz - make_interval(months => ${months})`;
  let query = ctx.db
    .selectFrom("logbook_entries as e")
    .where("e.account_id", "=", accountId)
    .where("e.occurred_at", ">=", cutoff)
    .where("e.anonymization_status", "<>", "pending");
  const secondary = session.user.role === "guest" && session.user.guestRank === "secondary";
  if (secondary) {
    query = query.where((eb) =>
      eb.or([
        eb("e.requester_user_id", "=", session.user.id),
        eb.exists(
          eb
            .selectFrom("logbook_entry_participants as p")
            .select("p.entry_id")
            .whereRef("p.entry_id", "=", "e.id")
            .whereRef("p.entry_occurred_at", "=", "e.occurred_at")
            .where("p.user_id", "=", session.user.id),
        ),
      ]),
    );
  }
  return query;
}

/** Agents pour lesquels le profil a au moins une entrée visible, retirés du dashboard ou non, par ordre alphabétique (US-40 RF1, US-50 RF2). */
export async function listLogbookAgents(ctx: Ctx, session: SessionContext): Promise<LogbookAgent[]> {
  const base = await visibleEntries(ctx, session);
  const rows = await base
    .innerJoin("agents as a", "a.id", "e.agent_id")
    .select(["a.id", "a.name"])
    .distinct()
    .execute();
  return rows.sort((x, y) => x.name.localeCompare(y.name, "fr", { sensitivity: "base" })).map((a) => ({ id: a.id, name: a.name }));
}

export async function lastSuccessfulSync(db: Kysely<DB>): Promise<Date | null> {
  const row = await db.selectFrom("logbook_sync_runs").select("finished_at").where("status", "=", "succeeded").orderBy("finished_at", "desc").limit(1).executeTakeFirst();
  return row?.finished_at ? new Date(row.finished_at) : null;
}

/** Entrées d'un agent, de la plus récente à la plus ancienne, par pages de 20 (US-40 RF2, RF9). */
export async function getLogbook(ctx: Ctx, session: SessionContext, agentId: string, offset = 0): Promise<LogbookPage> {
  const base = await visibleEntries(ctx, session);
  const rows = await base
    .leftJoin("users as u", "u.id", "e.requester_user_id")
    .select(["e.id", "e.occurred_at", "e.entry_type", "e.summary", "e.result", "u.first_name"])
    .where("e.agent_id", "=", agentId)
    .orderBy("e.occurred_at", "desc")
    .orderBy("e.id", "desc")
    .limit(PAGE_SIZE + 1)
    .offset(Math.max(0, offset))
    .execute();
  const lastSync = await lastSuccessfulSync(ctx.db);
  return {
    entries: rows.slice(0, PAGE_SIZE).map((r) => ({
      id: r.id,
      occurredAt: new Date(r.occurred_at).toISOString(),
      authorFirstName: r.first_name,
      type: r.entry_type,
      summary: r.summary,
      result: r.result,
    })),
    hasMore: rows.length > PAGE_SIZE,
    lastSyncAt: lastSync?.toISOString() ?? null,
  };
}

// ---------------------------------------------------------------------------
// Synchronisation avec Digitorn (US-40 RT1 à RT4)
// ---------------------------------------------------------------------------

export interface SyncResult {
  status: "succeeded" | "failed" | "busy";
  imported: number;
  skipped: number;
  error?: string;
}

/**
 * Récupère auprès de Digitorn les entrées apparues depuis la dernière synchronisation réussie. Une entrée
 * déjà connue n'est jamais dupliquée (RT3). Un échec est enregistré, signalé à l'administrateur par email, et
 * réessayé à la synchronisation suivante (RT4). Le demandeur et les participants sont conservés pour la règle D3 (RT5).
 */
export async function syncLogbook(ctx: Ctx): Promise<SyncResult> {
  // Un lancement interrompu ne bloque pas les suivants.
  await ctx.db
    .updateTable("logbook_sync_runs")
    .set({ status: "failed", finished_at: ctx.now, error_message: "Lancement interrompu" })
    .where("status", "=", "running")
    .where("started_at", "<", new Date(ctx.now.getTime() - STALE_RUN_MINUTES * 60_000))
    .execute();
  if (await ctx.db.selectFrom("logbook_sync_runs").select("id").where("status", "=", "running").executeTakeFirst()) {
    return { status: "busy", imported: 0, skipped: 0 };
  }

  const since = (
    await ctx.db.selectFrom("logbook_sync_runs").select("started_at").where("status", "=", "succeeded").orderBy("started_at", "desc").limit(1).executeTakeFirst()
  )?.started_at;
  const run = await ctx.db.insertInto("logbook_sync_runs").values({ started_at: ctx.now, status: "running" }).returning("id").executeTakeFirstOrThrow();

  try {
    await sql`select ensure_logbook_partitions(3)`.execute(ctx.db);
    const items = await digitorn().fetchLogbook(since ? new Date(new Date(since).getTime() - OVERLAP_MS) : new Date(0));
    const { imported, skipped } = await importItems(ctx, items);
    await ctx.db.updateTable("logbook_sync_runs").set({ status: "succeeded", finished_at: new Date(), entries_imported: imported }).where("id", "=", run.id).execute();
    return { status: "succeeded", imported, skipped };
  } catch (error) {
    const message = (error as Error).message.slice(0, 500);
    await ctx.db.updateTable("logbook_sync_runs").set({ status: "failed", finished_at: new Date(), error_message: message }).where("id", "=", run.id).execute();
    await alertAdmin(ctx.db, "La synchronisation du carnet de bord a échoué", `La synchronisation du carnet avec Digitorn a échoué : ${message}\nElle sera retentée à la prochaine échéance.`);
    return { status: "failed", imported: 0, skipped: 0, error: message };
  }
}

async function importItems(ctx: Ctx, items: LogbookItem[]): Promise<{ imported: number; skipped: number }> {
  let imported = 0;
  let skipped = 0;
  const users = new Map<string, { id: string; account_id: string | null } | null>();
  const agents = new Map<string, string | null>();

  for (const item of items) {
    if (!users.has(item.userRef)) {
      users.set(item.userRef, (await ctx.db.selectFrom("users").select(["id", "account_id"]).where("digitorn_user_ref", "=", item.userRef).executeTakeFirst()) ?? null);
    }
    if (!agents.has(item.agentRef)) {
      agents.set(item.agentRef, (await ctx.db.selectFrom("agents").select("id").where("digitorn_agent_ref", "=", item.agentRef).executeTakeFirst())?.id ?? null);
    }
    const user = users.get(item.userRef);
    const agentId = agents.get(item.agentRef);
    // Profil supprimé ou agent inconnu : rien à rattacher, l'entrée est ignorée.
    if (!user?.account_id || !agentId) {
      skipped++;
      continue;
    }

    const inserted = await ctx.db
      .insertInto("logbook_entries")
      .values({
        account_id: user.account_id,
        agent_id: agentId,
        external_ref: item.externalId,
        occurred_at: item.occurredAt,
        requester_user_id: user.id,
        entry_type: item.type,
        summary: item.text,
        result: item.result ?? null,
        synced_at: new Date(),
      })
      .onConflict((oc) => oc.columns(["account_id", "agent_id", "external_ref", "occurred_at"]).doNothing())
      .returning(["id", "occurred_at"])
      .executeTakeFirst();
    if (!inserted) continue; // déjà connue (RT3)
    imported++;

    const emails = [...new Set(item.participants.map((p) => p.trim().toLowerCase()).filter(Boolean))];
    if (emails.length) {
      const people = await ctx.db
        .selectFrom("users")
        .select("id")
        .where("account_id", "=", user.account_id)
        .where(sql<string>`lower(email::text)`, "in", emails)
        .execute();
      for (const person of people) {
        await ctx.db
          .insertInto("logbook_entry_participants")
          .values({ entry_id: inserted.id, entry_occurred_at: inserted.occurred_at, user_id: person.id })
          .onConflict((oc) => oc.doNothing())
          .execute();
      }
    }
  }
  return { imported, skipped };
}

/** Alerte envoyée à l'administrateur par email, si l'adresse d'alerte est renseignée (US-65). */
export async function alertAdmin(db: Kysely<DB>, subject: string, text: string): Promise<void> {
  const setting = await db.selectFrom("platform_settings").select("value_text").where("setting_key", "=", "alert_email").executeTakeFirst();
  if (!setting?.value_text) {
    console.error(`[alerte] ${subject} — aucune adresse d'alerte renseignée`);
    return;
  }
  try {
    await messenger().sendEmail({ to: setting.value_text, subject: `MAAQ — ${subject}`, text });
  } catch (error) {
    console.error("Alerte non envoyée :", error);
  }
}
