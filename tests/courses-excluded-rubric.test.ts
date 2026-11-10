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

/** US-157 RF1, CR-37 : la rubrique « Ingrédients exclus des références proposées » figure toujours dans la Liste de courses, d'une semaine comme d'une liste du mois, entre l'historique et le comparatif. */
const db = testDb();
const NOW = new Date(2026, 10, 4, 10, 0, 0);
const W0 = "2026-11-02";
const W1 = "2026-11-09";
const at = (): Ctx => ({ db, now: NOW });
const TITLE = "Ingrédients exclus des références proposées";

const html = (list: Awaited<ReturnType<typeof prepareList>>) => renderToStaticMarkup(createElement(ListFlow, { list, reload: () => {}, onWeek: () => {}, onGroup: () => {} }));
const order = (markup: string) => [markup.indexOf("Produits de mon historique"), markup.indexOf(TITLE), markup.indexOf("Comparatif des prix")];

describe("Rubrique « Ingrédients exclus des références proposées »", () => {
  it("présente dans la Liste de la semaine et dans la Liste du mois, vide ou non, entre « Produits de mon historique » et « Comparatif des prix »", async () => {
    await ensureCatalog(db);
    const f = await coupleFamily(db);
    const options = (await getSettings(at(), f.sophie)).options;
    await saveSettings(at(), f.sophie, { city: "Nantes", householdSize: 4, shoppingDays: [6], goals: { time: true }, cuisineIds: options.cuisines.map((c) => c.id), stores: [{ chain: "Lidl", city: "Nantes" }, { chain: "E.Leclerc", city: "Nantes" }] });
    await validateTestMenu(db, f, { picks: ["F4"], week: W0, now: NOW });
    await validateTestMenu(db, f, { picks: [], week: W1, now: NOW });

    // semaine, sans référence écartée : la rubrique est là, avec son texte
    const week = await prepareList(at(), f.sophie, W0);
    const emptyWeek = html({ ...week, excluded: [] });
    expect(emptyWeek).toContain(TITLE);
    expect(emptyWeek).toContain("Aucun ingrédient exclu pour ce menu.");
    const [a, b, c] = order(emptyWeek);
    expect(a).toBeGreaterThan(-1);
    expect(b).toBeGreaterThan(a);
    expect(c).toBeGreaterThan(b);

    // semaine, avec une référence écartée (additif d'un critère actif) et une sans référence conforme : listées
    const withExcluded = html({
      ...week,
      excluded: [
        { product: "Pâtes", store: "Lidl", reference: "Pâtes aux œufs", because: ["Dioxyde de titane"] },
        { product: "Riz", store: "E.Leclerc", reference: "Riz express", because: [] },
      ],
    });
    expect(withExcluded).toContain("Pâtes aux œufs (Lidl) : contient Dioxyde de titane.");
    // sans référence conforme, c'est le nom du produit qui s'affiche (pas le tiret de la référence absente)
    expect(withExcluded).toContain("Riz (E.Leclerc) : aucune référence conforme trouvée pour le moment.");
    expect(withExcluded).not.toContain("Riz express");
    expect(withExcluded).not.toContain("Aucun ingrédient exclu");

    // liste du mois : la rubrique y est aussi
    const month = await prepareList(at(), f.sophie, null, [W0, W1]);
    expect(month.group).not.toBeNull();
    const monthHtml = html({ ...month, excluded: [] });
    expect(monthHtml).toContain(TITLE);
    expect(monthHtml).toContain("Aucun ingrédient exclu pour ces menus.");
    const [x, y, z] = order(monthHtml);
    expect(y).toBeGreaterThan(x);
    expect(z).toBeGreaterThan(y);
  });
});
