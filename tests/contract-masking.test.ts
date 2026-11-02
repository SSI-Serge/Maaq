import { describe, expect, it } from "vitest";
import { createTokenSpace, maskDocument, residualIssues, type HouseholdFacts } from "@/server/contracts/masking/engine";
import { classifyPage } from "@/server/contracts/masking/health";
import { ibanValid, nirValid } from "@/server/contracts/masking/rules";
import { CORPUS, household, NIR_SPACED, nirKey } from "./fixtures/contract-corpus";

const NOW = new Date("2026-11-02T10:00:00Z");

const mask = (pages: string[], extra: Parameters<typeof maskDocument>[1] extends infer O ? Partial<O> : never = {}) => maskDocument(pages, { household, now: NOW, ...extra });

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
    // Une longue suite de chiffres est désormais masquée d'office (filet de la couche 1) ; le contrôle final la signale encore si elle survit sur un texte déjà masqué.
    expect(mask(["Référence interne : 123456789012 — voir le dossier."]).text).toContain("[IDENTIFIANT_1]");
    const residual = residualIssues("Référence interne : 123456789012 — voir le dossier.", { household, now: NOW });
    expect(residual).toEqual(["longue suite de chiffres"]);
    expect(JSON.stringify(residual)).not.toContain("1234");
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

// Documents du même modèle que de vrais courriers photographiés (attestation d'un fournisseur d'énergie, avis de contravention), mais ENTIÈREMENT FICTIFS : numéros sans
// étiquette standard, groupes de chiffres séparés par des espaces, tableau lu en désordre, noms en majuscules dans l'ordre inverse.
describe("numéros de courriers photographiés : étiquettes inhabituelles et groupes de chiffres (C-16)", () => {
  const facts: HouseholdFacts = { people: [{ id: "m-1", firstName: "Jean-Pierre", lastName: "Durand" }, { id: "m-2", firstName: "Aïcha", lastName: "Ndiaye-Bello" }] };
  const doc = [
    "ATTESTATION DE FOURNITURE D'ÉLECTRICITÉ",
    "N° client : 1 234 567 890",
    "N° de compte : 1 23 4 567 890 123",
    "PDL : 12 345 678 901 234",
    "Point de livraison n° 98765432109876",
    "NDIAYE BELLO AÏCHA DURAND 4 rue du Four 35000 Rennes",
    "Avis de contravention n° 2610458731 du 12/03/2026, montant 135,00 €",
    "Référence de paiement : 0123 4567 8901 2345 6789",
    "Puissance souscrite : 6 kVA, consommation annuelle 4 250 kWh, prix 0,2516 €/kWh",
  ].join("\n");

  it("masque chaque numéro, quel que soit son groupement, et garde puissances, montants, dates et consommations", () => {
    const masked = maskDocument([doc], { household: facts, now: NOW });
    for (const digits of ["1 234 567 890", "1 23 4 567 890 123", "12 345 678 901 234", "98765432109876", "2610458731", "0123 4567 8901 2345 6789"]) expect(masked.text).not.toContain(digits);
    expect(masked.text).not.toMatch(/\d{9,}/);
    for (const kept of ["6 kVA", "4 250 kWh", "0,2516 €/kWh", "135,00 €", "12/03/2026"]) expect(masked.text).toContain(kept);
    expect(masked.residual).toEqual([]);
  });

  it("un nom du foyer en majuscules, dans le désordre, est masqué quel que soit l'ordre des mots", () => {
    const masked = maskDocument([doc], { household: facts, now: NOW });
    expect(masked.text).not.toMatch(/NDIAYE|BELLO|AÏCHA|DURAND/);
    expect(masked.references).toMatchObject({ "[PERSONNE_1]": { kind: "member" } });
  });

  it("une longue suite de chiffres reste masquée sans étiquette, mais un montant avec décimales ne l'est pas", () => {
    const masked = maskDocument(["Code 123456789012 puis total 1 234 567,89 € et 3,14159265358"], { household: facts, now: NOW });
    expect(masked.text).toContain("[IDENTIFIANT_1]");
    expect(masked.text).toContain("1 234 567,89 €");
    expect(masked.text).toContain("3,14159265358");
  });
});

// Cas révélés par le banc de lecture (scripts/contract-ocr-bench.ts) sur des photos fictives : l'OCR abîme les étiquettes et les lettres de l'IBAN.
describe("erreurs de lecture sur les étiquettes et l'IBAN (banc de lecture, C-16)", () => {
  it("« Permis obtenu te 12/09/2003 » et « Né te 14/06/1984 » (le lu « te ») sont transformés comme les formes bien lues", () => {
    const masked = mask(["Permis obtenu te 12/09/2003 ;\nNé te 14/06/1984"]);
    expect(masked.text).not.toMatch(/2003|1984/);
    expect(masked.text).toMatch(/permis depuis \d+ ans/);
    expect(masked.text).toMatch(/âge : \d+ ans/);
  });

  it("un IBAN dont les lettres du pays sont mal lues est masqué après l'étiquette, jusqu'au dernier groupe de chiffres, sans avaler la suite", () => {
    const masked = mask([`Coordonnées bancaires : :IBAN Frr6300060001 1234567890" se BIC: AGRIFRPP`]);
    expect(masked.text).not.toMatch(/6300060001|1234567890|Frr63/);
    expect(masked.text).toContain("BIC");
    expect(masked.text).toMatch(/\[IBAN_1\]/);
  });

  it("une longue suite de chiffres précédée de quelques lettres (« Frr6300060001 1234567890 ») est masquée même sans étiquette", () => {
    const masked = mask(["Réf Frr6300060001 1234567890 fin"]);
    expect(masked.text).not.toMatch(/6300060001/);
  });
});
