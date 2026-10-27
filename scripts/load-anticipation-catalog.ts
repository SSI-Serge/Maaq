// Charge le catalogue d'anticipation (US-102 RT1, US-111 réduite, D60) depuis un fichier de données, sur DATABASE_URL.
//
//   npx tsx scripts/load-anticipation-catalog.ts                                  # relit data/catalogue-anticipation.json et montre l'aperçu, sans rien écrire
//   npx tsx scripts/load-anticipation-catalog.ts --file autre.json --appliquer    # applique, seulement s'il n'y a aucune erreur
//
// Le fichier est un tableau JSON : une entrée par rappel, avec les colonnes de la future console (code, libelle, categorie, medical, par_membre, periode_*, delai_jours, frequence_annees,
// role, age_min_mois, age_max_mois, situation, source, date_revue, valide_par, actif). Les contrôles sont ceux de la console (code unique, âge minimal ≤ âge maximal, source, revue et
// « validé par » pour un rappel médical actif). Le chargement se fait par code, entièrement ou pas du tout ; un rappel absent du fichier est désactivé, jamais supprimé.
import { readFile } from "node:fs/promises";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { applyCatalog, previewCatalog, situationKeys, validateCatalog, type CatalogFileRow } from "../src/server/assistant/catalog";
import type { DB } from "../src/server/db/schema.generated";
import { poolOptions } from "../src/server/db/pool-options";
import { loadEnv } from "./lib/load-env";

loadEnv();
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const file = arg("file") ?? "data/catalogue-anticipation.json";
const apply = process.argv.includes("--appliquer");

const rows = JSON.parse(await readFile(file, "utf8")) as CatalogFileRow[];
if (!Array.isArray(rows)) throw new Error("Le fichier doit contenir un tableau de rappels.");

const pool = new Pool(poolOptions());
const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }) });
try {
  const { items, errors } = validateCatalog(rows, await situationKeys(db));
  if (errors.length) {
    console.error(`${errors.length} erreur(s) : rien n'est appliqué.`);
    for (const e of errors) console.error(`  Ligne ${e.line}, ${e.column} : ${e.message}`);
    process.exitCode = 1;
  } else {
    const preview = await previewCatalog(db, items);
    console.log(`Aperçu : ${preview.created.length} créé(s), ${preview.updated.length} modifié(s), ${preview.deactivated.length} désactivé(s), ${preview.unchanged.length} inchangé(s).`);
    for (const code of preview.created) console.log(`  + ${code}`);
    for (const u of preview.updated) console.log(`  ~ ${u.code} : ${u.changes.map((c) => `${c.field} ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`).join(" ; ")}`);
    for (const code of preview.deactivated) console.log(`  - Le code ${code} n'est plus présent : le rappel sera désactivé`);
    if (apply) {
      const done = await applyCatalog(db, items);
      console.log(`Appliqué. ${done.withdrawnQuestions} question(s) sans réponse retirée(s).`);
    } else console.log("Simulation : rien n'a été écrit (ajoutez --appliquer).");
  }
} finally {
  await db.destroy();
}
