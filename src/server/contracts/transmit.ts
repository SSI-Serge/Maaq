import { createHmac } from "node:crypto";
import { sql } from "kysely";
import { devOutbox, messenger } from "@/server/adapters/messaging";
import { open } from "@/server/assistant/fields";
import { familyTimeZone } from "@/server/assistant/reminders";
import { localDay } from "@/server/assistant/local-time";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { env } from "@/server/env";
import { Rejection } from "@/server/http";
import { describeError } from "@/server/safe-log";
import { loadDocument } from "./storage";
import { challengeSimulated, unbundlePhotos, type ContractView } from "./service";
import { getContracts } from "./service";

/**
 * Transmission des documents d'un contrat (US-129, US-130, US-135) : pour analyse, pour challenge, ou les deux, selon les interrupteurs actifs AU MOMENT de l'envoi. La base
 * garantit le reste (champs obligatoires remplis, documents jamais transmis, catégorie non archivée, document obligatoire illisible, consentement, courtier désigné) ; ici,
 * le plafond quotidien, l'enregistrement, et le challenge par email avec les documents en pièces jointes (C-03).
 */

const HOUR = 3_600_000;
/** Un envoi au challenge qui échoue est réessayé pendant 1 heure, puis passe à « échoué » avec « Renvoyer » (US-135 RF3). */
export const CHALLENGE_RETRY_WINDOW_MS = HOUR;

function requireCore(session: SessionContext): string {
  const isCore = session.user.role === "primary_user" || (session.user.role === "guest" && session.user.guestRank === "core");
  if (!isCore || !session.user.accountId) throw new Rejection("forbidden", "Les contrats sont réservés à l'utilisateur principal et à l'invité 1.", 403);
  return session.user.accountId;
}

/** Messages des refus de la base, tels que la famille doit les lire. */
function refusal(error: unknown): unknown {
  const e = error as { code?: string; message?: string };
  if (e.code === "23514" && e.message) {
    const text = e.message.replace(/ \(.*$/, "");
    return new Rejection("rule_refused", /[.!?]$/.test(text) ? text : `${text}.`, 409);
  }
  return error;
}

/** Identifiant de la famille pour le courtier : stable, sans rapport avec les identifiants de MAAQ (empreinte de l'identifiant du compte). */
export function familyReference(accountId: string): string {
  return `F-${createHmac("sha256", Buffer.from(env().HMAC_KEY, "base64")).update(`contract-family:${accountId}`).digest("hex").slice(0, 10).toUpperCase()}`;
}

/**
 * Transmet les documents du contrat. Les canaux sont ceux dont l'interrupteur est actif : l'analyse seulement si elle est ouverte (`CONTRACT_ANALYSIS_MODE`), le challenge
 * seulement si le courtier est désigné. Une analyse compte comme une demande du plafond quotidien du profil qui transmet ; au-delà, le challenge seul reste possible.
 */
export async function transmitContract(ctx: Ctx, session: SessionContext, contractId: string, options: { challengeOnlyIfCapReached?: boolean } = {}): Promise<ContractView> {
  const accountId = requireCore(session);
  // Les mêmes règles que l'écran : ce qu'il ne permet pas, le serveur le refuse (la base garde le dernier mot).
  const view = await getContracts(ctx, session);
  const found = view.categories.flatMap((c) => c.contracts).find((c) => c.id === contractId);
  if (!found) throw new Rejection("not_found", "Ce contrat n'existe pas ou n'existe plus.", 404);
  const plan = found.transmit;
  if (plan.alreadyTransmitted) throw new Rejection("already_transmitted", "Les documents de ce contrat ont déjà été transmis.", 409);
  if (found.missingRequired > 0) throw new Rejection("missing_required", "Un document obligatoire manque.", 409);
  if (!plan.forAnalysis && !plan.forChallenge) {
    throw plan.analysisBlockers.length ? new Rejection("analysis_blocked", plan.analysisBlockers[0], 409) : new Rejection("no_channel", "Activez l'analyse ou le challenge pour transmettre.", 409);
  }
  let forAnalysis = plan.forAnalysis;
  const forChallenge = plan.forChallenge;

  let counted = false;
  if (forAnalysis) {
    const day = localDay(ctx.now, await familyTimeZone(ctx.db, accountId));
    const accepted = await sql<{ accepted: boolean }>`select register_agent_request(${session.user.id}::uuid, ${day}::date) as accepted`.execute(ctx.db);
    if (accepted.rows[0]?.accepted) counted = true;
    else if (forChallenge && options.challengeOnlyIfCapReached) forAnalysis = false;
    else {
      const account = await ctx.db.selectFrom("accounts").select("daily_request_limit").where("id", "=", accountId).executeTakeFirstOrThrow();
      throw new Rejection("daily_cap_reached", `Vous avez atteint la limite de ${account.daily_request_limit} demandes pour aujourd'hui : elle revient demain. Le challenge seul reste possible.`, 429, { limit: account.daily_request_limit });
    }
  }
  try {
    const row = await ctx.db.transaction().execute(async (trx) => {
      const inserted = await trx
        .insertInto("contract_transmissions")
        .values({ account_contract_id: contractId, transmitted_by_user_id: session.user.id, transmitted_at: ctx.now, for_analysis: forAnalysis, for_challenge: forChallenge })
        .returning("id")
        .executeTakeFirstOrThrow();
      if (forAnalysis && plan.needsAdmin) {
        // Lecture incertaine : l'analyse attend la décision d'un administrateur, qui ne voit que le texte masqué ; la demande expire avec les documents, 48 h après (US-138 RF1, RF6).
        await trx.updateTable("contract_transmissions").set({ analysis_status: "awaiting_admin" }).where("id", "=", inserted.id).execute();
        await trx.insertInto("contract_analysis_reviews").values({ transmission_id: inserted.id, expires_at: new Date(ctx.now.getTime() + 48 * HOUR) }).execute();
      }
      return inserted;
    });
    if (forChallenge) await deliverChallenge(ctx, row.id).catch((error) => console.error(`Envoi au challenge : ${describeError(error)}`));
  } catch (error) {
    // Rien n'est parti : la demande comptée au plafond est rendue.
    if (counted) await releaseRequest(ctx, session.user.id, accountId);
    throw refusal(error);
  }
  const after = await getContracts(ctx, session);
  return after.categories.flatMap((c) => c.contracts).find((c) => c.id === contractId)!;
}

async function releaseRequest(ctx: Ctx, userId: string, accountId: string) {
  const day = localDay(ctx.now, await familyTimeZone(ctx.db, accountId));
  await ctx.db.updateTable("daily_request_counters").set({ request_count: sql`greatest(request_count - 1, 0)` }).where("user_id", "=", userId).where("request_date", "=", sql<Date>`${day}::date`).execute();
}

/**
 * Envoie l'email du challenge pour une transmission : la boîte du courtier reçoit les documents d'origine en pièces jointes, le nom de la catégorie et un identifiant de la
 * famille, SANS le nom du contrat (US-129 RF5). Succès : « envoyé ». Échec : réessayé aux passages suivants pendant 1 heure, puis « échoué » (US-135 RF3).
 */
export async function deliverChallenge(ctx: Ctx, transmissionId: string): Promise<"sent" | "retry" | "failed" | "skipped"> {
  const row = await ctx.db
    .selectFrom("contract_transmissions as t")
    .innerJoin("account_contracts as c", "c.id", "t.account_contract_id")
    .innerJoin("contract_definitions as d", "d.id", "c.contract_definition_id")
    .select(["t.id", "t.account_contract_id", "t.transmitted_at", "t.challenge_status", "c.account_id", "d.name as category"])
    .where("t.id", "=", transmissionId)
    .where("t.for_challenge", "=", true)
    .executeTakeFirst();
  if (!row || row.challenge_status !== "sending") return "skipped";
  const broker = await ctx.db.selectFrom("platform_settings").select(["setting_key", "value_text"]).where("setting_key", "in", ["contract_broker_email", "contract_broker_name"]).execute();
  const to = broker.find((b) => b.setting_key === "contract_broker_email")?.value_text?.trim();
  try {
    if (!to) throw new Error("Adresse de la boîte du courtier non renseignée");
    const docs = await ctx.db
      .selectFrom("contract_field_documents as d")
      .innerJoin("contract_document_fields as f", "f.id", "d.field_id")
      .select(["d.id", "d.file_name", "d.source_kind", "d.storage_key", "f.name as field"])
      .where("d.account_contract_id", "=", row.account_contract_id)
      .orderBy("f.sort_order")
      .orderBy("d.id")
      .execute();
    if (docs.length === 0) throw new Error("Documents déjà supprimés");
    const attachments: { filename: string; content: Buffer; contentType: string }[] = [];
    for (const doc of docs) {
      const bytes = await loadDocument(doc.storage_key);
      const base = open(doc.file_name).replace(/[\\/:*?"<>|]/g, "_");
      if (doc.source_kind === "pdf") attachments.push({ filename: base, content: bytes, contentType: "application/pdf" });
      else
        for (const [i, page] of unbundlePhotos(bytes).entries()) {
          attachments.push({ filename: `${doc.field.replace(/[\\/:*?"<>|]/g, "_")}-${i + 1}.${page.mime === "image/gif" ? "gif" : "jpg"}`, content: page.content, contentType: page.mime });
        }
    }
    const reference = familyReference(row.account_id);
    // Zone de test : jamais d'envoi réel, la boîte de test interne tient lieu de boîte du courtier.
    const simulated = challengeSimulated();
    await (simulated ? devOutbox() : messenger()).sendEmail({
      to,
      subject: `${simulated ? "[Simulation] " : ""}Challenge d'un contrat — ${row.category} — ${reference}`,
      text: `Bonjour,\n\nUne famille de MAAQ demande le challenge d'un contrat.\n\nCatégorie : ${row.category}\nIdentifiant de la famille : ${reference}\nDocuments en pièces jointes : ${attachments.length}\n\nMAAQ ne conserve pas ces documents au-delà de 48 h après leur transmission.`,
      attachments,
    });
    await ctx.db.updateTable("contract_transmissions").set({ challenge_status: "sent", challenge_last_error: null, updated_at: ctx.now }).where("id", "=", transmissionId).execute();
    return "sent";
  } catch (error) {
    // La fenêtre d'une heure repart à chaque « Renvoyer ».
    const relaunch = await ctx.db.selectFrom("contract_transmission_relaunches").select(sql<Date | null>`max(relaunched_at)`.as("at")).where("transmission_id", "=", transmissionId).where("channel", "=", "challenge").executeTakeFirst();
    const started = Math.max(new Date(row.transmitted_at).getTime(), relaunch?.at ? new Date(relaunch.at).getTime() : 0);
    const expired = ctx.now.getTime() - started >= CHALLENGE_RETRY_WINDOW_MS;
    await ctx.db
      .updateTable("contract_transmissions")
      .set((eb) => ({ challenge_status: expired ? "failed" : "sending", challenge_attempts: eb("challenge_attempts", "+", 1), challenge_last_error: describeError(error).slice(0, 300), updated_at: ctx.now }))
      .where("id", "=", transmissionId)
      .execute();
    return expired ? "failed" : "retry";
  }
}

/** Passage périodique : les envois au challenge « en cours » sont repris (reprise automatique pendant 1 heure). */
export async function runChallengeDeliveries(ctx: Ctx): Promise<{ sent: number; failed: number }> {
  const pending = await ctx.db.selectFrom("contract_transmissions").select("id").where("for_challenge", "=", true).where("challenge_status", "=", "sending").orderBy("id").limit(100).execute();
  const result = { sent: 0, failed: 0 };
  for (const { id } of pending) {
    const outcome = await deliverChallenge(ctx, id);
    if (outcome === "sent") result.sent += 1;
    if (outcome === "failed") result.failed += 1;
  }
  return result;
}

/**
 * « Renvoyer » (challenge) ou « Relancer l'analyse » (US-135) : tant que les documents existent ; une relance ne prolonge pas le délai de 48 h (la base le garantit). Une
 * relance d'analyse compte comme une demande du plafond quotidien.
 */
export async function relaunchChannel(ctx: Ctx, session: SessionContext, contractId: string, channel: "analysis" | "challenge"): Promise<ContractView> {
  const accountId = requireCore(session);
  const transmission = await ctx.db
    .selectFrom("contract_transmissions as t")
    .innerJoin("account_contracts as c", "c.id", "t.account_contract_id")
    .select(["t.id"])
    .where("c.id", "=", contractId)
    .where("c.account_id", "=", accountId)
    .orderBy("t.transmitted_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!transmission) throw new Rejection("not_found", "Ce contrat n'a pas été transmis.", 404);
  let counted = false;
  if (channel === "analysis") {
    const day = localDay(ctx.now, await familyTimeZone(ctx.db, accountId));
    const accepted = await sql<{ accepted: boolean }>`select register_agent_request(${session.user.id}::uuid, ${day}::date) as accepted`.execute(ctx.db);
    if (!accepted.rows[0]?.accepted) {
      const account = await ctx.db.selectFrom("accounts").select("daily_request_limit").where("id", "=", accountId).executeTakeFirstOrThrow();
      throw new Rejection("daily_cap_reached", `Vous avez atteint la limite de ${account.daily_request_limit} demandes pour aujourd'hui : elle revient demain.`, 429, { limit: account.daily_request_limit });
    }
    counted = true;
  }
  try {
    await ctx.db.insertInto("contract_transmission_relaunches").values({ transmission_id: transmission.id, channel, relaunched_by_user_id: session.user.id, relaunched_at: ctx.now }).execute();
    if (channel === "challenge") await deliverChallenge(ctx, transmission.id).catch((error) => console.error(`Renvoi au challenge : ${describeError(error)}`));
  } catch (error) {
    if (counted) await releaseRequest(ctx, session.user.id, accountId);
    throw refusal(error);
  }
  const view = await getContracts(ctx, session);
  return view.categories.flatMap((c) => c.contracts).find((c) => c.id === contractId)!;
}
