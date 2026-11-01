import { fold } from "@/server/assistant/pseudonymize";
import type { PageState } from "./types";

/**
 * Pages de santé (C-14, US-136 RF5) : décomptes de remboursement, actes, praticiens, questionnaires de santé. Elles sont refusées : retirées du texte et signalées.
 * Un tableau de garanties de mutuelle parle lui aussi de « soins » et d'« honoraires » : ce qui sépare un contrat d'un relevé, ce sont les expressions propres à un
 * relevé personnel, ou des lignes de soins datées avec un montant. Un doute (une expression de santé isolée) bloque l'analyse plutôt que de laisser passer.
 */

// Expressions qui désignent un relevé personnel : la page est retirée.
const DECISIVE = [
  "decompte de prestations", "decompte de remboursement", "decompte de soins", "decompte maladie", "releve de prestations", "releve de remboursement", "releve de soins", "vos remboursements",
  "detail de vos soins", "date des soins", "date de soins", "attestation de soins", "feuille de soins",
];
// Un questionnaire de santé rempli (plusieurs questions, des réponses oui/non) est retiré ; la simple mention d'un questionnaire dans les conditions du contrat ne l'est pas.
const QUESTIONNAIRE = ["questionnaire de sante", "questionnaire medical", "declaration de sante", "declaration d'etat de sante"];
// Expressions de santé qui, seules, ne prouvent rien mais ne doivent pas passer : la page est « douteuse ».
const DOUBTFUL = [
  "etat de sante", "affection de longue duree", "medecin traitant", "pathologie", "diagnostic", "ordonnance", "praticien", "professionnel de sante", "code acte", "numero finess", "finess",
  "arret de travail", "hospitalisation de", "traitement medical", "antecedents medicaux",
];
const CARE_LINE = /\b\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}\b[^\n]{0,80}\b\d+[.,]\d{2}\s?(?:€|eur)/gi;

export function classifyPage(text: string): PageState {
  const folded = fold(text);
  if (DECISIVE.some((term) => folded.includes(term))) return "removed";
  if (QUESTIONNAIRE.some((term) => folded.includes(term))) {
    const answers = (folded.match(/(?<![a-z])(?:oui|non)(?![a-z])/g) ?? []).length;
    const questions = (text.match(/\?/g) ?? []).length;
    return answers >= 3 || questions >= 3 ? "removed" : "doubt";
  }
  // Des lignes « date … montant » à plusieurs reprises avec un acte ou un praticien : un relevé de soins sans titre.
  const careLines = (text.match(CARE_LINE) ?? []).filter((line) => /(?:consultation|acte|pharmacie|dentiste|kin[ée]|radio|analyse|optique|sp[ée]cialiste|g[ée]n[ée]raliste)/i.test(line));
  if (careLines.length >= 2) return "removed";
  if (DOUBTFUL.some((term) => folded.includes(term))) return "doubt";
  return "ok";
}

export const REMOVED_PAGE_LINE = "[Page retirée : relevé ou données de santé]";
