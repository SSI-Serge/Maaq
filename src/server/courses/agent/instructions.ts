import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Consignes de l'agent « Courses et repas » en deux parties (CR-32) :
 * - le **socle** (`socle.md`), imposé par le code, jamais remplaçable : confidentialité, répartition du travail avec MAAQ, droits, ton ;
 * - le **dialogue** (`dialogue.md`), remplaçable (US-176, reportée après le pilote) : parcours, mise en forme des tickets, suggestions.
 * Tout passe par `courseInstructions` : le jour où le dialogue vient de la console, seul `replacement` change.
 */

export const DIALOGUE_MAX_CHARS = 20000;

export class InstructionsError extends Error {
  constructor(readonly code: "too_long" | "empty", message: string) {
    super(message);
  }
}

const cache = new Map<string, { socle: string; dialogue: string }>();

function agentDir(): string {
  return process.env.COURSES_AGENT_DIR ?? path.join(process.cwd(), "agent-courses");
}

function readParts(dir: string): { socle: string; dialogue: string } {
  let parts = cache.get(dir);
  if (!parts) {
    parts = { socle: readFileSync(path.join(dir, "socle.md"), "utf8").trim(), dialogue: readFileSync(path.join(dir, "dialogue.md"), "utf8").trim() };
    cache.set(dir, parts);
  }
  return parts;
}

/** Vérifie un dialogue de remplacement avant de l'accepter (taille, non vide). */
export function checkDialogue(text: string): string {
  const t = text.trim();
  if (!t) throw new InstructionsError("empty", "Le dialogue est vide.");
  if (t.length > DIALOGUE_MAX_CHARS) throw new InstructionsError("too_long", `Le dialogue dépasse ${DIALOGUE_MAX_CHARS} caractères.`);
  return t;
}

/**
 * Les consignes complètes : le socle d'abord, puis le dialogue. Le dialogue de remplacement (version choisie dans la console) prend la place
 * du fichier du dépôt, mais ne peut jamais passer avant le socle ni le retirer.
 */
export function courseInstructions(options: { dir?: string; replacement?: string | null } = {}): string {
  const { socle, dialogue } = readParts(options.dir ?? agentDir());
  const dialog = options.replacement ? checkDialogue(options.replacement) : dialogue;
  return `${socle}\n\n---\n\n${dialog}\n`;
}
