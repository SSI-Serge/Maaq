import { describe, expect, it } from "vitest";
import { createTokenSpace, maskDocument, residualIssues, type HouseholdFacts } from "@/server/contracts/masking/engine";
import { classifyPage } from "@/server/contracts/masking/health";
import { ibanValid, nirValid } from "@/server/contracts/masking/rules";

const NOW = new Date("2026-11-02T10:00:00Z");

const household: HouseholdFacts = {
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
const mask = (pages: string[], extra: Parameters<typeof maskDocument>[1] extends infer O ? Partial<O> : never = {}) => maskDocument(pages, { household, now: NOW, ...extra });

// Jeu de documents fictifs annotés (C-16) : `leaks` ne doit apparaître nulle part dans le texte masqué, `kept` doit y rester (l'analyse en a besoin).
interface Doc {
  name: string;
  pages: string[];
  leaks: string[];
  kept: string[];
}

const nirBody = "1840669123456";
const nirKey = String(97 - Number(BigInt(nirBody) % 97n)).padStart(2, "0");
const NIR_SPACED = `1 84 06 69 123 456 ${nirKey}`;

const CORPUS: Doc[] = [
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

describe("masquage des documents de contrat : jeu fictif annoté (US-136, C-16)", () => {
  for (const doc of CORPUS) {
    it(`${doc.name} : aucune donnée personnelle ne reste, les données utiles sont gardées`, () => {
      const masked = mask(doc.pages);
      for (const leak of doc.leaks) expect(masked.text, `fuite de « ${leak} »`).not.toContain(leak);
      for (const kept of doc.kept) expect(masked.text, `donnée utile perdue : « ${kept} »`).toContain(kept);
      expect(masked.state).toBe("ok");
    });
  }

  it("transforme la date de naissance en âge et la date de permis en ancienneté ; l'adresse devient un département", () => {
    const masked = mask([CORPUS[0].pages[0]]);
    expect(masked.text).toContain("âge : 42 ans");
    expect(masked.text).toContain("âge : 44 ans");
    expect(masked.text).toContain("permis depuis 23 ans");
    expect(masked.text).toContain("département 69");
    expect(masked.counts.AGE).toBe(2);
  });

  it("jetons typés et stables : un même nom garde le même jeton dans tous les documents du contrat ; les membres du foyer sont des références", () => {
    const space = createTokenSpace();
    const a = mask(["Souscripteur : Camille Durand, conducteur : Julien Durand"], { space });
    const b = mask(["Le dossier de Camille Durand est complet. Conseiller : M. Antoine Martin"], { space });
    const first = /\[PERSONNE_(\d+)\]/.exec(a.text)![0];
    expect(b.text).toContain(first);
    expect(Object.values(a.references).map((r) => r.id).sort()).toEqual(["m-camille", "m-julien"]);
    // Une personne inconnue du foyer reçoit un jeton sans référence : forme neutre à l'affichage.
    const stranger = /\[PERSONNE_\d+\]/g;
    expect(b.text.match(stranger)!.length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(b.references)).not.toContain("[PERSONNE_9]");
  });

  it("tolère les erreurs de lecture sur les noms du foyer : « DUR4ND » est reconnu, « Léo » seul n'est pas confondu avec un mot", () => {
    const masked = mask(["Le dossier de Camil1e DUR4ND est en cours. Le léopard n'est pas une personne."]);
    expect(masked.text).not.toMatch(/DUR4ND|Camil1e/i);
    expect(masked.text).toContain("léopard");
  });

  it("« Masquer aussi ce mot » : toutes les occurrences, sans tenir compte des accents ni des majuscules", () => {
    const masked = mask(["Le garage Bélier répare. Contactez BELIER ou belier."], { extraWords: ["bélier"] });
    expect(masked.text).not.toMatch(/b[ée]lier/i);
    expect(masked.counts.DONNEE).toBe(3);
  });

  it("retire les pages de relevés de soins et de questionnaires remplis, bloque en cas de doute, garde un tableau de garanties", () => {
    const guarantees = "TABLEAU DES GARANTIES — Honoraires médicaux : 200 % BR. Optique : forfait 300 €. Soins dentaires : 150 % BR. Cotisation mensuelle : 62,40 €.";
    const statement = "DÉCOMPTE DE REMBOURSEMENT\n12/03/2026 Consultation généraliste 25,00 €\n20/04/2026 Pharmacie 14,50 €";
    const questionnaire = "QUESTIONNAIRE DE SANTÉ\nAvez-vous été hospitalisé ? Oui / Non\nSuivez-vous un traitement ? Oui / Non\nFumez-vous ? Oui / Non";
    const doubtful = "Votre médecin traitant doit être déclaré à la caisse.";
    expect([guarantees, statement, questionnaire, doubtful].map(classifyPage)).toEqual(["ok", "removed", "removed", "doubt"]);
    const masked = mask([guarantees, statement, questionnaire]);
    expect(masked.removedHealthPages).toBe(2);
    expect(masked.text).toContain("200 % BR");
    expect(masked.text).not.toContain("Pharmacie");
    expect(masked.state).toBe("ok");
    expect(mask([guarantees, doubtful]).state).toBe("blocked");
  });

  it("un motif personnel resté visible rend le document « À vérifier » (US-136 RF6), sans jamais citer la valeur", () => {
    const masked = mask(["Référence interne : 123456789012 — voir le dossier."]);
    expect(masked.state).toBe("to_verify");
    expect(masked.residual).toEqual(["longue suite de chiffres"]);
    expect(JSON.stringify(masked.residual)).not.toContain("1234");
    expect(residualIssues("écrire à jean.dupont@exemple.fr", { household, now: NOW })).toEqual(["email"]);
  });

  it("contrôles de clé : IBAN (mod 97) et numéro de sécurité sociale (clé 97)", () => {
    expect(ibanValid("FR76 3000 6000 0112 3456 7890 189")).toBe(true);
    expect(ibanValid("FR76 3000 6000 0112 3456 7890 188")).toBe(false);
    expect(nirValid(NIR_SPACED)).toBe(true);
    expect(nirValid(`1 84 06 69 123 456 ${String((Number(nirKey) + 1) % 97).padStart(2, "0")}`)).toBe(false);
  });

  it("un IBAN à la clé fausse est quand même masqué après l'étiquette « IBAN : » (erreur de lecture)", () => {
    const masked = mask(["IBAN : FR76 3000 6000 0112 3456 7890 199"]);
    expect(masked.text).toBe("IBAN : [IBAN_1]");
  });
});

// Mesure du rappel (C-16) sur des identifiants structurés tirés au hasard (graine fixe), insérés dans des phrases : au moins 99 % masqués ; ici, tous.
function lcg(seed: number) {
  let s = seed;
  return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296;
}
const digits = (rnd: () => number, n: number) => Array.from({ length: n }, () => Math.floor(rnd() * 10)).join("");
function randomIban(rnd: () => number): string {
  const bban = digits(rnd, 23);
  const rest = Number(BigInt(`${bban}152700`) % 97n); // FR00 → F=15, R=27, puis 00
  const check = String(98 - rest).padStart(2, "0");
  const raw = `FR${check}${bban}`;
  return raw.replace(/(.{4})/g, "$1 ").trim();
}
const letters = "ABCDEFGHJKLMNPQRSTVWXYZ";
const pick = (rnd: () => number, n: number) => Array.from({ length: n }, () => letters[Math.floor(rnd() * letters.length)]).join("");

describe("rappel sur les identifiants structurés tirés au hasard (C-16)", () => {
  const rnd = lcg(42);
  const samples: { value: string; sentence: (v: string) => string }[] = [];
  for (let i = 0; i < 60; i++) {
    samples.push({ value: randomIban(rnd), sentence: (v) => `Prélèvement sur le compte ${v} chaque mois.` });
    samples.push({ value: `${pick(rnd, 2)}-${digits(rnd, 3)}-${pick(rnd, 2)}`, sentence: (v) => `Véhicule immatriculé ${v}, garé à domicile.` });
    samples.push({ value: `0${6 + Math.floor(rnd() * 2)} ${digits(rnd, 2)} ${digits(rnd, 2)} ${digits(rnd, 2)} ${digits(rnd, 2)}`, sentence: (v) => `Joignable au ${v} en journée.` });
    samples.push({ value: `${pick(rnd, 6).toLowerCase()}.${pick(rnd, 5).toLowerCase()}@exemple.org`, sentence: (v) => `Écrire à ${v} pour toute question.` });
  }
  it("masque tous les identifiants du jeu, sans toucher aux montants ni aux dates", () => {
    let missed = 0;
    for (const s of samples) {
      const masked = mask([s.sentence(s.value) + " Franchise : 1 250,00 € au 01/03/2027."]);
      if (masked.text.replace(/\s/g, "").toLowerCase().includes(s.value.replace(/\s/g, "").toLowerCase())) missed += 1;
      expect(masked.text).toContain("1 250,00 €");
      expect(masked.text).toContain("01/03/2027");
    }
    expect(samples.length).toBe(240);
    expect(missed / samples.length).toBeLessThanOrEqual(0.01);
    expect(missed).toBe(0);
  });
});
