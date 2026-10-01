import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inject } from "vitest";
import { migrate } from "@/server/db/migrate";
import { seedDemo } from "../scripts/lib/seed-demo";

let pool: Pool;

beforeAll(async () => {
  pool = new Pool({ connectionString: inject("databaseUrl") });
  await seedDemo(pool);
});

afterAll(async () => {
  await pool.end();
});

async function demoAccountId(): Promise<string> {
  const { rows } = await pool.query<{ account_id: string }>("SELECT account_id FROM users WHERE email = 'camille@maaq.test'");
  return rows[0].account_id;
}

describe("base de données", () => {
  it("applique le schéma de la conception et ne rejoue pas une migration déjà passée", async () => {
    const { rows } = await pool.query("SELECT name FROM schema_migrations");
    expect(rows.map((r) => r.name)).toContain("0001_schema_initial.sql");
    expect(await migrate(pool)).toEqual([]);
  });

  it("contient les rubriques et réglages de référence", async () => {
    const { rows } = await pool.query("SELECT code FROM agent_categories ORDER BY sort_order");
    expect(rows.map((r) => r.code)).toEqual(["pro", "perso", "contracts"]);
    const settings = await pool.query("SELECT count(*)::int AS n FROM platform_settings");
    expect(settings.rows[0].n).toBeGreaterThan(0);
  });

  it("crée les données de démonstration une seule fois", async () => {
    expect(await seedDemo(pool)).toBe(false);
    const { rows } = await pool.query("SELECT role, count(*)::int AS n FROM users GROUP BY role ORDER BY role");
    expect(rows).toEqual([
      { role: "admin", n: 1 },
      { role: "primary_user", n: 1 },
      { role: "guest", n: 2 },
    ]);
  });

  it("D6 : un seul invité 1 par compte", async () => {
    const accountId = await demoAccountId();
    await expect(
      pool.query(
        `INSERT INTO users (account_id, role, guest_rank, first_name, last_name, email)
         VALUES ($1, 'guest', 'core', 'Autre', 'Noyau', 'autre-noyau@maaq.test')`,
        [accountId],
      ),
    ).rejects.toThrow(/ux_users_one_core_guest_per_account/);
  });

  it("US-18 : un email ne peut servir qu'à un seul profil, sans tenir compte de la casse", async () => {
    const accountId = await demoAccountId();
    await expect(
      pool.query(
        `INSERT INTO users (account_id, role, guest_rank, first_name, last_name, email)
         VALUES ($1, 'guest', 'secondary', 'Lou', 'Bis', 'LOU@maaq.test')`,
        [accountId],
      ),
    ).rejects.toThrow(/ux_users_email_not_removed/);
  });

  it("US-21 : le quota d'invités du compte est appliqué par la base", async () => {
    const accountId = await demoAccountId(); // quota de 3, 2 invités existants
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO users (account_id, role, guest_rank, first_name, last_name, email)
         VALUES ($1, 'guest', 'secondary', 'Sam', 'Martin', 'sam@maaq.test')`,
        [accountId],
      );
      await expect(
        client.query(
          `INSERT INTO users (account_id, role, guest_rank, first_name, last_name, email)
           VALUES ($1, 'guest', 'secondary', 'Noa', 'Martin', 'noa@maaq.test')`,
          [accountId],
        ),
      ).rejects.toThrow();
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  it("D20 : le plafond quotidien de demandes est respecté par register_agent_request", async () => {
    const accountId = await demoAccountId();
    const { rows } = await pool.query<{ id: string }>("SELECT id FROM users WHERE email = 'camille@maaq.test'");
    const userId = rows[0].id;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("UPDATE accounts SET daily_request_limit = 2 WHERE id = $1", [accountId]);
      const results: boolean[] = [];
      for (let i = 0; i < 3; i++) {
        const r = await client.query<{ ok: boolean }>("SELECT register_agent_request($1, DATE '2026-10-01') AS ok", [userId]);
        results.push(r.rows[0].ok);
      }
      expect(results).toEqual([true, true, false]);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});
