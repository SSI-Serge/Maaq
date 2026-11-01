import { sql } from "kysely";
import { messenger } from "@/server/adapters/messaging";
import type { Ctx } from "@/server/auth/service";
import { env } from "@/server/env";
import { pushConfigured, sendPush } from "@/server/push/service";
import { describeError } from "@/server/safe-log";
import { notBeforeMorning, warningText, WARNING_DAYS_BEFORE } from "./retention";
import { processPending } from "./process";
import { drainStorageDeletions } from "./storage";
import { runChallengeDeliveries } from "./transmit";

/**
 * Entretien horaire des documents de contrat (C-01, US-126 RF7, RT2, US-139 RF4) :
 * - purge des documents échus (48 h après la transmission, ou 30 jours sans transmission) et fermeture des demandes « Analyses à valider » échues : fonction de la base ;
 * - effacement des fichiers dont la ligne a disparu (file de suppression du stockage) ;
 * - lecture et masquage des documents restés en attente (l'écran les lance au dépôt ; ceci rattrape un service de lecture indisponible ou un serveur arrêté) ;
 * - avertissement unique « supprimés dans 3 jours » au déposant, reporté à 8 h s'il tombe entre 21 h et 8 h (heure de la famille).
 * Sans danger à relancer : chaque passage ne fait que ce qui est dû.
 */

export interface ContractMaintenanceResult {
  purged: number;
  filesDeleted: number;
  filesFailed: number;
  warned: number;
  failed: number;
  challengeSent: number;
  challengeFailed: number;
  masked: number;
  maskingRetry: number;
}

const HOUR = 3_600_000;

export async function runContractMaintenance(ctx: Ctx): Promise<ContractMaintenanceResult> {
  const result: ContractMaintenanceResult = { purged: 0, filesDeleted: 0, filesFailed: 0, warned: 0, failed: 0, challengeSent: 0, challengeFailed: 0, masked: 0, maskingRetry: 0 };
  const purged = await sql<{ n: string }>`select purge_expired_contract_documents() as n`.execute(ctx.db);
  result.purged = Number(purged.rows[0]?.n ?? 0);
  const files = await drainStorageDeletions(ctx.db);
  result.filesDeleted = files.deleted;
  result.filesFailed = files.failed;

  // Envois au challenge restés « en cours » : repris pendant 1 heure, puis « échoué » (US-135 RF3). Avant la purge suivante : 48 h laissent la place.
  const challenge = await runChallengeDeliveries(ctx);
  result.challengeSent = challenge.sent;
  result.challengeFailed = challenge.failed;

  const masking = await processPending(ctx).catch((error) => {
    console.error(`Masquage des documents en attente : ${describeError(error)}`);
    return { processed: 0, retry: 0 };
  });
  result.masked = masking.processed;
  result.maskingRetry = masking.retry;

  // Documents jamais transmis qui seront supprimés dans 3 jours ou moins, pas encore avertis.
  const rows = await ctx.db
    .selectFrom("contract_field_documents as d")
    .innerJoin("account_contracts as c", "c.id", "d.account_contract_id")
    .innerJoin("contract_definitions as cd", "cd.id", "c.contract_definition_id")
    .innerJoin("accounts as a", "a.id", "c.account_id")
    .leftJoin("users as u", "u.id", "d.uploaded_by_user_id")
    .select(["d.id", "d.account_contract_id", "d.expires_at", "d.uploaded_by_user_id", "c.name as contract_name", "cd.archived_at", "a.family_timezone", "u.email", "u.first_name"])
    .where("d.transmitted_at", "is", null)
    .where("d.expiry_warned_at", "is", null)
    .where("d.expires_at", ">", ctx.now)
    .where("d.expires_at", "<=", new Date(ctx.now.getTime() + (WARNING_DAYS_BEFORE * 24 + 12) * HOUR))
    .execute();

  // Un seul message par contrat et par déposant, même si plusieurs documents sont concernés ; tous sont marqués une fois le message parti.
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const at = notBeforeMorning(new Date(new Date(row.expires_at).getTime() - WARNING_DAYS_BEFORE * 24 * HOUR), row.family_timezone);
    if (at.getTime() > ctx.now.getTime() || !row.uploaded_by_user_id) continue;
    const key = `${row.account_contract_id}:${row.uploaded_by_user_id}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  for (const group of groups.values()) {
    const first = group[0];
    const body = warningText(first.contract_name, first.archived_at !== null);
    try {
      const delivered = pushConfigured() ? (await sendPush(ctx, first.uploaded_by_user_id!, { title: "Mes contrats", body, url: "/contrats", tag: `contract-expiry-${first.account_contract_id}`, badge: 0 })).delivered : 0;
      if (delivered === 0 && first.email) {
        await messenger().sendEmail({ to: first.email, subject: "Vos documents de contrat seront bientôt supprimés", text: `Bonjour ${first.first_name ?? ""},\n\n${body}\n\nOuvrir : ${env().APP_URL.replace(/\/$/, "")}/contrats\n` });
      }
      await ctx.db.updateTable("contract_field_documents").set({ expiry_warned_at: ctx.now }).where("id", "in", group.map((g) => g.id)).execute();
      result.warned += 1;
    } catch (error) {
      result.failed += 1;
      console.error(`Avertissement de suppression non envoyé : ${describeError(error)}`);
    }
  }
  return result;
}
