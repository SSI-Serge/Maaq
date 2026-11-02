import { fold } from "@/server/assistant/pseudonymize";
import { PRIORITY, type Span } from "./rules";
import type { HouseholdFacts } from "./types";

/** Mots du texte avec leur position ; l'apostrophe et le tiret font partie du mot (« Jean-Pierre », « D'Alembert »). */
export function wordsOf(text: string): { start: number; end: number; word: string }[] {
  return [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, word: m[0] }));
}

/** Distance de Levenshtein bornée : s'arrête dès que la borne est dépassée. */
export function distance(a: string, b: string, bound: number): number {
  if (Math.abs(a.length - b.length) > bound) return bound + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let min = i;
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      min = Math.min(min, row[j]);
    }
    if (min > bound) return bound + 1;
    previous = row;
  }
  return previous[b.length];
}

/** Erreurs de lecture tolérées selon la longueur du mot : aucune sous 5 lettres (« Léo », « Mia »), une jusqu'à 8, deux au-delà. */
export const tolerance = (length: number) => (length < 5 ? 0 : length < 9 ? 1 : 2);

/** Confusions fréquentes de l'OCR, ramenées à une même forme avant la comparaison (0/O, 1/l/I, 5/S, 8/B). */
const ocrFold = (word: string) => fold(word).replace(/0/g, "o").replace(/[1|]/g, "l").replace(/5/g, "s").replace(/8/g, "b").replace(/[’']/g, "");

interface Needle {
  word: string;
  memberId?: string;
  kind: "first" | "last" | "address";
}

function needlesOf(facts: HouseholdFacts): Needle[] {
  const out: Needle[] = [];
  const add = (value: string | null | undefined, kind: Needle["kind"], memberId?: string) => {
    for (const w of (value ?? "").split(/[\s,]+/)) {
      if (w.replace(/[^\p{L}]/gu, "").length >= 3) out.push({ word: ocrFold(w), memberId, kind });
      // Un nom composé s'écrit tel quel (« Ndiaye-Bello ») ou en deux mots dans le désordre d'un courrier : chaque partie est aussi cherchée.
      if (w.includes("-")) for (const part of w.split("-")) if (part.replace(/[^\p{L}]/gu, "").length >= 3) out.push({ word: ocrFold(part), memberId, kind });
    }
  };
  // Un prénom désigne un membre ; un nom de famille est partagé par plusieurs membres : il ne désigne personne en particulier.
  for (const p of facts.people) {
    add(p.firstName, "first", p.id);
    add(p.lastName, "last");
  }
  for (const line of facts.addressLines ?? []) {
    // Dans une adresse, on retient les mots longs (nom de voie, ville) : « rue » ou « avenue » ne sont pas des données.
    for (const w of line.split(/[\s,]+/)) {
      const bare = w.replace(/[^\p{L}]/gu, "");
      if (bare.length >= 5 && !/^(?:avenue|boulevard|residence|impasse|chemin|route|allee)$/.test(fold(bare))) out.push({ word: ocrFold(w), kind: "address" });
    }
  }
  return out;
}

/**
 * Couche 2, données déjà connues du foyer (prénoms, nom, adresse), en liste fermée et tolérante aux erreurs de lecture : « DUP0NT » est reconnu comme « Dupont ».
 * Les chaînes exactes (email, téléphone, plaque) sont cherchées sans tolérance. Chaque prénom ou nom est masqué seul, quel que soit l'ordre « NOM Prénom ».
 */
export function householdSpans(text: string, facts: HouseholdFacts): Span[] {
  const out: Span[] = [];
  const needles = needlesOf(facts);
  for (const w of wordsOf(text)) {
    const folded = ocrFold(w.word);
    const bare = folded.replace(/[^a-z0-9]/g, "");
    if (bare.length < 3) continue;
    for (const needle of needles) {
      const n = needle.word.replace(/[^a-z0-9]/g, "");
      if (distance(bare, n, tolerance(n.length)) <= tolerance(n.length)) {
        out.push({
          start: w.start,
          end: w.end,
          type: needle.kind === "address" ? "ADRESSE" : "PERSONNE",
          key: needle.memberId ? `member:${needle.memberId}` : needle.kind === "last" ? `surname:${n}` : n,
          priority: PRIORITY.household,
          memberId: needle.memberId,
        });
        break;
      }
    }
  }
  const folded = fold(text);
  const exact = (values: string[] | undefined, type: Span["type"], normalise: (v: string) => string) => {
    for (const value of values ?? []) {
      const needle = normalise(value);
      if (needle.length < 5) continue;
      for (const m of folded.matchAll(new RegExp(needle.split("").map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s.\\-]?"), "g"))) {
        out.push({ start: m.index!, end: m.index! + m[0].length, type, key: needle, priority: PRIORITY.household });
      }
    }
  };
  exact(facts.emails, "EMAIL", (v) => fold(v).replace(/\s/g, ""));
  exact(facts.phones, "TELEPHONE", (v) => v.replace(/\D/g, "").replace(/^33/, "0"));
  exact(facts.plates, "IMMATRICULATION", (v) => fold(v).replace(/[\s-]/g, ""));
  return out;
}

/** « Masquer aussi ce mot » (US-137 RF3) : toutes les occurrences d'un mot ou d'une expression, sans tenir compte des majuscules ni des accents. */
export function manualSpans(text: string, words: string[]): Span[] {
  const out: Span[] = [];
  const folded = fold(text);
  for (const raw of words) {
    const needle = fold(raw.trim());
    if (needle.length < 2) continue;
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}(?![\\p{L}\\p{N}])`, "gu");
    for (const m of folded.matchAll(re)) out.push({ start: m.index!, end: m.index! + m[0].length, type: "DONNEE", key: needle, priority: PRIORITY.manual });
  }
  return out;
}

/**
 * Identité d'une personne trouvée par une civilité ou une étiquette (« Souscripteur : Camille DURAND ») : si l'un de ses mots est le prénom d'un membre, c'est ce membre
 * (même jeton que partout ailleurs, et référence résolue à l'affichage) ; sinon le jeton dépend des mots, quel que soit leur ordre.
 */
export function personIdentity(value: string, facts: HouseholdFacts): { key: string; memberId?: string } {
  const words = value.split(/\s+/).filter(Boolean);
  for (const p of facts.people) {
    const first = ocrFold(p.firstName).replace(/[^a-z0-9]/g, "");
    if (first.length < 3) continue;
    if (words.some((w) => {
      const bare = ocrFold(w).replace(/[^a-z0-9]/g, "");
      return distance(bare, first, tolerance(first.length)) <= tolerance(first.length);
    })) return { key: `member:${p.id}`, memberId: p.id };
  }
  return { key: words.map((w) => ocrFold(w).replace(/[^a-z0-9]/g, "")).sort().join(" ") };
}
