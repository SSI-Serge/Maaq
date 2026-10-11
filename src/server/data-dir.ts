import path from "node:path";

/** Dossier des données locales de développement (boîte de test, faux Drive) ; isolé pendant les tests. */
export function dataDir(): string {
  return process.env.MAAQ_DATA_DIR ?? path.join(process.cwd(), ".data");
}
