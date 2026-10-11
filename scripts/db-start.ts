// Démarre la base de développement et la garde ouverte jusqu'à Ctrl-C.
import { DEV_DB_DIR, devDbPort, loadEnv } from "./lib/load-env";
import { startEmbeddedDb } from "./lib/embedded-db";

loadEnv();
const pg = await startEmbeddedDb({ dir: DEV_DB_DIR, port: devDbPort(), databases: ["maaq"] });
console.log(`PostgreSQL de développement prêt sur le port ${devDbPort()} (Ctrl-C pour arrêter).`);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
