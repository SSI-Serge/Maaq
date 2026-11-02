/**
 * Ce qui autorise la transmission d'un contrat pour analyse (US-129 RF1, US-136 RF6 et RF7, US-137 RF1 et RF7, US-138). Fonction pure : les états viennent de la base,
 * la décision de ce qui part, de ce qui attend et de ce qui bloque est ici, testable sans base.
 */

/** États d'un document (US-136 RF7) : « Masquage en cours », « À vérifier », « Vérifié », « Lecture incertaine », « Illisible ». */
export type DocumentState = "masking" | "to_verify" | "verified" | "uncertain" | "unreadable";

export const STATE_LABEL: Record<DocumentState, string> = {
  masking: "Masquage en cours",
  to_verify: "À vérifier",
  verified: "Vérifié",
  uncertain: "Lecture incertaine",
  unreadable: "Illisible",
};

export interface DocumentView {
  fieldId: string;
  fieldName: string;
  required: boolean;
  /** Absent quand le champ est vide. */
  state: DocumentState | null;
  /** L'utilisateur a confirmé l'aperçu (US-137 RF4). Un document « Lecture incertaine » se confirme aussi (RF8). */
  confirmed: boolean;
  /** Page de santé douteuse restée dans le texte : analyse bloquée (US-136 RF5). */
  healthDoubt?: boolean;
  /** Lecture sous le seuil de confiance : même vérifiée par l'utilisateur, l'analyse attend un administrateur (US-136 CA 6.2, US-138). */
  lowConfidence?: boolean;
}

export type BlockReason =
  | { code: "missing_required"; fieldName: string }
  | { code: "masking_in_progress"; fieldName: string }
  | { code: "not_verified"; fieldName: string }
  | { code: "unreadable_required"; fieldName: string }
  | { code: "health_doubt"; fieldName: string };

export interface TransmissionPlan {
  /** Tout est prêt : l'analyse peut partir (ou attendre l'administrateur, voir `needsAdmin`). */
  allowed: boolean;
  reasons: BlockReason[];
  /** Documents facultatifs illisibles, laissés de côté : « Le document [nom] était illisible : il n'a pas été analysé. » (US-137 RF7). */
  skipped: string[];
  /** Au moins un document en « Lecture incertaine » : la demande attend la décision d'un administrateur (US-138). */
  needsAdmin: boolean;
}

/**
 * @param verificationRequired vrai pendant le pilote (C-13) : chaque document doit être vérifié avant la première analyse.
 */
export function planAnalysis(documents: DocumentView[], verificationRequired = true): TransmissionPlan {
  const reasons: BlockReason[] = [];
  const skipped: string[] = [];
  let needsAdmin = false;
  for (const doc of documents) {
    if (doc.state === null) {
      if (doc.required) reasons.push({ code: "missing_required", fieldName: doc.fieldName });
      continue;
    }
    if (doc.healthDoubt) {
      reasons.push({ code: "health_doubt", fieldName: doc.fieldName });
      continue;
    }
    if (doc.state === "unreadable") {
      // Obligatoire : à remplacer. Facultatif : laissé de côté, l'analyse part sans lui (décision du PO du 01/11/2026).
      if (doc.required) reasons.push({ code: "unreadable_required", fieldName: doc.fieldName });
      else skipped.push(doc.fieldName);
      continue;
    }
    if (doc.state === "masking") {
      reasons.push({ code: "masking_in_progress", fieldName: doc.fieldName });
      continue;
    }
    if (doc.state === "uncertain" || doc.lowConfidence) needsAdmin = true;
    if (verificationRequired && !doc.confirmed) reasons.push({ code: "not_verified", fieldName: doc.fieldName });
  }
  return { allowed: reasons.length === 0, reasons, skipped, needsAdmin };
}

/** Message de la mention ajoutée à l'analyse quand un document facultatif a été laissé de côté. */
export const skippedNotice = (fieldName: string) => `Le document ${fieldName} était illisible : il n'a pas été analysé.`;

/** Message affiché à côté du bouton « Transmettre » pour une raison de blocage (US-126 RF5, US-137 RF1). */
export function reasonText(reason: BlockReason): string {
  switch (reason.code) {
    case "missing_required":
      return `Le document « ${reason.fieldName} » est obligatoire.`;
    case "masking_in_progress":
      return `Le masquage de « ${reason.fieldName} » est en cours.`;
    case "not_verified":
      return `Vérifiez et confirmez « ${reason.fieldName} » avant de transmettre.`;
    case "unreadable_required":
      return `« ${reason.fieldName} » est illisible : remplacez-le par une photo plus nette.`;
    case "health_doubt":
      return `« ${reason.fieldName} » contient peut-être des données de santé : ne déposez que vos documents contractuels.`;
  }
}
