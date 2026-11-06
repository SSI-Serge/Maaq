import { describe, expect, it } from "vitest";
import type { Ctx } from "@/server/auth/service";
import { saveSettings } from "@/server/courses/household/settings";
import { menuPropose, menuStart, menuValidate, resolveWeek, weekLabel } from "@/server/courses/menu/service";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily, type CoupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";

const db = testDb();
// mercredi 4 novembre 2026 : le menu préparé est celui du lundi 9
const NOW = new Date(2026, 10, 4, 10, 0, 0);
const at = (): Ctx => ({ db, now: NOW });
const WEEK = "2026-11-09";
const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; status: number; message: string };
  }
  throw new Error("aucun refus");
};

async function ready(extra: { allergens?: string[]; diets?: string[]; size?: number } = {}): Promise<CoupleFamily> {
  await ensureCatalog(db);
  const f = await coupleFamily(db);
  const options = (await menuStartOptions(f)).cuisines;
  await saveSettings(at(), f.sophie, {
    city: "Nantes",
    householdSize: extra.size ?? 4,
    shoppingDays: [6],
    goals: { time: true },
    cuisineIds: options.map((c) => c.id),
    allergens: extra.allergens,
    diets: extra.diets,
  });
  return f;
}
async function menuStartOptions(f: CoupleFamily) {
  const { getSettings } = await import("@/server/courses/household/settings");
  return (await getSettings(at(), f.sophie)).options;
}

describe("US-155/156 : menu de la semaine", () => {
  it("la semaine préparée est le lundi qui vient ; un autre lundi proche est accepté, pas un mardi", async () => {
    expect(resolveWeek(undefined, NOW)).toBe(WEEK);
    expect(resolveWeek("2026-11-02", NOW)).toBe("2026-11-02");
    expect(resolveWeek("2026-11-23", NOW)).toBe("2026-11-23");
    expect((await rejection(Promise.resolve().then(() => resolveWeek("2026-11-10", NOW)))).code).toBe("invalid_week");
    expect((await rejection(Promise.resolve().then(() => resolveWeek("2026-12-14", NOW)))).code).toBe("invalid_week");
    expect(weekLabel(WEEK)).toBe("9 novembre");
    expect(weekLabel("2026-12-01")).toBe("1er décembre");
  });

  it("étape 1 : les plats du catalogue regroupés par cuisine ; réglages manquants signalés ; invité secondaire refusé", async () => {
    await ensureCatalog(db);
    const f = await coupleFamily(db);
    expect((await menuStart(at(), f.sophie)).missing.length).toBeGreaterThan(0);
    expect((await rejection(menuStart(at(), f.elodie))).status).toBe(403);
    const g = await ready();
    const start = await menuStart(at(), g.sophie);
    expect(start.week).toBe(WEEK);
    expect(start.missing).toEqual([]);
    expect(start.maxPicks).toBe(2);
    expect(start.groups.map((x) => x.name)).toEqual(expect.arrayContaining(["Français", "Afro", "Italien"]));
    expect(start.groups.reduce((n, x) => n + x.dishes.length, 0)).toBe(60);
    expect(start.validated).toBeNull();
  });

  it("étape 2 : 7 dîners, 4 plats express de 15 minutes au plus, jusqu'à 4 remplaçants, séance du dimanche", async () => {
    const f = await ready();
    const lasagnes = (await menuStart(at(), f.sophie)).groups.flatMap((x) => x.dishes).find((d) => d.id === "F4")!;
    const menu = await menuPropose(at(), f.sophie, { picks: [lasagnes.id] });
    expect(menu.week).toBe(WEEK);
    expect(menu.days.map((d) => d.day)).toEqual(["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi", "Samedi", "Dimanche"]);
    expect(menu.days.map((d) => d.dish.id)).toContain(lasagnes.id);
    expect(new Set(menu.days.map((d) => d.dish.id)).size).toBe(7);
    for (const d of menu.days) expect(d.alternatives.length).toBeLessThanOrEqual(4);
    expect(menu.express.length).toBeLessThanOrEqual(4);
    for (const e of menu.express) expect(e.minutes).toBeLessThanOrEqual(15);
    expect(menu.days.slice(5).every((d) => !d.inSession)).toBe(true);
    expect(menu.session.minutes).toBeGreaterThan(0);
    expect(menu.session.label).toMatch(/^(environ )?(\d+ min|\d+ h \d\d)$/);
    expect(menu.servingsNote).toBeNull();
  });

  it("un foyer de 6 voit le multiplicateur des recettes", async () => {
    const f = await ready({ size: 6 });
    const dish = (await menuStart(at(), f.sophie)).groups[0].dishes[0];
    expect((await menuPropose(at(), f.sophie, { picks: [dish.id] })).servingsNote).toBe("Recettes pour 4 : multipliez par 1,5");
  });

  it("les allergènes et les régimes du foyer écartent les plats concernés", async () => {
    const f = await ready({ allergens: ["Arachide"], diets: ["Végétarien"] });
    const start = await menuStart(at(), f.sophie);
    const all = start.groups.flatMap((x) => x.dishes);
    expect(all.length).toBeLessThan(60);
    const veggie = all.find((d) => d.id === "F19")!;
    const menu = await menuPropose(at(), f.sophie, { picks: [veggie.id] });
    const names = [...menu.days.map((d) => d.dish.name), ...menu.days.flatMap((d) => d.alternatives.map((a) => a.name)), ...menu.express.map((e) => e.name)];
    expect(names.some((n) => /arachide|mafé|poulet/i.test(n))).toBe(false);
  });

  it("de 1 à 2 plats, existants, sans doublon", async () => {
    const f = await ready();
    const [a, b, c] = (await menuStart(at(), f.sophie)).groups[0].dishes;
    expect((await rejection(menuPropose(at(), f.sophie, { picks: [] }))).code).toBe("invalid_picks");
    expect((await rejection(menuPropose(at(), f.sophie, { picks: [a.id, b.id, c.id] }))).code).toBe("invalid_picks");
    expect((await rejection(menuPropose(at(), f.sophie, { picks: [a.id, a.id] }))).code).toBe("invalid_picks");
    expect((await rejection(menuPropose(at(), f.sophie, { picks: ["ZZ99"] }))).code).toBe("dish_not_found");
  });

  it("réglages manquants : la proposition est refusée avec la liste de ce qui manque", async () => {
    await ensureCatalog(db);
    const f = await coupleFamily(db);
    const e = await rejection(menuPropose(at(), f.sophie, { picks: ["F4"] }));
    expect(e.code).toBe("settings_missing");
  });

  it("valider enregistre le menu (plaisir, dîners, express) ; une nouvelle validation remplace l'ancienne ; l'historique éloigne les plats servis", async () => {
    const f = await ready();
    const pick = (await menuStart(at(), f.sophie)).groups.flatMap((x) => x.dishes).find((d) => d.id === "F4")!;
    const menu = await menuPropose(at(), f.sophie, { picks: [pick.id] });
    const dinners = menu.days.map((d) => d.dish.id);
    // le mardi est remplacé par son premier remplaçant
    dinners[1] = menu.days[1].alternatives[0].id;
    const done = await menuValidate(at(), f.sophie, { picks: [pick.id], dinners, express: menu.express.map((e) => e.id) });
    expect(done.week).toBe(WEEK);
    const menus = await db.selectFrom("meal_menus").selectAll().where("account_id", "=", f.accountId).execute();
    expect(menus).toHaveLength(1);
    expect(menus[0].session_minutes).toBe(done.sessionMinutes);
    expect(menus[0].validated_by_user_id).toBe(f.userIds.sophie);
    const entries = await db.selectFrom("meal_menu_entries").select(["kind", "slot", "dish_name", "is_off_batch"]).where("menu_id", "=", menus[0].id).orderBy("kind").orderBy("slot").execute();
    expect(entries.filter((e) => e.kind === "dinner")).toHaveLength(7);
    expect(entries.filter((e) => e.kind === "pleasure").map((e) => e.dish_name)).toEqual(["Lasagnes aux légumes du soleil"]);
    expect(entries.filter((e) => e.kind === "express")).toHaveLength(menu.express.length);
    const dinnerEntries = entries.filter((e) => e.kind === "dinner");
    expect(dinnerEntries[1].is_off_batch).toBe(true);
    expect(dinnerEntries[5].is_off_batch).toBe(true);
    expect((await menuStart(at(), f.sophie)).validated).not.toBeNull();

    // nouvelle validation de la même semaine : remplacée, pas ajoutée
    await menuValidate(at(), f.sophie, { picks: [pick.id], dinners: menu.days.map((d) => d.dish.id), express: [] });
    expect(await db.selectFrom("meal_menus").select("id").where("account_id", "=", f.accountId).execute()).toHaveLength(1);
    expect(await db.selectFrom("meal_menu_entries").select("id").where("account_id", "=", f.accountId).execute()).toHaveLength(1 + 7);

    // la semaine suivante, les plats servis ne reviennent pas avant 2 semaines (réglage par défaut)
    const next = await menuPropose(at(), f.sophie, { picks: [(await menuStart(at(), f.sophie)).groups.flatMap((x) => x.dishes).find((d) => d.id === "F19")!.id], week: "2026-11-16" });
    const served = new Set(menu.days.map((d) => d.dish.id));
    expect(next.days.filter((d) => served.has(d.dish.id))).toEqual([]);
  });

  it("refuse un menu qui ne compte pas 7 dîners, des plats inconnus, et un invité secondaire", async () => {
    const f = await ready();
    const pick = (await menuStart(at(), f.sophie)).groups[0].dishes[0];
    const menu = await menuPropose(at(), f.sophie, { picks: [pick.id] });
    const dinners = menu.days.map((d) => d.dish.id);
    expect((await rejection(menuValidate(at(), f.sophie, { picks: [pick.id], dinners: dinners.slice(0, 6), express: [] }))).code).toBe("invalid_menu");
    expect((await rejection(menuValidate(at(), f.sophie, { picks: [pick.id], dinners: [...dinners.slice(0, 6), "ZZ99"], express: [] }))).code).toBe("dish_not_found");
    expect((await rejection(menuValidate(at(), f.elodie, { picks: [pick.id], dinners, express: [] }))).status).toBe(403);
    expect(await db.selectFrom("meal_menus").select("id").where("account_id", "=", f.accountId).execute()).toHaveLength(0);
  });
});
