/**
 * Affichage du menu au fil de l'eau : pendant que le modèle écrit les arguments de `proposer_menu`, MAAQ en lit ce qui est déjà complet (noms des plats, nombre d'étapes) pour le
 * montrer dans le tchat avant la fin. Les arguments arrivent en JSON coupé n'importe où : on ne garde que les chaînes déjà fermées. Fichier pur, partagé avec l'écran.
 */

export interface MenuProgress {
  dinners: string[];
  express: string[];
  steps: number;
}

const NAME = /"nom"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
const STEP = /"texte"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

const unescape = (raw: string): string => {
  try {
    return JSON.parse(`"${raw}"`) as string;
  } catch {
    return raw;
  }
};

/** Ce qu'on peut déjà lire d'un `proposer_menu` partiel. Chaque plat n'apparaît qu'une fois son nom terminé ; un plat de `diners` et un de `express` ne se mélangent pas. */
export function menuProgress(json: string): MenuProgress {
  const keys = (["diners", "express", "etapes"] as const)
    .map((key) => ({ key, at: json.search(new RegExp(`"${key}"\\s*:`)) }))
    .filter((k) => k.at >= 0)
    .sort((a, b) => a.at - b.at);
  const out: MenuProgress = { dinners: [], express: [], steps: 0 };
  keys.forEach((k, i) => {
    const part = json.slice(k.at, keys[i + 1]?.at ?? json.length);
    if (k.key === "etapes") out.steps = [...part.matchAll(STEP)].length;
    else out[k.key === "diners" ? "dinners" : "express"] = [...part.matchAll(NAME)].map((m) => unescape(m[1]));
  });
  return out;
}
