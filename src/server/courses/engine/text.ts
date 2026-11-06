/**
 * Moteur « Courses et repas » : outils de texte repris de courses.py (norm, has, plist, minutes…).
 * Fonctions pures, sans base de données : le comportement de référence est celui du script Digitorn (CR-13).
 */

/** Minuscules, « œ » devenu « oe », accents retirés. */
export function norm(value: unknown): string {
  const text = String(value ?? "").toLowerCase().replace(/œ/g, "oe");
  return text.normalize("NFD").replace(/\p{M}/gu, "");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Le mot (ou l'expression) `k` figure dans `text`, au pluriel éventuel, sans lettre accolée. */
export function has(k: string, text: string): boolean {
  return new RegExp(`(?<![a-z])${escapeRegex(k)}s?(?![a-z])`).test(text);
}

/** Arrondi « à l'entier pair » comme `round()` de Python. */
export function pyRound(value: number): number {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff < 0.5) return floor;
  if (diff > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

/** Arrondi à 2 décimales ; l'écriture décimale exacte du nombre décide, comme en Python. */
export function round2(value: number): number {
  return Number(value.toFixed(2));
}

export function plist(value: unknown): string[] {
  return String(value ?? "")
    .split(/[;,]/)
    .map((x) => x.trim())
    .filter((x) => x);
}

/** « 1 h 30 » ou « 45 min » en minutes ; `fallback` quand rien n'est lisible. */
export function minutesOf(text: unknown, fallback: number | null): number | null {
  const t = String(text ?? "");
  const hours = /(\d+)\s*h\s*(\d+)?/.exec(t);
  if (hours) return Number(hours[1]) * 60 + Number(hours[2] ?? 0);
  const mins = /(\d+)\s*min/.exec(t);
  return mins ? Number(mins[1]) : fallback;
}

/** Durée d'un plat : 60 minutes quand rien n'est lisible (comportement de courses.py). */
export function dishMinutes(text: unknown): number {
  return minutesOf(text, 60) as number;
}

export function fmtMin(value: number): string {
  const n = pyRound(value);
  return n >= 60 ? `${Math.floor(n / 60)} h ${String(n % 60).padStart(2, "0")}` : `${n} min`;
}

/** Mots d'un ingrédient qu'on ne compte pas pour rapprocher deux plats. */
export const STOP_ING = new Set(["marinade", "assaisonnement", "garniture", "sel", "poivre", "eau", "epices", "epice", "bouillon", "huile", "sucre", "herbes", "persil", "piment"]);
/** Mots seuls qui rapprocheraient des produits sans rapport (« conserve », « bœuf », « blanc »…). */
export const SINGLE_DENY = new Set(["conserve", "cube", "boite", "blanc", "blancs", "boeuf", "liquide", "cuisses", "cuisse", "frais", "fumees", "fumee", "entier", "vert", "rouge", "surgeles", "surgele", "pelees"]);
export const GENERIC = new Set(["huile", "sauce", "poudre", "fruits", "autre", "pate", "produit"]);

export function ingPhrases(ing: unknown): string[] {
  const s = String(ing ?? "").replace(/\([^)]*\)/g, " ");
  return s
    .split(/[,/;]| et /)
    .map((p) => p.trim())
    .filter((p) => p);
}

export function tokens(ing: unknown): Set<string> {
  const out = new Set<string>();
  for (const phrase of ingPhrases(ing)) {
    for (const w of norm(phrase).split(/\s+/)) {
      if (w.length >= 4 && !STOP_ING.has(w)) out.add(w);
    }
  }
  return out;
}

export function intersect<T>(a: Set<T>, b: Set<T>): Set<T> {
  const out = new Set<T>();
  for (const x of a) if (b.has(x)) out.add(x);
  return out;
}

export const DAYS = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"] as const;
