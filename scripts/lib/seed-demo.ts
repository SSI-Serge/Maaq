import type { Pool } from "pg";
import { hashSecret } from "../../src/server/security/password";

/**
 * Données de démonstration pour le développement local. Les identifiants sont
 * documentés dans docs/comptes-de-test.md. Sans effet si l'administrateur existe déjà.
 */
export const DEMO_PASSWORD = "Demo-maaq-2026";

export async function seedDemo(pool: Pool): Promise<boolean> {
  const { rowCount } = await pool.query("SELECT 1 FROM users WHERE email = 'admin@maaq.test'");
  if (rowCount) return false;

  const passwordHash = await hashSecret(DEMO_PASSWORD);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO users (role, first_name, last_name, email, password_hash, status, activated_at)
       VALUES ('admin', 'Alex', 'Admin', 'admin@maaq.test', $1, 'active', now())`,
      [passwordHash],
    );

    const { rows: [account] } = await client.query<{ id: string }>(
      `INSERT INTO accounts (status, guest_quota) VALUES ('active', 3) RETURNING id`,
    );

    await client.query(
      `INSERT INTO users (account_id, role, first_name, last_name, email, phone, password_hash, status,
                          initial_setup_step, activated_at)
       VALUES ($1, 'primary_user', 'Camille', 'Martin', 'camille@maaq.test', '+33612345678', $2, 'active',
               'completed', now())`,
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

    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
