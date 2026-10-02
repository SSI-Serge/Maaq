import type { Pool, PoolClient } from "pg";
import { hashSecret } from "../../src/server/security/password";

/**
 * Données de démonstration pour le développement local, documentées dans docs/comptes-de-test.md.
 * Chaque partie (profils, catalogue, contrats) n'est créée que si elle n'existe pas encore :
 * une base déjà remplie reçoit seulement ce qui a été ajouté depuis.
 */
export const DEMO_PASSWORD = "Demo-maaq-2026";

export async function seedDemo(pool: Pool): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const created = [await seedProfiles(client), await seedCatalog(client), await seedContracts(client), await seedMailboxes(client)].some(Boolean);
    await client.query("COMMIT");
    return created;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function seedProfiles(client: PoolClient): Promise<boolean> {
  const { rowCount } = await client.query("SELECT 1 FROM users WHERE email = 'admin@maaq.test'");
  if (rowCount) return false;
  const passwordHash = await hashSecret(DEMO_PASSWORD);

  await client.query(
    `INSERT INTO users (role, first_name, last_name, email, password_hash, status, activated_at)
     VALUES ('admin', 'Alex', 'Admin', 'admin@maaq.test', $1, 'active', now())`,
    [passwordHash],
  );
  const {
    rows: [account],
  } = await client.query<{ id: string }>(`INSERT INTO accounts (status, guest_quota) VALUES ('active', 3) RETURNING id`);
  await client.query(
    `INSERT INTO users (account_id, role, first_name, last_name, email, phone, password_hash, status, initial_setup_step, activated_at)
     VALUES ($1, 'primary_user', 'Camille', 'Martin', 'camille@maaq.test', '+33612345678', $2, 'active', 'completed', now())`,
    [account.id, passwordHash],
  );
  await client.query(
    `INSERT INTO users (account_id, role, guest_rank, first_name, last_name, email, password_hash, status, activated_at)
     VALUES ($1, 'guest', 'core', 'Dominique', 'Martin', 'dominique@maaq.test', $2, 'active', now())`,
    [account.id, passwordHash],
  );
  await client.query(
    `INSERT INTO users (account_id, role, guest_rank, first_name, last_name, email, status)
     VALUES ($1, 'guest', 'secondary', 'Lou', 'Martin', 'lou@maaq.test', 'pending_activation')`,
    [account.id],
  );
  await client.query(
    `INSERT INTO legal_document_versions (document_type, version_label, content, published_at) VALUES
      ('privacy_policy', '1.0', 'Politique de confidentialité de MAAQ — version de démonstration.', now()),
      ('terms_of_use',   '1.0', 'Conditions d''utilisation de MAAQ — version de démonstration.', now())`,
  );
  return true;
}

/** Deux agents publiés, comme dans la maquette Administration des agents. */
async function seedCatalog(client: PoolClient): Promise<boolean> {
  const { rowCount } = await client.query("SELECT 1 FROM agents LIMIT 1");
  if (rowCount) return false;

  const agents = [
    {
      ref: "admin_classify",
      name: "Admin_Classify",
      category: "pro",
      short: "Classement automatique des documents administratifs.",
      full: "Admin_Classify range vos documents administratifs dans votre Google Drive, les renomme et vous signale les échéances.",
      examples: ["Range mes factures du mois", "Retrouve mon dernier avis d'imposition"],
      suggestions: ["Classer un document", "Voir mes échéances"],
      actions: ["Déplacer un document"],
      connectors: [["google_drive", "each_profile"]],
      fields: [] as [string, string, boolean, number, string | null][],
      cc: 0,
    },
    {
      ref: "admin_lib",
      name: "Admin_lib",
      category: "perso",
      short: "Prise de rendez-vous santé & assurance emprunteur.",
      full: "Admin_lib prend vos rendez-vous médicaux et gère vos démarches d'assurance emprunteur, en vous demandant validation avant chaque action.",
      examples: ["Prends-moi un rendez-vous chez le dentiste", "Envoie mon attestation à la banque"],
      suggestions: ["Prendre un rendez-vous", "Écrire à mon assureur"],
      actions: ["Créer un rendez-vous", "Envoyer un email"],
      connectors: [
        ["google_calendar", "each_profile"],
        ["validation_mailbox", "each_profile"],
      ],
      fields: [
        ["Téléphone", "phone", true, 1, "telephone"],
        ["Date de naissance", "past_date", true, 1, "date_naissance"],
        ["Médecin traitant", "text", false, 1, null],
      ] as [string, string, boolean, number, string | null][],
      cc: 10,
    },
  ];

  for (const agent of agents) {
    const {
      rows: [row],
    } = await client.query<{ id: string }>(
      `INSERT INTO agents (digitorn_agent_ref, name, category_id, short_description, full_description, cc_addresses_max_count)
       VALUES ($1, $2, (SELECT id FROM agent_categories WHERE code = $3), $4, $5, $6) RETURNING id`,
      [agent.ref, agent.name, agent.category, agent.short, agent.full, agent.cc],
    );
    for (const [i, content] of agent.examples.entries()) {
      await client.query(`INSERT INTO agent_sample_prompts (agent_id, kind, content, sort_order) VALUES ($1, 'example', $2, $3)`, [row.id, content, i + 1]);
    }
    for (const [i, content] of agent.suggestions.entries()) {
      await client.query(`INSERT INTO agent_sample_prompts (agent_id, kind, content, sort_order) VALUES ($1, 'first_suggestion', $2, $3)`, [row.id, content, i + 1]);
    }
    for (const [i, label] of agent.actions.entries()) {
      await client.query(`INSERT INTO agent_validated_actions (agent_id, label, sort_order) VALUES ($1, $2, $3)`, [row.id, label, i + 1]);
    }
    for (const [code, scope] of agent.connectors) {
      await client.query(
        `INSERT INTO agent_requirements (agent_id, connector_type_id, owner_scope) VALUES ($1, (SELECT id FROM connector_types WHERE code = $2), $3)`,
        [row.id, code, scope],
      );
    }
    for (const [i, [label, type, required, max, key]] of agent.fields.entries()) {
      await client.query(
        `INSERT INTO agent_info_fields (agent_id, label, data_type, is_required, max_items, shared_key, sort_order) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [row.id, label, type, required, max, key, i + 1],
      );
    }
  }
  return true;
}

/** Contrats obligatoires et leurs champs, comme dans la maquette Contrats obligatoires. */
async function seedContracts(client: PoolClient): Promise<boolean> {
  const { rowCount } = await client.query("SELECT 1 FROM contract_definitions LIMIT 1");
  if (rowCount) return false;

  const contracts: [string, [string, string, boolean, string[]][]][] = [
    ["Assurance habitation", [["Assureur", "text", true, []], ["Numéro de contrat", "text", true, []], ["Date d'échéance", "date", true, []], ["Prime annuelle", "amount", false, []]]],
    ["Assurance auto", [["Assureur", "text", true, []], ["Numéro de contrat", "text", true, []], ["Formule", "choice", false, ["Tiers", "Tiers étendu", "Tous risques"]]]],
    ["Mutuelle santé", [["Organisme", "text", true, []], ["Numéro d'adhérent", "text", true, []]]],
    ["Énergie (électricité, gaz)", [["Fournisseur", "text", true, []], ["Mensualité", "amount", false, []]]],
  ];

  for (const [i, [name, fields]] of contracts.entries()) {
    const {
      rows: [contract],
    } = await client.query<{ id: string }>(`INSERT INTO contract_definitions (name, sort_order) VALUES ($1, $2) RETURNING id`, [name, i + 1]);
    for (const [j, [label, type, required, options]] of fields.entries()) {
      const {
        rows: [field],
      } = await client.query<{ id: string }>(
        `INSERT INTO contract_field_definitions (contract_definition_id, label, field_type, is_required, sort_order) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [contract.id, label, type, required, j + 1],
      );
      for (const [k, option] of options.entries()) {
        await client.query(`INSERT INTO contract_field_options (field_definition_id, label, sort_order) VALUES ($1, $2, $3)`, [field.id, option, k + 1]);
      }
    }
  }
  return true;
}

/** Boîtes du support et des alertes, pour que les messages arrivent dans la boîte de test (/dev/boite). Sans écraser un réglage de l'administrateur. */
async function seedMailboxes(client: PoolClient): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE platform_settings SET value_text = CASE setting_key WHEN 'support_email' THEN 'support@maaq.test' ELSE 'alertes@maaq.test' END
      WHERE setting_key IN ('support_email', 'alert_email') AND value_text IS NULL`,
  );
  return (rowCount ?? 0) > 0;
}
