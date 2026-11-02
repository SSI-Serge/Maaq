import { describe, expect, it } from "vitest";
import { maskDocument } from "@/server/contracts/masking/engine";
import { possibleNameLines } from "@/server/contracts/masking/possible-names";
import { CORPUS, household } from "../scripts/lib/contract-corpus";

const NOW = new Date("2026-11-02T10:00:00Z");

describe("« Nom possible » : lignes en majuscules qui ressemblent à un nom (US-137)", () => {
  it("signale 2 à 4 mots en majuscules seuls sur leur ligne, avec particules, tirets et apostrophes", () => {
    const text = ["MBAYE DIALLO FATOU", "KUETE KAFO DORI-REINE", "JEAN DE LA FONTAINE", "D'ALEMBERT JEAN", "Madame Dupont", "Prime : 612,40 €"].join("\n");
    expect(possibleNameLines(text)).toEqual(["MBAYE DIALLO FATOU", "KUETE KAFO DORI-REINE", "JEAN DE LA FONTAINE", "D'ALEMBERT JEAN"]);
  });

  it("ne signale ni les titres et rubriques de contrat, ni les assureurs, ni les mots de fonction", () => {
    const text = ["ATTESTATION DE FOURNITURE D'ÉLECTRICITÉ", "CONDITIONS PARTICULIÈRES", "AVIS D'ÉCHÉANCE", "ASSURANCE AUTO", "ALLIANZ ASSURANCES", "MATMUT", "GARANTIES ET FRANCHISES", "CONDUCTEUR PRINCIPAL"].join("\n");
    expect(possibleNameLines(text)).toEqual([]);
  });

  it("ne signale pas un mot seul, une ligne trop longue, une ligne avec chiffres, minuscules ou jetons", () => {
    const text = ["DUPOND", "UN DEUX TROIS QUATRE CINQ", "MARTIN 2026", "[PERSONNE_1] DUPOND", "DUPOND Marie", "A B"].join("\n");
    expect(possibleNameLines(text)).toEqual([]);
  });

  it("ne signale qu'une fois une ligne répétée, telle qu'elle s'écrit", () => {
    expect(possibleNameLines("MBAYE DIALLO FATOU,\nautre ligne\nMBAYE DIALLO FATOU")).toEqual(["MBAYE DIALLO FATOU"]);
  });

  for (const doc of CORPUS) {
    it(`${doc.name} : seuls les noms annoncés sont signalés, et jamais masqués d'office`, () => {
      const masked = maskDocument(doc.pages, { household, now: NOW });
      expect(possibleNameLines(masked.text)).toEqual(doc.flagged ?? []);
      for (const name of doc.flagged ?? []) expect(masked.text, `« ${name} » ne doit pas être masqué d'office`).toContain(name);
    });
  }
});
