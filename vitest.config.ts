import { defineConfig } from "vitest/config";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/setup/global-db.ts"],
    // Les tests de base partagent une seule base : on les exécute l'un après l'autre.
    fileParallelism: false,
    testTimeout: 20_000,
    // Configuration de test : clés jetables, données locales dans un dossier temporaire.
    env: {
      DATABASE_URL: "postgres://maaq:maaq@localhost:5432/inutilise",
      ENCRYPTION_KEY: randomBytes(32).toString("base64"),
      HMAC_KEY: randomBytes(32).toString("base64"),
      AUTH_SECRET: randomBytes(32).toString("base64"),
      CRON_SECRET: randomBytes(24).toString("hex"),
      MAAQ_DATA_DIR: path.join(os.tmpdir(), `maaq-test-data-${process.pid}`),
    },
    hookTimeout: 120_000,
  },
});
