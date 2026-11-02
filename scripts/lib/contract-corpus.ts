import type { HouseholdFacts } from "@/server/contracts/masking/engine";

/** Documents ENTIÈREMENT FICTIFS, annotés (C-16) : partagés par les tests de masquage et par le banc de lecture (scripts/contract-ocr-bench.ts). */

export const household: HouseholdFacts = {
  people: [
    { id: "m-camille", firstName: "Camille", lastName: "Durand", birth: "1984-06" },
    { id: "m-julien", firstName: "Julien", lastName: "Durand", birth: "1982-02" },
    { id: "m-leo", firstName: "Léo", lastName: "Durand", birth: "2016-05" },
  ],
  emails: ["camille.durand@exemple.fr"],
  phones: ["06 12 34 56 78"],
  addressLines: ["12 rue des Lilas 69003 Lyon"],
  plates: ["AB-123-CD"],
};
// Jeu de documents fictifs annotés (C-16) : `leaks` ne doit apparaître nulle part dans le texte masqué, `kept` doit y rester (l'analyse en a besoin).
export interface Doc {
  name: string;
  pages: string[];
  leaks: string[];
  kept: string[];
}

export const nirBody = "1840669123456";
export const nirKey = String(97 - Number(BigInt(nirBody) % 97n)).padStart(2, "0");
export const NIR_SPACED = `1 84 06 69 123 456 ${nirKey}`;

export const CORPUS: Doc[] = [
  {
    name: "assurance auto, conditions particulières",
    pages: [
      `ASSURANCE AUTO — CONDITIONS PARTICULIÈRES
Contrat n° 2026-AU-884512            Avis d'échéance 2026
Souscripteur : Mme Camille DURAND
Adresse : 12 rue des Lilas
69003 LYON
Né(e) le 14/06/1984
Email : camille.durand@exemple.fr   Téléphone : 06 12 34 56 78
Conducteur secondaire : Julien Durand, né le 02/02/1982
Permis obtenu le 12/09/2003
Véhicule : Renault Clio V, immatriculation AB-123-CD, mise en circulation 03/2021, puissance fiscale 5 CV
Formule : Tous risques. Franchise : 350 €. Bonus-malus (CRM) : 0,76. Prime annuelle : 612,40 €. Échéance : 01/03/2027.
IBAN : FR76 3000 6000 0112 3456 7890 189
Garanties : responsabilité civile illimitée, vol et incendie plafonné à 25 000 €, bris de glace sans franchise.
Votre conseiller : M. Antoine Martin, agence de Lyon Part-Dieu.`,
    ],
    leaks: ["2026-AU-884512", "DURAND", "Durand", "Camille", "Julien", "camille.durand@exemple.fr", "06 12 34 56 78", "12 rue des Lilas", "69003", "14/06/1984", "02/02/1982", "12/09/2003", "AB-123-CD", "FR76", "7890 189", "Antoine", "Martin"],
    kept: ["Tous risques", "350 €", "0,76", "612,40 €", "01/03/2027", "25 000 €", "Renault Clio V", "5 CV", "03/2021", "bris de glace sans franchise", "Avis d'échéance 2026"],
  },
  {
    name: "habitation, avec la ligne de voie sur deux lignes et le numéro de sécurité sociale",
    pages: [
      `ASSURANCE HABITATION
N° de police : HAB-77-102938
Assuré : Julien DURAND — numéro de sécurité sociale ${NIR_SPACED}
Adresse du risque : 12 rue des Lilas, 69003 Lyon
Résidence principale, appartement de 74 m², 4 pièces.
Franchise dégât des eaux : 150 €. Plafond mobilier : 30 000 €. Cotisation : 28,50 € par mois.
Date d'effet : 15/01/2026. Échéance principale : 15/01/2027. Préavis de résiliation : 2 mois.
Contact : 04 78 00 11 22 ou contact@mutuelle-exemple.fr`,
    ],
    leaks: ["HAB-77-102938", "Julien", "DURAND", NIR_SPACED, "12 rue des Lilas", "04 78 00 11 22", "contact@mutuelle-exemple.fr", "Lyon"],
    kept: ["74 m²", "4 pièces", "150 €", "30 000 €", "28,50 €", "15/01/2026", "15/01/2027", "2 mois"],
  },
  {
    name: "assurance emprunteur",
    pages: [
      `ASSURANCE EMPRUNTEUR — OFFRE
Prêt n° PRT-2025-0045-8831 — Banque Exemple
Emprunteur : Camille Durand, née le 14 juin 1984
Co-emprunteur : Julien Durand
Capital emprunté : 245 000 €. Durée : 25 ans. Taux : 3,45 %. Quotité : 50 % / 50 %.
Garanties : décès, PTIA, IPT, ITT. Exclusions : sports dangereux. Délai de carence : 3 mois.
Coordonnées bancaires : IBAN FR7630006000011234567890189 — BIC : AGRIFRPP
Employeur : Société Dupuis Transport`,
    ],
    leaks: ["PRT-2025-0045-8831", "Camille", "Julien", "Durand", "14 juin 1984", "FR7630006000011234567890189", "AGRIFRPP", "Dupuis"],
    kept: ["245 000 €", "25 ans", "3,45 %", "50 % / 50 %", "PTIA", "IPT", "3 mois", "Banque Exemple"],
  },
];

