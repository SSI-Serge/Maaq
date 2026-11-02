// `npm run check:contracts` : contrôle de mise en service de Contrats V2 (lecture seule, ne modifie rien).
//   npm run check:contracts                 → état pour le mode d'essai (CONTRACT_ANALYSIS_MODE=preview)
//   npm run check:contracts -- --live       → ce qu'il faut encore avant d'ouvrir l'analyse pour de bon (avis du DPO, brief du consultant…) : échoue tant que ce n'est pas levé
// Il lit DATABASE_URL et les variables d'environnement du service (CONTRACT_*, ASSISTANT_MODE…) ; pour contrôler une zone en ligne, lancez-le avec ses valeurs.
import { execFileSync } from "node:child_process";
import { Pool } from "pg";
import { poolOptions } from "../src/server/db/pool-options";
import { loadEnv } from "./lib/load-env";

loadEnv();
const live = process.argv.includes("--live");
const blocking: string[] = [];
const toConfirm: string[] = [];
const ok: string[] = [];
const fail = (message: string) => blocking.push(message);

const mode = process.env.CONTRACT_ANALYSIS_MODE ?? "off";
const reader = process.env.CONTRACT_READER_URL;
const storage = process.env.CONTRACT_STORAGE ?? "local";
const pool = new Pool(poolOptions());

try {
  // --- Schéma du lot 11 -------------------------------------------------------------------------------------------------
  const objects = await pool.query<{ name: string }>(
    `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = ANY($1)
     UNION ALL SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = 'public' AND p.proname = ANY($2)`,
    [["contract_field_documents", "contract_transmissions", "contract_analysis_reviews", "contract_reports", "contract_document_mask_counts", "v_contract_reviews_to_decide"], ["purge_expired_contract_documents", "ensure_base_contracts", "contract_challenge_available"]],
  );
  const present = new Set(objects.rows.map((r) => r.name));
  const missing = ["contract_field_documents", "contract_transmissions", "contract_analysis_reviews", "contract_reports", "contract_document_mask_counts", "v_contract_reviews_to_decide", "purge_expired_contract_documents", "ensure_base_contracts", "contract_challenge_available"].filter((n) => !present.has(n));
  if (missing.length) fail(`Schéma du lot 11 incomplet : ${missing.join(", ")} (appliquer le rattrapage ou les migrations 0015 et 0016, après sauvegarde).`);
  else ok.push("Schéma du lot 11 présent.");

  // --- Environnement du service ----------------------------------------------------------------------------------------
  if (storage !== "gcs") toConfirm.push(`CONTRACT_STORAGE=${storage} : les documents restent dans le dossier de données local. Sur un service en ligne, utiliser « gcs » avec CONTRACT_BUCKET (bucket chiffré en Union européenne).`);
  else if (!process.env.CONTRACT_BUCKET) fail("CONTRACT_STORAGE=gcs sans CONTRACT_BUCKET.");
  else ok.push(`Stockage des documents : bucket ${process.env.CONTRACT_BUCKET}.`);
  if (mode === "off") toConfirm.push("CONTRACT_ANALYSIS_MODE=off : le masquage, l'aperçu et l'analyse sont fermés.");
  if (mode !== "off" && !reader) fail("Analyse ouverte (preview ou live) sans CONTRACT_READER_URL : aucun document ne serait lu ni masqué.");
  if (reader) {
    try {
      const headers: Record<string, string> = {};
      if (new URL(reader).hostname.endsWith(".run.app")) headers.Authorization = `Bearer ${execFileSync("gcloud", ["auth", "print-identity-token"], { encoding: "utf8", shell: true, stdio: ["ignore", "pipe", "ignore"] }).trim()}`;
      const response = await fetch(`${reader.replace(/\/+$/, "")}/status`, { headers, signal: AbortSignal.timeout(60_000) });
      if (response.ok) ok.push(`Service de lecture joignable (${((await response.json()) as { tool?: string }).tool ?? "version inconnue"}).`);
      else fail(`Service de lecture : réponse ${response.status}.`);
    } catch (error) {
      toConfirm.push(`Service de lecture non contrôlé depuis ici (${(error as Error).message.slice(0, 80)}). Contrôler GET /status avec un jeton d'identité.`);
    }
  }
  if (mode === "live") {
    if (process.env.ASSISTANT_MODE !== "live") fail("CONTRACT_ANALYSIS_MODE=live demande ASSISTANT_MODE=live.");
    if (!process.env.ANTHROPIC_API_KEY) fail("CONTRACT_ANALYSIS_MODE=live demande ANTHROPIC_API_KEY.");
  }
  if (live && mode !== "live") toConfirm.push(`CONTRACT_ANALYSIS_MODE=${mode} : à passer à « live » au moment de l'ouverture.`);

  // --- Réglages et catégories -------------------------------------------------------------------------------------------
  const settings = await pool.query<{ setting_key: string; value_text: string | null }>("SELECT setting_key, value_text FROM platform_settings WHERE setting_key IN ('contract_broker_name', 'contract_broker_email', 'contract_read_confidence_threshold_pct', 'max_contracts_per_category', 'contract_document_retention_days')");
  const setting = (key: string) => settings.rows.find((r) => r.setting_key === key)?.value_text ?? null;
  if (!setting("contract_broker_name") || !setting("contract_broker_email")) toConfirm.push("Courtier non désigné (console > Réglages) : le challenge reste fermé aux familles.");
  else ok.push(`Courtier désigné : ${setting("contract_broker_name")}.`);
  ok.push(`Seuil de lecture : ${setting("contract_read_confidence_threshold_pct") ?? "80"} % ; conservation : ${setting("contract_document_retention_days") ?? "30"} jours ; limite : ${setting("max_contracts_per_category") ?? "20"} contrats par catégorie.`);

  const categories = await pool.query<{ id: string; name: string; fields: number; required: number; health_help: number }>(
    `SELECT d.id, d.name, count(f.id)::int AS fields, count(f.id) FILTER (WHERE f.is_required)::int AS required,
            count(f.id) FILTER (WHERE f.help ILIKE '%relevés de soins%')::int AS health_help
       FROM contract_definitions d LEFT JOIN contract_document_fields f ON f.contract_definition_id = d.id WHERE d.archived_at IS NULL GROUP BY d.id ORDER BY d.sort_order, d.id`,
  );
  for (const c of categories.rows) {
    if (c.fields === 0) toConfirm.push(`Catégorie « ${c.name} » : aucun champ de document (rien à déposer ni à transmettre).`);
    else if (c.required === 0) fail(`Catégorie « ${c.name} » : aucun champ obligatoire.`);
    if (/mutuelle|emprunteur|sant[ée]/i.test(c.name) && c.fields > c.health_help) toConfirm.push(`Catégorie « ${c.name} » : la consigne « Ne déposez que vos documents contractuels, pas vos relevés de soins… » manque dans l'aide de ${c.fields - c.health_help} champ(s).`);
  }
  ok.push(`${categories.rows.length} catégorie(s) proposée(s), ${categories.rows.filter((c) => c.fields > 0).length} avec des champs de documents.`);

  // --- Textes juridiques et points ouverts avant l'ouverture réelle de l'analyse ----------------------------------------
  const consent = await pool.query<{ content: string }>("SELECT content FROM legal_document_versions WHERE document_type = 'contract_analysis_consent' AND published_at <= now() ORDER BY published_at DESC, id DESC LIMIT 1");
  if (!consent.rows[0] || /provisoire|dpo/i.test(consent.rows[0].content)) (live ? fail : toConfirm.push.bind(toConfirm))("Texte de consentement à l'analyse : provisoire, en attente de l'avis du DPO (C-07).");
  else ok.push("Texte de consentement à l'analyse : définitif.");
  const open = [
    "Avis du DPO sur le traitement hors Union européenne par l'API Anthropic et sur la pseudonymisation (C-06, C-07, C-17).",
    "Brief du consultant : plan et contenu du rapport (C-02, C-05) ; le rapport affiche aujourd'hui un contenu de démonstration.",
    "Accord du PO sur le coût du service de lecture et du bucket en production (accordé pour le projet de test seulement).",
    "Seuil de non-fuite sur de vrais documents, avec le jeu du PO (C-16) : `npm run bench:ocr` sur le service cible, puis recette (docs/contrats-v2-recette.md).",
  ];
  for (const item of open) (live ? fail : toConfirm.push.bind(toConfirm))(`À lever avant l'ouverture réelle : ${item}`);
} finally {
  await pool.end();
}

for (const line of ok) console.log(`  ✓ ${line}`);
if (toConfirm.length) console.log("\nÀ confirmer :\n" + toConfirm.map((p) => `  - ${p}`).join("\n"));
if (blocking.length) {
  console.error(`\n${live ? "Ouverture de l'analyse" : "Mise en service"} bloquée :\n` + blocking.map((p) => `  ✗ ${p}`).join("\n"));
  process.exit(1);
}
console.log(`\nContrôle ${live ? "d'ouverture de l'analyse" : "de mise en service"} : rien de bloquant.`);
