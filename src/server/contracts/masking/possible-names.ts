import { isKnownNonName } from "./rules";

/**
 * « Nom possible » (US-137) : sur un courrier photographié, un nom sans civilité ni étiquette (un conjoint qui n'est pas membre du foyer, un tiers) s'écrit souvent seul sur sa
 * ligne, en majuscules (« MBAYE DIALLO FATOU »). Aucune règle sûre ne le distingue d'un titre : on le SIGNALE dans l'aperçu, l'utilisateur décide de le masquer. Rien n'est jamais masqué d'office.
 *
 * Une ligne est signalée quand elle ne contient que 2 à 4 mots en majuscules (les particules « de », « du », « van »… ne comptent pas), dont aucun n'est un mot courant de contrat
 * (« ATTESTATION », « CONDITIONS »…), un mot de fonction ni un assureur connu.
 */

const CONNECTORS = new Set(["DE", "DU", "DES", "LA", "LE", "LES", "ET", "D", "L", "VAN", "VON", "DEL", "DA", "DI", "DOS", "DAS", "BEN", "EL", "AL"]);

const fold = (word: string) => word.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();

// Mots d'en-têtes et de rubriques de contrats, courriers, factures et avis, en capitales sans accent.
const GENERIC = new Set(
  `ATTESTATION FACTURE FACTURES CONTRAT CONTRATS ASSURANCE ASSURANCES CONDITIONS CONDITION PARTICULIERES PARTICULIERE GENERALES GENERALE AVIS ECHEANCE ECHEANCES ECHEANCIER AUTO AUTOMOBILE HABITATION MUTUELLE
  SANTE ENERGIE ELECTRICITE GAZ PRET EMPRUNTEUR EMPRUNTEURS OFFRE RELEVE INFORMATION INFORMATIONS TABLEAU GARANTIES GARANTIE NOTICE CERTIFICAT ADHESION MONTANT TOTAL DATE DATES PAGE MADAME MONSIEUR MESSIEURS
  TITULAIRE SOUSCRIPTEUR ASSURE ASSUREE CLIENT CLIENTE REFERENCE REFERENCES DETAIL DETAILS PRIME COTISATION FRANCHISE FRANCHISES VEHICULE LOGEMENT DEVIS COURRIER SERVICE SERVICES CONSEIL AGENCE ADRESSE
  COORDONNEES BANCAIRES BANCAIRE PAIEMENT REGLEMENT TARIF TARIFS OPTION OPTIONS EXCLUSIONS EXCLUSION DECLARATION SINISTRE SINISTRES FOURNITURE CONTRAVENTION INFRACTION AMENDE FORFAITAIRE TRESOR PUBLIC
  REPUBLIQUE FRANCAISE MINISTERE NATIONALE PREFECTURE POLICE GENDARMERIE IMPOT IMPOTS CONSOMMATION RESUME SYNTHESE RECAPITULATIF TICKET BORDEREAU DOCUMENT DOCUMENTS ANNEXE ANNEXES PIECE PIECES
  IDENTITE OBJET MOTIF MENTIONS LEGALES CONDITIONS CONFIDENTIEL URGENT IMPORTANT RAPPEL RELANCE MISE DEMEURE COMPTE COMPTES BANQUE CREDIT EPARGNE PLACEMENT RETRAITE PREVOYANCE DECES INVALIDITE`
    .split(/\s+/)
    .filter(Boolean),
);

const CAPS_LINE = /^[A-ZÀ-ÝŒ][A-ZÀ-ÝŒ'’ -]*$/u;

/** Les lignes du texte (masqué) qui ressemblent à un nom en majuscules, sans doublon, telles qu'elles s'écrivent. */
export function possibleNameLines(text: string): string[] {
  const out = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/[\s,;:.]+$/u, "");
    if (!line || !CAPS_LINE.test(line)) continue;
    const words = line.split(/\s+/).filter(Boolean);
    const names = words.filter((w) => !CONNECTORS.has(fold(w).replace(/['’-]/g, "")));
    if (names.length < 2 || names.length > 4 || words.length > 6) continue;
    if (names.some((w) => w.replace(/[^\p{L}]/gu, "").length < 2)) continue;
    // Aucun mot courant de contrat, de fonction ou d'assureur, y compris dans une partie d'un mot composé (« DORI-REINE »).
    const generic = names.some((w) => [w, ...w.split(/[-'’]/)].some((part) => part.length > 1 && (GENERIC.has(fold(part)) || isKnownNonName(part))));
    if (generic) continue;
    out.add(line);
  }
  return [...out];
}
