import { describe, expect, it } from "vitest";
import { dictatedText } from "@/client/speech";

describe("texte d'une dictée dans le champ de saisie (US-71)", () => {
  it("écrit ce qui est dit, avec ce qui est en cours de reconnaissance", () => {
    expect(dictatedText("", "Dentiste pour Léo ", "mardi à")).toBe("Dentiste pour Léo mardi à");
    expect(dictatedText("", "Dentiste pour Léo mardi à 17h ", "")).toBe("Dentiste pour Léo mardi à 17h");
  });

  it("garde le texte déjà écrit et le complète par un espace", () => {
    expect(dictatedText("Réunion jeudi.", "à 18h ", "")).toBe("Réunion jeudi. à 18h");
    expect(dictatedText("Réunion jeudi.  ", "à 18h ", "")).toBe("Réunion jeudi. à 18h");
  });

  it("laisse le champ tel quel tant que rien n'est dit", () => {
    expect(dictatedText("Réunion jeudi", "", "")).toBe("Réunion jeudi");
    expect(dictatedText("", "", "")).toBe("");
    expect(dictatedText("Réunion jeudi", " ", "")).toBe("Réunion jeudi");
  });
});
