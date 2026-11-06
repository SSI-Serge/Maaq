import { describe, expect, it } from "vitest";
import {
  allowed,
  deriveDishTags,
  dishMinutes,
  fmtMin,
  has,
  inSeason,
  linkPlans,
  Matcher,
  nextMonday,
  norm,
  proposeMenu,
  pyRound,
  tokens,
  type Dish,
  type Plan,
  type Profile,
} from "@/server/courses/engine";

function dish(id: string, cuisine: string, name: string, ing: string, minutes: number, extra: Partial<Dish> = {}): Dish {
  return { id, cuisine, name, ing, recipe: "", health: "", batch: "", time: `${minutes} min`, minutes, tags: deriveDishTags(name, ing), ...extra };
}

const CATALOG: Dish[] = [
  dish("F1", "Français", "Poulet rôti", "poulet, pommes de terre, thym", 90),
  dish("F2", "Français", "Gratin de courgettes", "courgettes, fromage rape, creme", 50),
  dish("F3", "Français", "Quiche lorraine", "lardons, oeufs, creme, pate brisee", 55),
  dish("F4", "Français", "Soupe de potiron", "potiron, creme, oignon", 30),
  dish("F5", "Français", "Blanquette de veau", "veau, carottes, champignons, creme", 100),
  dish("F6", "Français", "Salade niçoise", "thon, oeufs, tomates, haricots verts", 15),
  dish("F7", "Français", "Omelette aux champignons", "oeufs, champignons, beurre", 10),
  dish("F8", "Français", "Croque monsieur", "pain, jambon, fromage", 15),
  dish("F9", "Français", "Salade de chèvre chaud", "chevre, pain, salade verte", 15),
  dish("F10", "Français", "Pâtes carbonara", "pates, lardons, oeufs, creme", 20),
  dish("A1", "Afro", "Mafé", "boeuf, arachide, tomates, riz", 90),
];

const PROFILE: Profile = { objectives: "", repetitionWeeks: 2, preferredCuisines: [], replacementSource: [], batchMaxMinutes: 120, allergies: [], regimes: [] };
const PLAN: Plan = { id: "AS1", cuisine: "Français", theme: "Classiques", days: ["Poulet roti", "Gratin de courgettes", "Quiche lorraine", "Soupe de potiron", "Blanquette de veau"], ids: [], steps: ["Cuire"], total: 110, pct: 40 };
const TODAY = new Date(2026, 10, 5);

function menu(over: Partial<Parameters<typeof proposeMenu>[0]> = {}) {
  return proposeMenu({ dishes: CATALOG, plans: [PLAN], profile: PROFILE, picks: ["F1"], week: "2026-11-09", history: [], today: TODAY, ...over });
}

describe("Moteur Courses et repas : outils de texte", () => {
  it("norm retire les accents et les œ", () => {
    expect(norm("Bœuf Sauté À la Crème")).toBe("boeuf saute a la creme");
  });

  it("has cherche un mot entier, au pluriel éventuel", () => {
    expect(has("pate", "des pates fraiches")).toBe(true);
    expect(has("pate", "une pateuse")).toBe(false);
    expect(has("pomme", "compote de pommes")).toBe(true);
    expect(has("pomme", "ananas")).toBe(false);
  });

  it("pyRound arrondit à l'entier pair comme Python", () => {
    expect([0.5, 1.5, 2.5, 3.5, 2.4, 2.6].map(pyRound)).toEqual([0, 2, 2, 4, 2, 3]);
  });

  it("durées : « 1 h 30 », « 45 min », 60 par défaut", () => {
    expect(dishMinutes("1 h 30")).toBe(90);
    expect(dishMinutes("45 min")).toBe(45);
    expect(dishMinutes("voir séance")).toBe(60);
    expect(fmtMin(125)).toBe("2 h 05");
    expect(fmtMin(45)).toBe("45 min");
  });

  it("tokens ignore les mots courts et les mots vides", () => {
    expect([...tokens("poulet, sel, huile d'olive (bio), pommes de terre")].sort()).toEqual(["d'olive", "pommes", "poulet", "terre"]);
  });

  it("saison : décembre à février ou septembre à décembre", () => {
    expect(inSeason("courge, tomate", 11)).toEqual({ inSeason: 1, outOfSeason: 1 });
    expect(inSeason("chou", 1)).toEqual({ inSeason: 1, outOfSeason: 0 });
    expect(inSeason("chou", 7)).toEqual({ inSeason: 0, outOfSeason: 1 });
  });

  it("étiquettes déduites : viande, végétarien, sans gluten, salade", () => {
    expect([...deriveDishTags("Salade niçoise", "thon, oeufs")].sort()).toEqual(["poisson", "salade", "sans gluten"]);
    expect([...deriveDishTags("Pâtes carbonara", "pates, lardons")].sort()).toEqual(["porc"]);
    expect([...deriveDishTags("Omelette", "oeufs, beurre")].sort()).toEqual(["sans gluten", "vegetarien"]);
  });

  it("filtrage indicatif : allergie, régime végétarien, sans gluten, viande demandée", () => {
    const carbonara = CATALOG.find((d) => d.id === "F10")!;
    const omelette = CATALOG.find((d) => d.id === "F7")!;
    expect(allowed(carbonara, { allergies: ["oeufs"], regimes: [] })).toBe(false);
    expect(allowed(carbonara, { allergies: [], regimes: ["Végétarien"] })).toBe(false);
    expect(allowed(omelette, { allergies: [], regimes: ["végétarien", "sans gluten"] })).toBe(true);
    expect(allowed(carbonara, { allergies: [], regimes: ["sans gluten"] })).toBe(false);
    expect(allowed(omelette, { allergies: [], regimes: [] }, "poulet")).toBe(false);
  });
});

describe("Moteur Courses et repas : rapprochement des semaines types", () => {
  it("un mot seul en commun ne suffit pas ; un nom identique est sûr", () => {
    const m = new Matcher([{ id: "F1", name: "Velouté de carottes" }, { id: "F2", name: "Velouté de courge" }]);
    expect(m.score("Velouté de potiron", "F1")).toBe(0);
    expect(m.score("Velouté de courge", "F2")).toBe(1);
    expect(m.top("Velouté de courge", 2).map((x) => x.id)).toEqual(["F2", "F1"]);
  });

  it("seuils : 80 % sûr, 40 % à confirmer, en dessous absent", () => {
    const m = new Matcher([{ id: "F1", name: "Poulet rôti" }]);
    expect([0.8, 0.79, 0.4, 0.39].map((s) => m.status(s))).toEqual(["ok", "confirmer", "confirmer", "absent"]);
    expect(new Matcher([{ id: "F1", name: "Poulet rôti" }], { sure: 0.9, confirm: 0.5 }).status(0.85)).toBe("confirmer");
  });

  it("un identifiant du catalogue vaut 100 % ; un plat sans équivalent est absent", () => {
    const plan: Plan = { ...PLAN, days: ["Quelque chose", "Gratin de courgettes", "Quiche lorraine", "Soupe de potiron", "Soufflé au Grand Marnier"], ids: ["F1"] };
    const [linked] = linkPlans([plan], CATALOG);
    expect(linked.match[0]).toEqual(["F1", "ok", 1, "F1"]);
    expect(linked.match[1][1]).toBe("ok");
    expect(linked.match[4][1]).toBe("absent");
  });
});

describe("Moteur Courses et repas : menu de la semaine", () => {
  it("s'appuie sur la semaine type qui contient le plat choisi : 7 dîners, séance de batch connue", () => {
    const m = menu();
    expect(m.batch.source).toBe("planning");
    expect(m.batch.id).toBe("AS1");
    expect(m.batch.total).toBe(110);
    expect(m.menu).toHaveLength(7);
    expect(m.menu.slice(0, 5).map((e) => e.id)).toEqual(["F1", "F2", "F3", "F4", "F5"]);
    expect(m.menu.slice(0, 5).every((e) => e.batch)).toBe(true);
    expect(m.menu.slice(5).every((e) => !e.batch)).toBe(true);
    expect(m.menu.map((e) => e.day)).toEqual(["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"]);
  });

  it("plats express : 15 minutes au plus, hors du menu ; moins de 4 disponibles = signalé", () => {
    const m = menu();
    const byId = new Map(CATALOG.map((d) => [d.id, d]));
    expect(m.express.length).toBeLessThan(4);
    expect(m.expressShort).toBe(true);
    for (const id of m.express) {
      expect(byId.get(id)!.minutes).toBeLessThanOrEqual(15);
      expect(m.menu.some((e) => e.id === id)).toBe(false);
    }
  });

  it("n'utilise que les cuisines choisies, pour les plats comme pour les express et les remplacements", () => {
    const m = menu({ profile: { ...PROFILE, preferredCuisines: ["Français"] } });
    const byId = new Map(CATALOG.map((d) => [d.id, d]));
    const all = [...m.menu.map((e) => e.id), ...m.express, ...m.menu.flatMap((e) => e.alts)];
    expect(all.every((id) => byId.get(id)!.cuisine === "Français")).toBe(true);
  });

  it("un plat servi dans les semaines de répétition n'est pas reproposé : la semaine type qui le contient est écartée", () => {
    const m = menu({ history: [{ week: "2026-11-02", dishName: "Soupe de potiron" }] });
    expect(m.batch.source).toBe("estimation");
    expect(m.menu.some((e) => e.id === "F4")).toBe(false);
  });

  it("un plat servi il y a plus longtemps que la répétition peut revenir", () => {
    const m = menu({ history: [{ week: "2026-09-28", dishName: "Soupe de potiron" }] });
    expect(m.batch.source).toBe("planning");
  });

  it("une allergie écarte les plats concernés (filtrage fait par MAAQ)", () => {
    const m = menu({ profile: { ...PROFILE, allergies: ["creme"] } });
    const withCream = new Set(["F2", "F3", "F4", "F5", "F10"]);
    expect(m.batch.source).toBe("estimation");
    expect(m.menu.some((e) => withCream.has(e.id))).toBe(false);
  });

  it("sans semaine type : durée estimée = le plat le plus long + 40 % des autres", () => {
    const m = menu({ plans: [], profile: { ...PROFILE, objectives: "temps" } });
    expect(m.batch).toMatchObject({ source: "estimation", total: 112, cap: 120 });
    expect(m.menu[0].id).toBe("F1");
    expect(m.menu.map((e) => e.id)).toEqual(["F1", "F7", "F6", "F8", "F9", "F10", "F4"]);
  });

  it("objectif « temps » : une semaine type au-dessus du plafond n'est pas retenue", () => {
    const m = menu({ profile: { ...PROFILE, objectives: "temps", batchMaxMinutes: 100 } });
    expect(m.batch.source).toBe("estimation");
  });

  it("une semaine type avec un plat absent du catalogue est écartée et comptée", () => {
    const blocked: Plan = { ...PLAN, id: "AS2", days: ["Poulet roti", "Gratin de courgettes", "Quiche lorraine", "Soupe de potiron", "Soufflé au Grand Marnier"] };
    const m = menu({ plans: [blocked, PLAN] });
    expect(m.batch.id).toBe("AS1");
    expect(m.blockedPlans).toBe(1);
  });

  it("plat de planning remplacé par un plat proche du catalogue : signalé à confirmer", () => {
    const close: Plan = { ...PLAN, id: "AS3", days: ["Poulet roti", "Gratin de courgettes", "Quiche lorraine", "Soupe de potiron", "Blanquette de veau a l'ancienne"] };
    const m = menu({ plans: [close] });
    expect(m.batch.id).toBe("AS3");
    expect(m.batch.confirm).toBe(1);
    const entry = m.menu.find((e) => e.id === "F5")!;
    expect(entry.confirm).toBe("Blanquette de veau a l'ancienne");
  });

  it("les remplacements : 4 au plus par plat, jamais le plat lui-même ni un plat du menu", () => {
    const m = menu();
    for (const e of m.menu) {
      expect(e.alts.length).toBeLessThanOrEqual(4);
      expect(e.alts).not.toContain(e.id);
      for (const a of e.alts) expect(m.menu.some((x) => x.id === a)).toBe(false);
    }
  });

  it("plat introuvable : erreur claire", () => {
    expect(() => menu({ picks: ["Z99"] })).toThrow("picks_not_found");
  });

  it("le lundi suivant n'est jamais aujourd'hui", () => {
    expect(nextMonday(new Date(2026, 10, 5))).toBe("2026-11-09");
    expect(nextMonday(new Date(2026, 10, 9))).toBe("2026-11-16");
    expect(nextMonday(new Date(2026, 10, 8))).toBe("2026-11-09");
  });
});
