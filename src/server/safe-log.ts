/**
 * Description d'une erreur pour les journaux, sans son message : le message d'une erreur de base de données ou d'un service peut reprendre
 * des valeurs (titre d'un rendez-vous, adresse email, extrait d'un JSON illisible). On garde le type, le code, la contrainte, le statut HTTP et
 * les premières lignes de la pile (noms de fonctions et de fichiers), ce qui suffit à retrouver l'origine d'une panne.
 */
export function describeError(error: unknown): string {
  const e = (error ?? {}) as { name?: string; code?: string | number; constraint?: string; table?: string; statusCode?: number; status?: number; stack?: string };
  const parts = [typeof error === "object" && error !== null ? (e.name ?? "Error") : typeof error];
  if (e.code !== undefined) parts.push(`code=${e.code}`);
  if (e.constraint) parts.push(`contrainte=${e.constraint}`);
  if (e.table) parts.push(`table=${e.table}`);
  const status = e.statusCode ?? e.status;
  if (status !== undefined) parts.push(`http=${status}`);
  const frames = (typeof e.stack === "string" ? e.stack : "")
    .split("\n")
    .filter((line) => /^\s+at /.test(line))
    .slice(0, 4)
    .map((line) => line.trim().replace(/^at /, ""));
  return frames.length ? `${parts.join(" ")} [${frames.join(" < ")}]` : parts.join(" ");
}
