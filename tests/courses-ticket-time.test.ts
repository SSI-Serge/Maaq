import { beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "@/server/auth/service";
import { getSettings, saveSettings } from "@/server/courses/household/settings";
import { confirmTicket } from "@/server/courses/tickets/service";
import { normalizeDraft, normalizeTime } from "@/server/courses/tickets/structure";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily, type CoupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";

const db = testDb();
const at = (): Ctx => ({ db, now: new Date(2026, 10, 6, 10, 0, 0) });
const line = { product: "Lait demi-écrémé", reference: "Lidl 1 L", total: 1.9, qty: 2, aisle: "Crémerie" };
const ticket = (over: Partial<Parameters<typeof confirmTicket>[2]> = {}) => ({ store: "Lidl", city: null, date: "2026-11-05", time: "17:08:23", lines: [line], ...over });

async function household(): Promise<CoupleFamily> {
  await ensureCatalog(db);
  const f = await coupleFamily(db);
  const options = (await getSettings(at(), f.sophie)).options;
  await saveSettings(at(), f.sophie, { city: "Nantes", householdSize: 4, shoppingDays: [6], goals: { time: true }, cuisineIds: options.cuisines.map((c) => c.id), stores: [{ chain: "Lidl", city: "Nantes" }] });
  return f;
}

beforeAll(async () => {
  await ensureCatalog(db);
});

describe("CR-41 : l'heure du ticket", () => {
  it("la mise en forme extrait l'heure (secondes à 00 si absentes) et laisse vide ce qui n'est pas une heure", () => {
    expect(normalizeTime("17:08:23")).toBe("17:08:23");
    expect(normalizeTime("17:08")).toBe("17:08:00");
    expect(normalizeTime("9h05")).toBe("09:05:00");
    expect(normalizeTime("25:00")).toBeNull();
    expect(normalizeTime("17:61")).toBeNull();
    expect(normalizeTime("midi")).toBeNull();
    expect(normalizeTime(null)).toBeNull();
    const base = { readable: true, store: "Lidl", date: "2026-11-05", lines: [{ product: "Lait", total: 1.9, qty: 2, aisle: "Crémerie" }] };
    expect(normalizeDraft(JSON.stringify({ ...base, time: "17:08:23" }), ["Crémerie"], "2026-11-06").time).toBe("17:08:23");
    expect(normalizeDraft(JSON.stringify({ ...base, time: null }), ["Crémerie"], "2026-11-06").time).toBeNull();
    expect(normalizeDraft(JSON.stringify(base), ["Crémerie"], "2026-11-06").time).toBeNull();
  });

  it("même date, même heure et même total : rejeté en entier, même dans un autre magasin ; même total à une autre heure : accepté (CA 5.3)", async () => {
    const f = await household();
    const first = await confirmTicket(at(), f.sophie, ticket());
    expect(first).toMatchObject({ duplicate: false, recorded: 1 });
    const same = await confirmTicket(at(), f.sophie, ticket({ store: "Carrefour" }));
    expect(same).toMatchObject({ duplicate: true, recorded: 0, receiptId: null });
    const other = await confirmTicket(at(), f.sophie, ticket({ time: "17:09:23" }));
    expect(other).toMatchObject({ duplicate: false, recorded: 1 });
    const stored = await db.selectFrom("grocery_receipts").select(["purchased_time", "store_chain"]).where("account_id", "=", f.accountId).orderBy("purchased_time").execute();
    expect(stored.map((s) => s.purchased_time)).toEqual(["17:08:23", "17:09:23"]);
    expect(stored.every((s) => s.store_chain === "lidl")).toBe(true);
  });

  it("une heure sans secondes est enregistrée avec des secondes à 00 ; une heure invalide est refusée", async () => {
    const f = await household();
    await confirmTicket(at(), f.sophie, ticket({ time: "08:30" }));
    const stored = await db.selectFrom("grocery_receipts").select("purchased_time").where("account_id", "=", f.accountId).executeTakeFirstOrThrow();
    expect(stored.purchased_time).toBe("08:30:00");
    await expect(confirmTicket(at(), f.sophie, ticket({ time: "99:99" }))).rejects.toMatchObject({ code: "invalid_time", status: 422 });
  });

  it("sans heure, le contrôle reste sur le magasin, la date et le total ; un ticket sans heure n'est jamais bloqué par un ticket avec heure", async () => {
    const f = await household();
    expect(await confirmTicket(at(), f.sophie, ticket({ time: null }))).toMatchObject({ duplicate: false });
    expect(await confirmTicket(at(), f.sophie, ticket({ time: null }))).toMatchObject({ duplicate: true });
    expect(await confirmTicket(at(), f.sophie, ticket({ time: null, store: "Carrefour" }))).toMatchObject({ duplicate: false });
    // un ticket avec heure ne bloque pas un ancien ticket sans heure, et inversement (décision BA H161)
    expect(await confirmTicket(at(), f.sophie, ticket({ time: "12:00:00" }))).toMatchObject({ duplicate: false });
    expect(await confirmTicket(at(), f.sophie, ticket({ time: null, store: "Aldi", date: "2026-11-04" }))).toMatchObject({ duplicate: false });
    expect(await confirmTicket(at(), f.sophie, ticket({ time: "12:00:00", store: "Aldi", date: "2026-11-04" }))).toMatchObject({ duplicate: false });
  });

  it("la base garantit le contrôle : deux tickets identiques avec heure, ou deux identiques sans heure, sont refusés par un index unique", async () => {
    const f = await household();
    const row = (over: Record<string, unknown>) => ({ account_id: f.accountId, store_chain: "lidl", purchased_on: "2026-11-03" as never, total_amount: "5.00", recorded_by_user_id: f.sophie.user.id, ...over });
    await db.insertInto("grocery_receipts").values(row({ purchased_time: "10:00:00" })).execute();
    await expect(db.insertInto("grocery_receipts").values(row({ purchased_time: "10:00:00", store_chain: "aldi" })).execute()).rejects.toMatchObject({ code: "23505" });
    await db.insertInto("grocery_receipts").values(row({ purchased_time: null })).execute();
    await expect(db.insertInto("grocery_receipts").values(row({ purchased_time: null })).execute()).rejects.toMatchObject({ code: "23505" });
    await expect(db.insertInto("grocery_receipts").values(row({ purchased_time: null, store_chain: "aldi" })).execute()).resolves.toBeDefined();
  });
});
