import { describe, expect, it } from "vitest";
import { getSettings, saveSettings, setSharing } from "@/server/courses/household/settings";
import type { Ctx } from "@/server/auth/service";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";

const db = testDb();
const at = (): Ctx => ({ db, now: new Date() });
const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { code: string; status: number; message: string };
  }
  throw new Error("aucun refus");
};

describe("US-153 : réglages du foyer", () => {
  it("le couple règle une fois les habitudes ; l'affichage remet villes et enseignes en forme", async () => {
    await ensureCatalog(db);
    const f = await coupleFamily(db);
    const before = await getSettings(at(), f.sophie);
    expect(before.missing).toEqual(["city", "householdSize", "shoppingDays", "cuisines", "goals"]);
    expect(before.sharePrices).toBe(false);
    expect(before.budgetDay).toBe(1);
    const cuisines = before.options.cuisines.map((c) => c.id);
    const saved = await saveSettings(at(), f.sophie, {
      city: "Nantes",
      householdSize: 4,
      shoppingDays: [6, 6, 2],
      goals: { time: true, season: true },
      repeatWeeks: 3,
      cuisineIds: cuisines.slice(0, 2),
      stores: [{ chain: "LIDL", city: "Rezé" }, { chain: "lidl", city: "rezé" }, { chain: "Intermarché", city: "Nantes" }],
      diets: ["Végétarien"],
      allergens: ["Arachide"],
      allergyText: "kiwi",
    });
    expect(saved.missing).toEqual([]);
    expect(saved.shoppingDays).toEqual([2, 6]);
    expect(saved.stores).toEqual([{ chain: "Lidl", city: "Rezé" }, { chain: "Intermarché", city: "Nantes" }]);
    expect(saved).toMatchObject({ city: "Nantes", householdSize: 4, repeatWeeks: 3, diets: ["Végétarien"], allergens: ["Arachide"], allergyText: "kiwi" });
    expect(saved.goals).toEqual({ time: true, ownDishes: false, season: true });
    // les réglages sont communs au couple
    expect((await getSettings(at(), f.marc)).city).toBe("Nantes");
  });

  it("régimes et allergies sont chiffrés en base", async () => {
    await ensureCatalog(db);
    const f = await coupleFamily(db);
    await saveSettings(at(), f.sophie, { city: "Lyon", allergyText: "kiwi très particulier", diets: ["Sans gluten"] });
    const row = await db.selectFrom("grocery_household_dietary").select(["diets_encrypted", "allergies_encrypted"]).where("account_id", "=", f.accountId).executeTakeFirstOrThrow();
    expect(row.allergies_encrypted!.toString("utf8")).not.toContain("kiwi");
    expect(row.diets_encrypted!.toString("utf8")).not.toContain("gluten");
  });

  it("un invité secondaire ne voit pas les réglages (CR-10) ; une adresse n'est pas une ville", async () => {
    await ensureCatalog(db);
    const f = await coupleFamily(db);
    expect((await rejection(getSettings(at(), f.elodie))).status).toBe(403);
    expect((await rejection(saveSettings(at(), f.elodie, { city: "Nantes" }))).status).toBe(403);
    expect((await rejection(saveSettings(at(), f.sophie, { city: "12 rue des Lilas" }))).code).toBe("invalid_city");
    expect((await rejection(saveSettings(at(), f.sophie, { householdSize: 13 }))).code).toBe("invalid_size");
    expect((await rejection(saveSettings(at(), f.sophie, { replacementSource: "cuisine" }))).code).toBe("cuisine_required");
  });
});

describe("US-154 : partage anonyme des prix", () => {
  it("désactivé par défaut ; il faut une ville ; la preuve de consentement précède le changement", async () => {
    await ensureCatalog(db);
    const f = await coupleFamily(db);
    expect((await rejection(setSharing(at(), f.sophie, true))).code).toBe("city_required");
    await saveSettings(at(), f.sophie, { city: "Angers" });
    const on = await setSharing(at(), f.sophie, true);
    expect(on.sharePrices).toBe(true);
    let events = await db.selectFrom("grocery_price_sharing_events").select(["action_type", "actor_user_id"]).where("account_id", "=", f.accountId).orderBy("id").execute();
    expect(events).toEqual([{ action_type: "granted", actor_user_id: f.userIds.sophie }]);
    const off = await setSharing(at(), f.marc, false);
    expect(off.sharePrices).toBe(false);
    events = await db.selectFrom("grocery_price_sharing_events").select(["action_type", "actor_user_id"]).where("account_id", "=", f.accountId).orderBy("id").execute();
    expect(events.map((e) => e.action_type)).toEqual(["granted", "withdrawn"]);
    // sans changement, pas de nouvelle preuve
    await setSharing(at(), f.marc, false);
    expect((await db.selectFrom("grocery_price_sharing_events").select("id").where("account_id", "=", f.accountId).execute()).length).toBe(2);
  });

  it("la preuve garde la version du texte accepté, sans nom ni adresse", async () => {
    await ensureCatalog(db);
    const f = await coupleFamily(db);
    await saveSettings(at(), f.sophie, { city: "Brest" });
    await setSharing(at(), f.sophie, true);
    const e = await db.selectFrom("grocery_price_sharing_events").selectAll().where("account_id", "=", f.accountId).executeTakeFirstOrThrow();
    const v = await db.selectFrom("legal_document_versions").select(["document_type", "content"]).where("id", "=", e.legal_version_id).executeTakeFirstOrThrow();
    expect(v.document_type).toBe("grocery_price_sharing_consent");
    expect(v.content).toContain("sans votre nom");
    expect(Buffer.isBuffer(e.actor_email_hash)).toBe(true);
  });

  it("le compteur des foyers par ville suit le partage ; un invité secondaire ne peut pas le changer", async () => {
    await ensureCatalog(db);
    const a = await coupleFamily(db);
    const b = await coupleFamily(db);
    const city = `Ville-${Date.now()}`;
    for (const f of [a, b]) {
      await saveSettings(at(), f.sophie, { city });
      await setSharing(at(), f.sophie, true);
    }
    const key = city.toLowerCase();
    const count = async () => (await db.selectFrom("grocery_city_sharing").select("household_count").where("city_key", "=", key).executeTakeFirst())?.household_count;
    expect(await count()).toBe(2);
    await setSharing(at(), b.sophie, false);
    expect(await count()).toBe(2); // un foyer ne sort du compteur qu'à sa suppression (CR-22)
    expect((await rejection(setSharing(at(), a.elodie, true))).status).toBe(403);
  });
});
