import { planAnalysis, reasonText, type DocumentState, type DocumentView } from "./transmission";

/**
 * Ce que « Transmettre » ferait pour un contrat (US-129 RF1 et RF2, US-130) : les canaux dont l'interrupteur est actif et utilisable, ce qui empêche l'envoi, et la
 * proposition d'activer l'autre canal. Fonction pure, partagée par l'écran (qui affiche la ligne et le bouton) et par le serveur (qui refuse ce que l'écran n'aurait pas permis).
 */

export interface PlanContract {
  analysis: { enabled: boolean };
  challenge: { enabled: boolean };
  slots: { fieldId: string; name: string; required: boolean; document: { transmittedAt: string | null; expiresAt: string; masking: { status: string; healthDoubt?: boolean } } | null }[];
  missingRequired: number;
}

export interface PlanContext {
  /** « off » : l'analyse n'est pas ouverte ; « preview » et « live » : elle l'est (en essai ou pour de bon). */
  analysisOpen: boolean;
  challengeAvailable: boolean;
  archived: boolean;
  now: Date;
  /** Pendant le pilote, chaque document doit être vérifié avant la première analyse (C-13). */
  verificationRequired?: boolean;
}

export interface TransmitPlan {
  forAnalysis: boolean;
  forChallenge: boolean;
  /** « Transmettre » est actif. */
  ready: boolean;
  /** Les documents ont déjà été transmis et existent encore : pas de nouvelle transmission avant leur suppression (US-126 RF8). */
  alreadyTransmitted: boolean;
  /** Pourquoi l'analyse ne partirait pas (documents à vérifier, illisibles…) ; le challenge, lui, n'en dépend pas. */
  analysisBlockers: string[];
  /** Documents facultatifs illisibles, laissés de côté par l'analyse (US-137 RF7). */
  skipped: string[];
  /** Au moins un document en « Lecture incertaine » : l'analyse attend un administrateur (US-138). */
  needsAdmin: boolean;
  /** Canal à proposer d'activer à la transmission (US-130) ; vide s'il n'y a rien à proposer. */
  offer: "analysis" | "challenge" | null;
  /** « Pour analyse et challenge », « Pour analyse », « Pour challenge » ou la consigne d'activer un canal (US-129 RF2). */
  line: string;
}

const STATE: Record<string, DocumentState> = { pending: "masking", masking: "masking", to_verify: "to_verify", verified: "verified", uncertain: "uncertain", unreadable: "unreadable" };

export function planTransmission(contract: PlanContract, context: PlanContext): TransmitPlan {
  const wantsAnalysis = contract.analysis.enabled && context.analysisOpen;
  const wantsChallenge = contract.challenge.enabled && context.challengeAvailable;
  const alreadyTransmitted = contract.slots.some((s) => s.document?.transmittedAt && new Date(s.document.expiresAt) > context.now);

  const views: DocumentView[] = contract.slots.map((s) => ({
    fieldId: s.fieldId,
    fieldName: s.name,
    required: s.required,
    state: s.document ? (STATE[s.document.masking.status] ?? "masking") : null,
    confirmed: s.document?.masking.status === "verified",
    healthDoubt: s.document?.masking.healthDoubt ?? false,
  }));
  const analysis = planAnalysis(views, context.verificationRequired ?? true);
  // Les champs obligatoires vides sont dits une fois, pour les deux canaux : l'analyse n'ajoute que ses propres raisons.
  const analysisBlockers = wantsAnalysis ? analysis.reasons.filter((r) => r.code !== "missing_required").map(reasonText) : [];
  const forAnalysis = wantsAnalysis && analysisBlockers.length === 0;
  const forChallenge = wantsChallenge;
  const hasSlots = contract.slots.length > 0;
  const ready = !context.archived && !alreadyTransmitted && hasSlots && contract.missingRequired === 0 && (forAnalysis || forChallenge);

  const offer =
    wantsAnalysis !== wantsChallenge
      ? wantsAnalysis
        ? context.challengeAvailable && !contract.challenge.enabled
          ? "challenge"
          : null
        : context.analysisOpen && !contract.analysis.enabled
          ? "analysis"
          : null
      : null;
  // L'analyse voulue mais bloquée (texte à vérifier…) reste annoncée : les raisons du blocage s'affichent juste dessous.
  const line = forAnalysis && forChallenge ? "Pour analyse et challenge" : forAnalysis || (wantsAnalysis && !forChallenge) ? "Pour analyse" : forChallenge ? "Pour challenge" : contract.analysis.enabled && !context.analysisOpen ? "L'envoi à l'analyse n'est pas encore ouvert" : "Activez l'analyse ou le challenge pour transmettre";
  return { forAnalysis, forChallenge, ready, alreadyTransmitted, analysisBlockers, skipped: wantsAnalysis ? analysis.skipped : [], needsAdmin: forAnalysis && analysis.needsAdmin, offer, line };
}
