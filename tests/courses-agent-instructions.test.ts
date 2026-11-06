import { describe, expect, it } from "vitest";
import { checkDialogue, courseInstructions, DIALOGUE_MAX_CHARS, InstructionsError } from "@/server/courses/agent/instructions";

describe("Consignes de l'agent Courses et repas : socle fixe + dialogue remplaçable (CR-32)", () => {
  it("le socle vient d'abord et le dialogue ensuite", () => {
    const text = courseInstructions();
    expect(text.indexOf("Socle fixe")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Socle fixe")).toBeLessThan(text.indexOf("Dialogue de l'agent"));
  });

  it("le socle porte les règles de confidentialité et de répartition du travail", () => {
    const text = courseInstructions();
    expect(text).toMatch(/Tu ne reçois \*\*jamais\*\* les allergies ni les régimes/);
    expect(text).toMatch(/une photo de ticket/);
    expect(text).toMatch(/N\/A/);
    expect(text).toMatch(/Seuls la ville et le mot « supermarché »/);
    expect(text).toMatch(/invité secondaire peut seulement consulter la liste de courses et y ajouter un produit/);
    expect(text).toMatch(/vouvoie/);
  });

  it("le dialogue propose les 7 parcours", () => {
    const text = courseInstructions();
    for (const p of ["Liste de courses et menu de la semaine", "Ajouter un produit", "Ajouter un plat", "Menu à partir d'un ticket", "Enregistrer un ticket", "Mettre à jour la liste après un achat", "Budget par rayon"]) {
      expect(text).toContain(p);
    }
  });

  it("un dialogue de remplacement prend la place du fichier mais jamais celle du socle", () => {
    const text = courseInstructions({ replacement: "Nouveau dialogue sans parcours." });
    expect(text).toContain("Nouveau dialogue sans parcours.");
    expect(text).not.toContain("Au début de chaque conversation");
    expect(text).toContain("Tu ne reçois **jamais** les allergies ni les régimes");
  });

  it("un dialogue vide ou trop long est refusé", () => {
    expect(() => checkDialogue("   ")).toThrow(InstructionsError);
    expect(() => checkDialogue("x".repeat(DIALOGUE_MAX_CHARS + 1))).toThrow(/dépasse/);
    expect(checkDialogue("  ok  ")).toBe("ok");
  });

  it("ni le socle ni le dialogue du dépôt ne mentionnent d'allergie ou de régime à demander dans le tchat", () => {
    const text = courseInstructions();
    expect(text).toMatch(/Ne demande jamais une allergie ni un régime dans le tchat/);
    expect(text).toMatch(/Les allergies et les régimes ne se demandent pas ici/);
  });
});
