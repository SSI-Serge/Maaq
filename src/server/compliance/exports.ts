import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sql } from "kysely";
import { digitorn } from "@/server/adapters/digitorn";
import { drive } from "@/server/adapters/drive";
import { messenger } from "@/server/adapters/messaging";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { readStaged } from "@/server/contracts/staging";
import { dataDir } from "@/server/data-dir";
import type { DB } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { Rejection } from "@/server/http";
import { decrypt, decryptBytes, encryptBytes } from "@/server/security/crypto";
import { createZip, type ZipEntry } from "./zip";
import type { Kysely } from "kysely";

/** Export des données d'un profil (US-55) : droit d'accès et de portabilité. */

export const DOWNLOAD_DAYS = 7;
/** Une préparation qui n'a pas abouti au bout de ce délai est considérée comme échouée (RF10). */
const STUCK_MINUTES = 15;

export type ExportStatus = "requested" | "preparing" | "ready" | "failed" | "expired";

export interface ExportState {
  id: string | null;
  status: ExportStatus | "none";
  /** Une demande est en cours : le bouton affiche « Export en cours de préparation » (RF5). */
  inProgress: boolean;
  requestedAt: string | null;
  downloadExpiresAt: string | null;
}

const key = () => Buffer.from(env().ENCRYPTION_KEY, "base64");
const exportsDir = () => path.join(dataDir(), "exports");
const fileOf = (id: string) => path.join(exportsDir(), `${id}.bin`);

function requireProfile(session: SessionContext): void {
  if (session.user.role === "admin") throw new Rejection("forbidden", "Un administrateur n'a pas de données à exporter.", 403);
}

// ---------------------------------------------------------------------------
// Demande et suivi
// ---------------------------------------------------------------------------

/** Enregistre la demande ; une seule peut être en cours à la fois (RF5). */
export async function requestExport(ctx: Ctx, session: SessionContext): Promise<{ id: string; alreadyInProgress: boolean }> {
  requireProfile(session);
  const inserted = await ctx.db
    .insertInto("data_exports")
    .values({ user_id: session.user.id, requested_at: ctx.now })
    .onConflict((oc) => oc.doNothing())
    .returning("id")
    .executeTakeFirst();
  if (inserted) return { id: inserted.id, alreadyInProgress: false };
  const running = await ctx.db
    .selectFrom("data_exports")
    .select("id")
    .where("user_id", "=", session.user.id)
    .where("status", "in", ["requested", "preparing"])
    .executeTakeFirstOrThrow();
  return { id: running.id, alreadyInProgress: true };
}

export async function getExportState(ctx: Ctx, session: SessionContext): Promise<ExportState> {
  requireProfile(session);
  const row = await ctx.db
    .selectFrom("data_exports")
    .select(["id", "status", "requested_at", "download_expires_at"])
    .where("user_id", "=", session.user.id)
    .orderBy("requested_at", "desc")
    .limit(1)
    .executeTakeFirst();
  if (!row) return { id: null, status: "none", inProgress: false, requestedAt: null, downloadExpiresAt: null };
  const expired = row.status === "ready" && row.download_expires_at !== null && new Date(row.download_expires_at) <= ctx.now;
  const status: ExportStatus = expired ? "expired" : row.status;
  return {
    id: row.id,
    status,
    inProgress: status === "requested" || status === "preparing",
    requestedAt: new Date(row.requested_at).toISOString(),
    downloadExpiresAt: status === "ready" && row.download_expires_at ? new Date(row.download_expires_at).toISOString() : null,
  };
}

// ---------------------------------------------------------------------------
// Préparation en arrière-plan
// ---------------------------------------------------------------------------

function html(text: unknown): string {
  return String(text ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const date = (value: Date | string | null | undefined) => (value ? new Date(value).toISOString() : null);

interface Collected {
  generatedAt: string;
  profile: Record<string, unknown>;
  legalAcceptances: unknown[];
  agents: unknown[];
  agentInformation: unknown[];
  guestsInformation: unknown[];
  connectors: unknown[];
  ccAddresses: unknown[];
  logbook: unknown[];
  contractDetails: unknown[];
  contractDocuments: unknown[];
  consents: unknown[];
  devices: unknown[];
  digitorn: unknown;
}

/** Rassemble les données du profil, et elles seules : jamais celles de l'utilisateur principal pour un invité (RF2). */
async function collect(db: Kysely<DB>, userId: string, now: Date): Promise<{ data: Collected; documents: ZipEntry[] }> {
  const user = await db
    .selectFrom("users")
    .select(["id", "account_id", "role", "guest_rank", "first_name", "last_name", "email", "phone", "status", "activated_at", "created_at", "digitorn_user_ref"])
    .where("id", "=", userId)
    .executeTakeFirstOrThrow();
  const isPrimary = user.role === "primary_user";

  const decryptValue = (buffer: Buffer | Uint8Array) => decrypt(Buffer.from(buffer), key());
  const infoRows = (ownerIds: string[], onlyEnteredBy?: string) =>
    ownerIds.length === 0
      ? []
      : (() => {
          let query = db
            .selectFrom("user_agent_info_values as v")
            .innerJoin("agent_info_fields as f", "f.id", "v.info_field_id")
            .innerJoin("agents as a", "a.id", "f.agent_id")
            .innerJoin("users as u", "u.id", "v.user_id")
            .select(["u.first_name", "a.name as agent", "f.label", "v.item_position", "v.value_encrypted", "v.updated_at"])
            .where("v.user_id", "in", ownerIds)
            .orderBy("a.name")
            .orderBy("f.label")
            .orderBy("v.item_position");
          if (onlyEnteredBy) query = query.where("v.updated_by_user_id", "=", onlyEnteredBy);
          return query.execute();
        })();

  const guests = isPrimary
    ? await db.selectFrom("users").select("id").where("account_id", "=", user.account_id!).where("role", "=", "guest").execute()
    : [];

  const [legal, agents, own, guestInfo, connections, accountConnections, cc, logbook, values, docs, consents, devices] = await Promise.all([
    db
      .selectFrom("legal_acceptances as la")
      .innerJoin("legal_document_versions as v", "v.id", "la.version_id")
      .select(["v.document_type", "v.version_label", "la.accepted_at"])
      .where("la.user_id", "=", userId)
      .orderBy("la.accepted_at")
      .execute(),
    db
      .selectFrom("profile_agents as pa")
      .innerJoin("agents as a", "a.id", "pa.agent_id")
      .select(["a.name", "pa.added_at", "pa.removed_at"])
      .where("pa.user_id", "=", userId)
      .orderBy("pa.added_at")
      .execute(),
    infoRows([userId]),
    infoRows(guests.map((g) => g.id), userId),
    db
      .selectFrom("agent_connections as c")
      .innerJoin("agents as a", "a.id", "c.agent_id")
      .innerJoin("connector_types as t", "t.id", "c.connector_type_id")
      .select(["a.name as agent", "t.label as connector", "c.connected_email", "c.status"])
      .where("c.user_id", "=", userId)
      .execute(),
    isPrimary
      ? db
          .selectFrom("account_connections as c")
          .innerJoin("connector_types as t", "t.id", "c.connector_type_id")
          .select(["t.label as connector", "c.connected_email", "c.status"])
          .where("c.account_id", "=", user.account_id!)
          .execute()
      : Promise.resolve([]),
    db
      .selectFrom("cc_addresses as c")
      .innerJoin("agents as a", "a.id", "c.agent_id")
      .select(["a.name as agent", "c.email"])
      .where("c.user_id", "=", userId)
      .execute(),
    db
      .selectFrom("logbook_entries as e")
      .innerJoin("agents as a", "a.id", "e.agent_id")
      .select(["a.name as agent", "e.occurred_at", "e.entry_type", "e.summary", "e.result"])
      .where("e.requester_user_id", "=", userId)
      .where("e.anonymization_status", "<>", "pending")
      .orderBy("e.occurred_at")
      .execute(),
    db
      .selectFrom("contract_field_values as v")
      .innerJoin("account_contracts as ac", "ac.id", "v.account_contract_id")
      .innerJoin("contract_definitions as d", "d.id", "ac.contract_definition_id")
      .innerJoin("contract_field_definitions as f", "f.id", "v.field_definition_id")
      .leftJoin("contract_field_options as o", "o.id", "v.value_option_id")
      .select([
        "d.name as contract",
        "f.label",
        "f.field_type",
        "v.value_text",
        "v.value_amount",
        "o.label as option_label",
        sql<string | null>`to_char(v.value_date, 'YYYY-MM-DD')`.as("value_date"),
        "v.updated_at",
      ])
      .where("v.updated_by_user_id", "=", userId)
      .orderBy("d.name")
      .orderBy("f.label")
      .execute(),
    db
      .selectFrom("contract_documents as cd")
      .innerJoin("account_contracts as ac", "ac.id", "cd.account_contract_id")
      .innerJoin("contract_definitions as d", "d.id", "ac.contract_definition_id")
      .select(["cd.id", "d.name as contract", "cd.file_name", "cd.mime_type", "cd.added_at", "cd.classification_status", "cd.drive_file_ref", "cd.staging_storage_key", "ac.account_id"])
      .where("cd.added_by_user_id", "=", userId)
      .orderBy("cd.added_at")
      .execute(),
    db
      .selectFrom("contract_consent_events as e")
      .innerJoin("contract_definitions as d", "d.id", "e.contract_definition_id")
      .innerJoin("legal_document_versions as v", "v.id", "e.legal_version_id")
      .select(["d.name as contract", "e.action_type", "e.trigger_reason", "e.occurred_at", "v.version_label"])
      .where("e.actor_user_id", "=", userId)
      .orderBy("e.occurred_at")
      .execute(),
    db
      .selectFrom("devices")
      .select(["device_type", "browser", "first_connected_at", "last_activity_at", "revoked_at"])
      .where("user_id", "=", userId)
      .orderBy("first_connected_at")
      .execute(),
  ]);

  const documents: ZipEntry[] = [];
  const documentRows: unknown[] = [];
  for (const doc of docs) {
    let included = false;
    try {
      const content =
        doc.classification_status === "classified" && doc.drive_file_ref
          ? (await drive().read(doc.account_id, doc.drive_file_ref)).content
          : doc.staging_storage_key
            ? await readStaged(doc.staging_storage_key)
            : null;
      if (content) {
        documents.push({ name: `documents/${doc.contract.replace(/[\\/:*?"<>|]/g, "_")}/${doc.id}-${doc.file_name}`, data: content });
        included = true;
      }
    } catch {
      // Fichier momentanément illisible : la fiche reste dans l'export, avec la mention « non inclus ».
    }
    documentRows.push({ contrat: doc.contract, fichier: doc.file_name, ajouteLe: date(doc.added_at), inclusDansLExport: included });
  }

  // Données détenues par Digitorn : historique, configuration des agents (RT1).
  let digitornData: unknown = null;
  if (user.digitorn_user_ref) digitornData = await digitorn().exportUserData(user.digitorn_user_ref);

  const data: Collected = {
    generatedAt: now.toISOString(),
    profile: {
      prenom: user.first_name,
      nom: user.last_name,
      email: user.email,
      telephone: user.phone,
      role: user.role === "primary_user" ? "Utilisateur principal" : user.guest_rank === "core" ? "Invité 1" : "Invité",
      creeLe: date(user.created_at),
      activeLe: date(user.activated_at),
    },
    legalAcceptances: legal.map((l) => ({ document: l.document_type === "privacy_policy" ? "Politique de confidentialité" : "Conditions d'utilisation", version: l.version_label, accepteLe: date(l.accepted_at) })),
    agents: agents.map((a) => ({ agent: a.name, ajouteLe: date(a.added_at), retireLe: date(a.removed_at) })),
    agentInformation: own.map((r) => ({ agent: r.agent, champ: r.label, position: r.item_position, valeur: decryptValue(r.value_encrypted), modifieLe: date(r.updated_at) })),
    guestsInformation: guestInfo.map((r) => ({ invite: r.first_name, agent: r.agent, champ: r.label, position: r.item_position, valeur: decryptValue(r.value_encrypted) })),
    connectors: [
      ...connections.map((c) => ({ agent: c.agent, connecteur: c.connector, adresse: c.connected_email, etat: c.status })),
      ...accountConnections.map((c) => ({ agent: "(compte)", connecteur: c.connector, adresse: c.connected_email, etat: c.status })),
    ],
    ccAddresses: cc.map((c) => ({ agent: c.agent, adresse: c.email })),
    logbook: logbook.map((e) => ({ agent: e.agent, date: date(e.occurred_at), type: e.entry_type, resume: e.summary, resultat: e.result })),
    contractDetails: values.map((v) => ({
      contrat: v.contract,
      champ: v.label,
      valeur: v.field_type === "text" ? v.value_text : v.field_type === "date" ? v.value_date : v.field_type === "amount" ? v.value_amount : v.option_label,
      modifieLe: date(v.updated_at),
    })),
    contractDocuments: documentRows,
    consents: consents.map((c) => ({ contrat: c.contract, action: c.action_type === "granted" ? "Consentement donné" : "Consentement retiré", origine: c.trigger_reason, date: date(c.occurred_at), versionDuTexte: c.version_label })),
    devices: devices.map((d) => ({ type: d.device_type, navigateur: d.browser, premiereConnexion: date(d.first_connected_at), derniereActivite: date(d.last_activity_at), revoqueLe: date(d.revoked_at) })),
    digitorn: digitornData,
  };
  return { data, documents };
}

const SECTIONS: [keyof Collected, string][] = [
  ["legalAcceptances", "Documents acceptés"],
  ["agents", "Mes agents"],
  ["agentInformation", "Mes informations par agent"],
  ["guestsInformation", "Informations de mes invités que j'ai renseignées"],
  ["connectors", "Connecteurs et boîte de validation"],
  ["ccAddresses", "Adresses en copie"],
  ["logbook", "Carnet de bord (mes demandes et actions)"],
  ["contractDetails", "Détails de contrats que j'ai renseignés"],
  ["contractDocuments", "Documents de contrats que j'ai ajoutés"],
  ["consents", "Mes consentements"],
  ["devices", "Mes appareils"],
];

/** Document lisible par une personne : les mêmes données que le fichier structuré (RF4). */
function readable(data: Collected): string {
  const table = (rows: unknown[]) => {
    if (rows.length === 0) return "<p><em>Aucune donnée.</em></p>";
    const columns = Object.keys(rows[0] as object);
    return `<table><thead><tr>${columns.map((c) => `<th>${html(c)}</th>`).join("")}</tr></thead><tbody>${rows
      .map((row) => `<tr>${columns.map((c) => `<td>${html((row as Record<string, unknown>)[c])}</td>`).join("")}</tr>`)
      .join("")}</tbody></table>`;
  };
  const profile = Object.entries(data.profile)
    .map(([k, v]) => `<tr><th>${html(k)}</th><td>${html(v)}</td></tr>`)
    .join("");
  const digitornSection = data.digitorn
    ? `<h2>Données détenues par Digitorn</h2><pre>${html(JSON.stringify(data.digitorn, null, 2))}</pre>`
    : "";
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Mes données MAAQ</title>
<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#2b211f}table{border-collapse:collapse;width:100%;margin:.5rem 0 1.5rem}th,td{border:1px solid #ddcfc0;padding:.4rem .6rem;text-align:left;vertical-align:top;font-size:.9rem}th{background:#f6f0e4}pre{background:#f6f0e4;padding:1rem;overflow:auto;font-size:.8rem}</style></head><body>
<h1>Mes données MAAQ</h1><p>Export généré le ${html(data.generatedAt)}. Les mêmes données figurent dans le fichier mes-donnees.json, dans un format réutilisable.</p>
<h2>Mon profil</h2><table><tbody>${profile}</tbody></table>
${SECTIONS.map(([k, title]) => `<h2>${html(title)}</h2>${table(data[k] as unknown[])}`).join("")}
${digitornSection}</body></html>`;
}

/**
 * Prépare l'export : rassemble les données, fabrique l'archive (document lisible, données structurées,
 * documents de contrats), la chiffre et prévient le profil par email avec un lien valable 7 jours (RF3, RF4, RT2).
 * Un échec l'en informe aussi, pour qu'il renouvelle sa demande (RF10).
 */
export async function prepareExport(ctx: Ctx, exportId: string): Promise<"ready" | "failed" | "skipped"> {
  const claimed = await ctx.db
    .updateTable("data_exports")
    .set({ status: "preparing", updated_at: ctx.now })
    .where("id", "=", exportId)
    .where("status", "=", "requested")
    .returning("user_id")
    .executeTakeFirst();
  if (!claimed) return "skipped"; // déjà prise en charge

  const user = await ctx.db.selectFrom("users").select(["email", "first_name"]).where("id", "=", claimed.user_id).executeTakeFirstOrThrow();
  try {
    const { data, documents } = await collect(ctx.db, claimed.user_id, ctx.now);
    const archive = createZip(
      [
        { name: "LISEZ-MOI.txt", data: Buffer.from("Export de vos données MAAQ.\n\nmes-donnees.html : document lisible.\nmes-donnees.json : les mêmes données, dans un format réutilisable.\ndocuments/ : les documents de contrats que vous avez ajoutés.\n", "utf8") },
        { name: "mes-donnees.html", data: Buffer.from(readable(data), "utf8") },
        { name: "mes-donnees.json", data: Buffer.from(JSON.stringify(data, null, 2), "utf8") },
        ...documents,
      ],
      ctx.now,
    );
    await mkdir(exportsDir(), { recursive: true });
    await writeFile(fileOf(exportId), encryptBytes(archive, key()));
    const expires = new Date(ctx.now.getTime() + DOWNLOAD_DAYS * 86_400_000);
    await ctx.db
      .updateTable("data_exports")
      .set({ status: "ready", ready_at: new Date(), download_expires_at: expires, storage_key: exportId, updated_at: new Date() })
      .where("id", "=", exportId)
      .execute();
    await messenger().sendEmail({
      to: user.email,
      subject: "Votre export de données MAAQ est prêt",
      text:
        `Bonjour ${user.first_name},\n\nL'export de vos données est prêt. Vous pouvez le télécharger après vous être connecté à MAAQ :\n` +
        `${env().APP_URL.replace(/\/$/, "")}/export?id=${exportId}\n\nCe lien est valable ${DOWNLOAD_DAYS} jours (jusqu'au ${expires.toLocaleDateString("fr-FR")}).\n\nL'équipe MAAQ`,
    });
    return "ready";
  } catch (error) {
    await failExport(ctx, exportId, user, (error as Error).message);
    return "failed";
  }
}

async function failExport(ctx: Ctx, exportId: string, user: { email: string; first_name: string }, reason: string): Promise<void> {
  await rm(fileOf(exportId), { force: true });
  await ctx.db.updateTable("data_exports").set({ status: "failed", failure_reason: reason.slice(0, 500), updated_at: new Date() }).where("id", "=", exportId).execute();
  try {
    await messenger().sendEmail({
      to: user.email,
      subject: "Votre export de données MAAQ n'a pas pu être préparé",
      text: `Bonjour ${user.first_name},\n\nLa préparation de l'export de vos données a échoué. Vous pouvez renouveler votre demande depuis les Réglages de MAAQ.\n\nL'équipe MAAQ`,
    });
  } catch (error) {
    console.error("Échec d'export enregistré, email non envoyé :", error);
  }
}

export function prepareInBackground(ctx: Ctx, exportId: string): void {
  void prepareExport(ctx, exportId).catch((error) => console.error("Préparation de l'export", exportId, error));
}

// ---------------------------------------------------------------------------
// Téléchargement et nettoyage
// ---------------------------------------------------------------------------

/** Archive déchiffrée, pour son propriétaire connecté, tant que le lien est valable (RF6, RT2). */
export async function readExport(ctx: Ctx, session: SessionContext, exportId: string): Promise<Buffer> {
  requireProfile(session);
  const row = await ctx.db
    .selectFrom("data_exports")
    .select(["status", "download_expires_at"])
    .where("id", "=", exportId)
    .where("user_id", "=", session.user.id)
    .executeTakeFirst();
  if (!row) throw new Rejection("not_found", "Cet export n'existe pas.", 404);
  if (row.status !== "ready" || !row.download_expires_at || new Date(row.download_expires_at) <= ctx.now) {
    throw new Rejection("export_expired", "Ce lien de téléchargement n'est plus valable. Demandez un nouvel export depuis les Réglages.", 410);
  }
  return decryptBytes(await readFile(fileOf(exportId)), key());
}

/** Supprime les fichiers d'export de profils qui disparaissent (suppression définitive d'un compte ou d'un invité). */
export async function deleteExportFiles(db: Kysely<DB>, userIds: string[]): Promise<void> {
  if (userIds.length === 0) return;
  const rows = await db.selectFrom("data_exports").select("id").where("user_id", "in", userIds).execute();
  for (const row of rows) await rm(fileOf(row.id), { force: true });
}

/** Supprime les fichiers dont le lien a expiré (RT2) et conclut les préparations restées en suspens (RF10). */
export async function cleanupExports(ctx: Ctx): Promise<{ expired: number; failed: number }> {
  const expiredRows = await ctx.db
    .selectFrom("data_exports")
    .select("id")
    .where("status", "=", "ready")
    .where("download_expires_at", "<=", ctx.now)
    .execute();
  for (const row of expiredRows) {
    await rm(fileOf(row.id), { force: true });
    await ctx.db.updateTable("data_exports").set({ status: "expired", storage_key: null, updated_at: ctx.now }).where("id", "=", row.id).execute();
  }

  const stuck = await ctx.db
    .selectFrom("data_exports as e")
    .innerJoin("users as u", "u.id", "e.user_id")
    .select(["e.id", "u.email", "u.first_name"])
    .where("e.status", "in", ["requested", "preparing"])
    .where("e.requested_at", "<", new Date(ctx.now.getTime() - STUCK_MINUTES * 60_000))
    .execute();
  for (const row of stuck) await failExport(ctx, row.id, row, "Préparation interrompue");
  return { expired: expiredRows.length, failed: stuck.length };
}
