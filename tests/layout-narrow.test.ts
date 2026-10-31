import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Garde-fou des écrans du lot 10 sur un téléphone étroit (360 px) : les puces et les boutons passent à la ligne et n'ont aucune largeur imposée. La mesure réelle (aucun défilement
 * horizontal) a été faite dans le navigateur à 360 px sur tous les écrans du lot ; ce test empêche de réintroduire la cause trouvée : des puces dans une ligne `actionsRow`
 * (`display: flex` sans retour à la ligne, enfants à `flex: 1`) qui fait déborder la page.
 */
const read = (path: string) => readFileSync(path, "utf8");
const css = read("src/components/family/family.module.css");

describe("écrans du lot 10 à 360 px", () => {
  it("`.wrapRow` passe à la ligne et n'impose aucune largeur ; une puce longue se replie", () => {
    const rule = /\.wrapRow\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/flex-wrap:\s*wrap/);
    const children = /\.wrapRow\s*>\s*\*\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(children).toMatch(/flex:\s*0 1 auto/);
    expect(children).toMatch(/min-width:\s*0/);
    const chip = /\.chipToggle\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(chip).toMatch(/max-width:\s*100%/);
    expect(chip).toMatch(/overflow-wrap:\s*anywhere/);
  });

  it("aucune puce du lot 10 n'est placée dans une ligne `actionsRow`", () => {
    for (const file of ["OutingsCriteria", "OutingsScreens", "HomeworkPlanner", "HomeworkScreens", "HomeworkSettings"]) {
      const source = read(`src/components/family/${file}.tsx`);
      // Chaque ligne `actionsRow` ne contient que des boutons d'action (Button) ou des liens, jamais une puce `chipToggle`.
      for (const block of source.split(/className=\{styles\.actionsRow\}/).slice(1)) {
        const row = block.slice(0, block.search(/\n\s*<\/div>/));
        expect(row, `${file} : une puce dans une ligne actionsRow`).not.toContain("chipToggle");
      }
    }
  });

  it("aucun champ du lot 10 n'a de largeur fixe en pixels", () => {
    for (const file of ["OutingsCriteria", "OutingsScreens", "HomeworkPlanner", "HomeworkScreens", "HomeworkSettings"]) {
      const source = read(`src/components/family/${file}.tsx`);
      expect(source, `${file} : largeur fixe`).not.toMatch(/style=\{\{[^}]*\bwidth:\s*\d+/);
    }
  });
});
