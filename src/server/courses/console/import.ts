import { courseError } from "../household/settings";
import { describeIssues, validateTable, type ImportOutcome, type ImportSpec } from "../imports/spec";
import { ImportFileError, readTable } from "../imports/table";

/** Lit et vérifie un fichier d'import en entier (règles communes des imports) : une seule ligne invalide le refuse, avec la ligne et la colonne en cause. Ne touche à aucune donnée. */
export async function readImport<Ctx>(spec: ImportSpec<Ctx>, file: { name: string; content: Buffer }, ctx: Ctx): Promise<ImportOutcome> {
  let table;
  try {
    table = await readTable(file);
  } catch (error) {
    if (error instanceof ImportFileError) throw courseError("invalid_import", `Import refusé : rien n'a été importé. ${error.message}`, 422);
    throw error;
  }
  const outcome = validateTable(spec, table, ctx);
  if (outcome.issues.length) throw courseError("invalid_import", "Import refusé : rien n'a été importé.", 422, { issues: describeIssues(outcome.issues) });
  if (!outcome.rows.length) throw courseError("invalid_import", "Import refusé : le fichier ne contient aucune ligne.", 422);
  return outcome;
}

/** Une erreur de contenu trouvée après la lecture (produit ou rayon inconnu…) : même présentation qu'une ligne invalide. */
export function importRefusal(issues: { line: number; column: string; message: string }[]): never {
  throw courseError("invalid_import", "Import refusé : rien n'a été importé.", 422, { issues: issues.slice(0, 100).map((i) => `ligne ${i.line}, colonne « ${i.column} » : ${i.message}`) });
}
