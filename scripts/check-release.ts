// `npm run check:release` : contrôle ce qui doit être fourni avant toute mise en production.
// Il échoue (code 1) tant que les textes juridiques sont des versions de démonstration, que le nom du
// partenaire du consentement manque, ou que les boîtes du support et des alertes ne sont pas renseignées
// (US-54 RF5, US-36 RF2, US-62 RT1).
import { Pool } from "pg";
import { loadEnv } from "./lib/load-env";

loadEnv();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const problems: string[] = [];

try {
  const { rows } = await pool.query<{ document_type: string; version_label: string; content: string }>(
    `SELECT DISTINCT ON (document_type) document_type, version_label, content
       FROM legal_document_versions WHERE published_at <= now() ORDER BY document_type, published_at DESC, id DESC`,
  );
  const labels: Record<string, string> = {
    privacy_policy: "Politique de confidentialité",
    terms_of_use: "Conditions d'utilisation",
    contract_challenge_consent: "Texte de consentement au challenge des contrats",
  };
  for (const type of Object.keys(labels)) {
    const row = rows.find((r) => r.document_type === type);
    if (!row) problems.push(`${labels[type]} : aucun texte publié.`);
    else if (/démonstration|\[nom du partenaire\]|^Politique$|^Conditions$/i.test(row.content)) problems.push(`${labels[type]} : texte provisoire (version ${row.version_label}), à remplacer par le texte définitif.`);
  }

  const settings = await pool.query<{ setting_key: string; value_text: string | null }>(
    "SELECT setting_key, value_text FROM platform_settings WHERE setting_key IN ('support_email', 'alert_email')",
  );
  for (const key of ["support_email", "alert_email"]) {
    const value = settings.rows.find((r) => r.setting_key === key)?.value_text;
    if (!value) problems.push(`Réglage « ${key} » non renseigné (console > Paramètres).`);
    else if (/@maaq\.test$/.test(value)) problems.push(`Réglage « ${key} » : adresse de démonstration (${value}).`);
  }
} finally {
  await pool.end();
}

if (problems.length) {
  console.error("Mise en production bloquée :\n" + problems.map((p) => `  - ${p}`).join("\n"));
  process.exit(1);
}
console.log("Contrôle de mise en production : rien ne manque.");
