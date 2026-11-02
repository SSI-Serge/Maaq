import { sql } from "kysely";
import { messenger } from "@/server/adapters/messaging";
import { seal } from "@/server/assistant/fields";
import { familyTimeZone } from "@/server/assistant/reminders";
import type { Ctx } from "@/server/auth/service";
import { env } from "@/server/env";
import { pushConfigured, sendPush } from "@/server/push/service";
import { describeError } from "@/server/safe-log";
import { analysisMode, analysisRunner, processAnalysisOutput } from "./analysis";
import { openBlob, type MaskedBlob } from "./masked";
import { householdFacts } from "./process";

/**
 * Analyse d'un contrat (US-131, US-132, US-135) : l'agent reçoit le texte masqué des documents d'UN contrat et le nom de sa catégorie, rend un rapport ; le rapport est
 * contrôlé, nettoyé, stocké chiffré avec ses références, et il REMPLACE le précédent. Sans effet quand l'analyse est fermée (`CONTRACT_ANALYSIS_MODE=off`).
 *
 * En mode « preview », le moteur est le rapport de démonstration (aucun appel) ; en mode « live », l'agent de l'API Anthropic. Dans les deux cas, ce module ne voit que du texte masqué.
 */

/** Une analyse qui dépasse 10 minutes est en échec (US-135 RF6). */
export const ANALYSIS_TIMEOUT_MS = 10 * 60_000;

const TOKEN = /\[[A-Z]+_\d+\]/g;
const frDateTime = (at: Date, timeZone: string) => `${at.toLocaleDateString("fr-FR", { timeZone })} à ${at.toLocaleTimeString("fr-FR", { timeZone, hour: "2-digit", minute: "2-digit" })}`;

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error("L'analyse a dépassé le délai")), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

export type AnalysisOutcome = "completed" | "failed" | "skipped";

/**
 * Lance l'analyse d'une transmission « en cours ». Une transaction garde un verrou sur cette transmission le temps de l'analyse : deux appels simultanés (écran, passage de
 * fond, autre instance) ne la font pas deux fois. Un échec est inscrit dans l'état de la transmission ; l'ancien rapport reste affiché (US-135 RF1).
 */
export async function runAnalysis(ctx: Ctx, transmissionId: string): Promise<AnalysisOutcome> {
  if (analysisMode() === "off") return "skipped";
  return ctx.db.transaction().execute(async (trx) => {
    const lock = await sql<{ ok: boolean }>`select pg_try_advisory_xact_lock(hashtextextended(${`contract-analysis:${transmissionId}`}, 0)) as ok`.execute(trx);
    if (!lock.rows[0]?.ok) return "skipped";
    const t = await trx
      .selectFrom("contract_transmissions as t")
      .innerJoin("account_contracts as c", "c.id", "t.account_contract_id")
      .innerJoin("contract_definitions as d", "d.id", "c.contract_definition_id")
      .select(["t.id", "t.account_contract_id", "t.transmitted_at", "c.account_id", "d.name as category"])
      .where("t.id", "=", transmissionId)
      .where("t.for_analysis", "=", true)
      .where("t.analysis_status", "=", "running")
      .executeTakeFirst();
    if (!t) return "skipped";

    const fail = async (reason: string): Promise<AnalysisOutcome> => {
      await trx.updateTable("contract_transmissions").set({ analysis_status: "failed", analysis_last_error: reason.slice(0, 300), updated_at: ctx.now }).where("id", "=", transmissionId).execute();
      return "failed";
    };

    const docs = await trx
      .selectFrom("contract_field_documents as d")
      .innerJoin("contract_document_fields as f", "f.id", "d.field_id")
      .select(["d.id", "d.masking_status", "d.masked_text", "f.name", "f.is_required"])
      .where("d.account_contract_id", "=", t.account_contract_id)
      .orderBy("f.sort_order")
      .orderBy("d.id")
      .execute();
    if (docs.length === 0) return fail("Documents déjà supprimés");
    if (docs.some((d) => d.masking_status === "unreadable" && d.is_required)) return fail("Un document obligatoire est illisible");
    const usable = docs.filter((d) => d.masked_text && (d.masking_status === "verified" || d.masking_status === "uncertain"));
    if (usable.length === 0) return fail("Aucun document masqué et vérifié");
    const skippedFields = docs.filter((d) => d.masking_status === "unreadable" && !d.is_required).map((d) => d.name);

    const blobs = usable.map((d) => ({ field: d.name, blob: openBlob(d.masked_text!) }));
    const references: MaskedBlob["references"] = {};
    for (const { blob } of blobs) Object.assign(references, blob.references);
    const documents = blobs.map(({ field, blob }) => ({ fieldName: field, text: blob.pages.filter((p) => p.state !== "removed").map((p) => p.text).join("\n\n") }));

    let raw: string;
    try {
      raw = await withTimeout(analysisRunner().run({ category: t.category, documents }), ANALYSIS_TIMEOUT_MS);
    } catch (error) {
      return fail(describeError(error));
    }
    const outcome = processAnalysisOutput(raw, { references, household: await householdFacts(trx, t.account_id), now: ctx.now, skippedFields });
    if (!outcome.ok) return fail(outcome.reason === "personal_data" ? `Rapport refusé : ${outcome.issues.join(", ")}` : "Rapport vide");

    const generatedAt = new Date(Math.max(ctx.now.getTime(), new Date(t.transmitted_at).getTime()));
    // Un seul rapport par contrat : le nouveau remplace l'ancien (US-132 RF3) ; ses références suivent.
    await trx.deleteFrom("contract_reports").where("account_contract_id", "=", t.account_contract_id).execute();
    await trx.insertInto("contract_reports").values({ account_contract_id: t.account_contract_id, account_id: t.account_id, html: seal(outcome.html), generated_at: generatedAt }).execute();
    const used = new Set(raw.match(TOKEN) ?? []);
    const refs = [...used].flatMap((token) => (references[token] ? [{ account_contract_id: t.account_contract_id, account_id: t.account_id, token, member_id: references[token].id }] : []));
    if (refs.length) await trx.insertInto("contract_report_refs").values(refs).execute();
    await trx.updateTable("contract_transmissions").set({ analysis_status: "completed", analysis_last_error: null, updated_at: ctx.now }).where("id", "=", transmissionId).execute();
    return "completed";
  });
}

/** Les analyses « en cours » d'un contrat (appelé par l'écran, qui les redemande tant qu'elles tournent). */
export async function runAnalysesOf(ctx: Ctx, contractId: string): Promise<AnalysisOutcome[]> {
  if (analysisMode() === "off") return [];
  const rows = await ctx.db.selectFrom("contract_transmissions").select("id").where("account_contract_id", "=", contractId).where("for_analysis", "=", true).where("analysis_status", "=", "running").execute();
  const out: AnalysisOutcome[] = [];
  for (const { id } of rows) out.push(await runAnalysis(ctx, id).catch((error) => (console.error(`Analyse : ${describeError(error)}`), "failed" as const)));
  return out;
}

/** Passe en échec les analyses « en cours » depuis plus de 10 minutes (US-135 RF6) : le départ est la transmission, la dernière relance ou la décision de l'administrateur. */
export async function failStaleAnalyses(ctx: Ctx): Promise<number> {
  const limit = new Date(ctx.now.getTime() - ANALYSIS_TIMEOUT_MS);
  const result = await sql`
    update contract_transmissions t
       set analysis_status = 'failed', analysis_last_error = 'L''analyse a dépassé 10 minutes', updated_at = ${ctx.now}
     where t.for_analysis and t.analysis_status = 'running'
       and greatest(
             t.transmitted_at,
             coalesce((select max(r.relaunched_at) from contract_transmission_relaunches r where r.transmission_id = t.id and r.channel = 'analysis'), t.transmitted_at),
             coalesce((select v.decided_at from contract_analysis_reviews v where v.transmission_id = t.id), t.transmitted_at)
           ) < ${limit}`.execute(ctx.db);
  return Number(result.numAffectedRows ?? 0);
}

/** Passage de fond : échecs de délai, puis analyses en cours (rattrape l'écran fermé, un serveur arrêté, une décision d'administrateur). */
export async function runAnalyses(ctx: Ctx): Promise<{ completed: number; failed: number; timedOut: number }> {
  if (analysisMode() === "off") return { completed: 0, failed: 0, timedOut: 0 };
  const timedOut = await failStaleAnalyses(ctx);
  const rows = await ctx.db.selectFrom("contract_transmissions").select("id").where("for_analysis", "=", true).where("analysis_status", "=", "running").orderBy("transmitted_at").limit(20).execute();
  const result = { completed: 0, failed: 0, timedOut };
  for (const { id } of rows) {
    const outcome = await runAnalysis(ctx, id).catch((error) => (console.error(`Analyse : ${describeError(error)}`), "failed" as const));
    if (outcome === "completed") result.completed += 1;
    if (outcome === "failed") result.failed += 1;
  }
  return result;
}

/**
 * Prévient la personne qui a transmis, une seule fois par échec (US-135 RF2) ou quand l'administrateur ne poursuit pas l'analyse (US-138 RF5). Notification sur appareil ;
 * email seulement à défaut d'appareil autorisé (D63). Rien n'est envoyé une fois les documents supprimés : il n'y a plus rien à relancer.
 */
export async function notifyAnalysisOutcomes(ctx: Ctx): Promise<{ notified: number; failed: number }> {
  const rows = await ctx.db
    .selectFrom("contract_transmissions as t")
    .innerJoin("account_contracts as c", "c.id", "t.account_contract_id")
    .leftJoin("users as u", "u.id", "t.transmitted_by_user_id")
    .leftJoin("contract_analysis_reviews as r", "r.transmission_id", "t.id")
    .select(["t.id", "t.analysis_status", "t.transmitted_at", "t.transmitted_by_user_id", "c.id as contract_id", "c.name", "c.account_id", "r.decision", "u.email", "u.first_name"])
    .where("t.for_analysis", "=", true)
    .where("t.analysis_failure_notified_at", "is", null)
    .where((eb) => eb.or([eb("t.analysis_status", "=", "failed"), eb.and([eb("t.analysis_status", "=", "cancelled"), eb("r.decision", "=", "stop")])]))
    .execute();
  const result = { notified: 0, failed: 0 };
  for (const row of rows) {
    const until = new Date(new Date(row.transmitted_at).getTime() + 48 * 3_600_000);
    if (until <= ctx.now || !row.transmitted_by_user_id) {
      await ctx.db.updateTable("contract_transmissions").set({ analysis_failure_notified_at: ctx.now }).where("id", "=", row.id).execute();
      continue;
    }
    const zone = await familyTimeZone(ctx.db, row.account_id);
    const body =
      row.analysis_status === "failed"
        ? `L'analyse de ${row.name} n'a pas abouti. Vous pouvez la relancer jusqu'au ${frDateTime(until, zone)}.`
        : `La lecture des documents de ${row.name} n'était pas assez fiable pour les analyser. Déposez une photo plus nette pour relancer.`;
    try {
      const delivered = pushConfigured() ? (await sendPush(ctx, row.transmitted_by_user_id, { title: "Mes contrats", body, url: `/contrats/${row.contract_id}`, tag: `contract-analysis-${row.id}`, badge: 0 })).delivered : 0;
      if (delivered === 0 && row.email) {
        await messenger().sendEmail({ to: row.email, subject: "Votre analyse de contrat", text: `Bonjour ${row.first_name ?? ""},\n\n${body}\n\nOuvrir : ${env().APP_URL.replace(/\/$/, "")}/contrats/${row.contract_id}\n` });
      }
      await ctx.db.updateTable("contract_transmissions").set({ analysis_failure_notified_at: ctx.now }).where("id", "=", row.id).execute();
      result.notified += 1;
    } catch (error) {
      result.failed += 1;
      console.error(`Notification d'analyse non envoyée : ${describeError(error)}`);
    }
  }
  return result;
}
