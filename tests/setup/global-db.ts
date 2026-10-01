import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import type { TestProject } from "vitest/node";
import { DEV_PASSWORD, DEV_USER, startEmbeddedDb } from "../../scripts/lib/embedded-db";
import { migrate } from "../../src/server/db/migrate";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/**
 * Base de test : TEST_DATABASE_URL si fournie (CI), sinon un PostgreSQL embarqué
 * temporaire, effacé à la fin. Le schéma y est appliqué par les vraies migrations.
 */
export default async function setup(project: TestProject) {
  let databaseUrl = process.env.TEST_DATABASE_URL;
  let stop: (() => Promise<void>) | undefined;

  if (!databaseUrl) {
    const port = 5434 + Math.floor(Math.random() * 500);
    const dir = await mkdtemp(path.join(os.tmpdir(), "maaq-test-pg-"));
    const pg = await startEmbeddedDb({ dir, port, databases: ["maaq_test"], persistent: false });
    databaseUrl = `postgres://${DEV_USER}:${DEV_PASSWORD}@localhost:${port}/maaq_test`;
    stop = () => pg.stop();
  }

  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await migrate(pool);
  } finally {
    await pool.end();
  }

  project.provide("databaseUrl", databaseUrl);
  return async () => {
    await stop?.();
  };
}
