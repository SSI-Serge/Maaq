import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Ctx } from "@/server/auth/service";
import { getSettings, saveSettings } from "@/server/courses/household/settings";
import { ListFlow } from "@/components/courses/ListScreen";
import { prepareList } from "@/server/courses/list/service";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";
import { validateTestMenu } from "./helpers/menu";

/** US-157 RF1quater, US-167 RF1, CR-65 : la rubrique « Ingrédients / additifs exclus des références proposées » figure toujours dans la Liste de courses, d'une semaine comme d'une liste du mois, entre l'historique et le comparatif ; c'est la liste des critères actifs de la console, la même pour tous les foyers, sans produit, référence ni enseigne. */
const db = testDb();
const NOW = new Date(2026, 10, 4, 10, 0, 0);
const W0 = "2026-11-02";
const W1 = "2026-11-09";
const at = (): Ctx => ({ db, now: NOW });
const TITLE = "Ingrédients / additifs exclus des références proposées";

const html = (list: Awaited<ReturnType<typeof prepareList>>) => renderToStaticMarkup(createElement(ListFlow, { list, reload: () => {}, onWeek: () => {}, onGroup: () => {} }));
/** Le contenu de la rubrique seule (le reste de la page cite des produits et des enseignes). */
const rubric = (markup: string) => markup.slice(markup.indexOf(TITLE), markup.indexOf("Comparatif des prix"));
const order = (markup: string) => [markup.indexOf("Produits de mon historique"), markup.indexOf(TITLE), markup.indexOf("Comparatif des prix")];

describe("Rubrique « Ingrédients / additifs exclus des références proposées »", () => {
  it("présente dans la Liste de la semaine et dans la Liste du mois, entre « Produits de mon historique » et « Comparatif des prix » ; seulement les critères actifs, sans produit ni référence ni enseigne", async () => {
    await ensureCatalog(db);
    const f = await coupleFamily(db);
    const options = (await getSettings(at(), f.sophie)).options;
    await saveSettings(at(), f.sophie, { city: "Nantes", householdSize: 4, shoppingDays: [6], goals: { time: true }, cuisineIds: options.cuisines.map((c) => c.id), stores: [{ chain: "Lidl", city: "Nantes" }, { chain: "E.Leclerc", city: "Nantes" }] });
    await validateTestMenu(db, f, { picks: ["F4"], week: W0, now: NOW });
    await validateTestMenu(db, f, { picks: [], week: W1, now: NOW });
    const week = await prepareList(at(), f.sophie, W0);

    // aucun critère actif : le texte du vide, et rien d'autre
    const none = html({ ...week, criteria: [] });
    expect(none).toContain(TITLE);
    expect(none).toContain("Aucun additif exclu pour le moment.");
    expect(none).not.toContain("MAAQ ne vous propose aucune référence");
    const [a, b, c] = order(none);
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);

    // critères actifs de la console : code ou nom et raison, avec la phrase d'introduction
    const criteria = [
      { label: "E250", reason: "nitrite de sodium : charcuteries, risque discuté" },
      { label: "Dioxyde de titane", reason: "E171, interdit dans l'alimentation" },
    ];
    const shown = html({ ...week, criteria });
    expect(shown).toContain("MAAQ ne vous propose aucune référence qui contient l&#x27;un de ces additifs.");
    expect(shown).toContain("E250 — nitrite de sodium : charcuteries, risque discuté");
    expect(shown).toContain("Dioxyde de titane — E171, interdit dans l&#x27;alimentation");
    // plus de lignes par référence ni de texte de liste vide d&apos;avant
    for (const old of ["aucune référence conforme trouvée", "Aucun ingrédient exclu", "Critères additifs appliqués", "La référence suivante", "contient E", "Lidl", "Leclerc", "Pâtes", "Riz"]) expect(rubric(shown)).not.toContain(old);
    expect(shown).not.toContain("Aucun ingrédient exclu");

    // la liste vient des critères actifs de la console, la même pour la semaine et le mois, et n'est pas propre au foyer
    const inserted = await db.insertInto("grocery_additive_criteria").values([{ label: "E999 essai", reason: "raison d'essai" }, { label: "E998 retiré", reason: "retiré", is_active: false }]).returning(["id", "label"]).execute();
    try {
      const real = await prepareList(at(), f.sophie, W0);
      expect(real.criteria.map((k) => k.label)).toContain("E999 essai");
      expect(real.criteria.map((k) => k.label)).not.toContain("E998 retiré");
      expect(JSON.stringify(real.criteria)).not.toMatch(/Lidl|Leclerc|Pâtes|Riz/);
      const month = await prepareList(at(), f.sophie, null, [W0, W1]);
      expect(month.group).not.toBeNull();
      expect(month.criteria).toEqual(real.criteria);
      const monthHtml = html(month);
      expect(monthHtml).toContain(TITLE);
      expect(monthHtml).toContain("E999 essai — raison d&#x27;essai");
      const [x, y, z] = order(monthHtml);
      expect(y).toBeGreaterThan(x);
      expect(z).toBeGreaterThan(y);
      expect(monthHtml).not.toContain("Aucun ingrédient exclu");
    } finally {
      await db.deleteFrom("grocery_additive_criteria").where("id", "in", inserted.map((r) => r.id)).execute();
    }
  });
});
