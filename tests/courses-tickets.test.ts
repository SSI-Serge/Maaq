import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "@/server/auth/service";
import { budgetView } from "@/server/courses/budget";
import { getSettings, saveSettings, setSharing } from "@/server/courses/household/settings";
import { myList } from "@/server/courses/list/mine";
import { validateList } from "@/server/courses/list/service";
import { menuPropose, menuStart, menuValidate } from "@/server/courses/menu/service";
import { setTicketReader, TicketReaderError, type TicketReader } from "@/server/courses/tickets/reader";
import { confirmTicket, menuFromTicket, readTicket } from "@/server/courses/tickets/service";
import { normalizeDraft, setTicketStructurer } from "@/server/courses/tickets/structure";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily, type CoupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";

const db = testDb();
const NOW = new Date(2026, 10, 6, 10, 0, 0);
const at = (): Ctx => ({ db, now: NOW });
type Failure = { code: string; status: number; message: string };
const rejection = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as Failure;
  }
  throw new Error("aucun refus");
};

/** Texte entièrement fictif, avec ce que le masquage doit retirer. */
const TEXT = ["SUPERMARCHE EXEMPLE", "Bonjour Camille", "Caissière : Sophie", "LAIT DEMI-ECREME 1L  2 x 0,95  1,90", "POULET FERMIER 500G   6,49", "Carte de fidélité 2500123456789", "TOTAL 8,39"].join("\n");
const ANSWER = JSON.stringify({ readable: true, store: "Lidl", city: null, date: "2026-11-05", lines: [{ product: "Lait demi-écrémé", reference: "Lidl 1 L", total: 1.9, qty: 2, aisle: "Crémerie" }, { product: "Blanc de poulet", reference: "Fermier 500 g", total: 6.49, qty: 1, aisle: "Volaille" }] });

let received = "";
const reader = (text = TEXT): TicketReader => ({ read: async () => ({ text, confidence: 91, tool: "test" }) });
const photo = { name: "t", mime: "image/jpeg", content: Buffer.from([1, 2, 3]) };

async function household(): Promise<CoupleFamily> {
  await ensureCatalog(db);
  const f = await coupleFamily(db);
  const options = (await getSettings(at(), f.sophie)).options;
  await saveSettings(at(), f.sophie, { city: "Nantes", householdSize: 4, shoppingDays: [6], goals: { time: true }, cuisineIds: options.cuisines.map((c) => c.id), stores: [{ chain: "Lidl", city: "Nantes" }] });
  return f;
}

beforeAll(() => {
  setTicketReader(reader());
  setTicketStructurer({ structure: async ({ text }) => ((received = text), ANSWER) });
});
afterEach(() => {
  setTicketReader(reader());
  setTicketStructurer({ structure: async ({ text }) => ((received = text), ANSWER) });
});

describe("US-161 : lecture d'un ticket", () => {
  it("le modèle ne reçoit que le texte masqué ; la ville est reprise de l'enseigne du foyer ; rien n'est enregistré avant la confirmation", async () => {
    const f = await household();
    const read = await readTicket(at(), f.sophie, [photo]);
    expect(received).not.toMatch(/2500123456789|Camille|Sophie/);
    expect(received).toContain("LAIT DEMI-ECREME");
    expect(read.masked).toBeGreaterThanOrEqual(3);
    expect(read.draft).toMatchObject({ readable: true, store: "Lidl", city: "Nantes", date: "2026-11-05", dateGuessed: false });
    expect(read.draft.lines).toHaveLength(2);
    expect(read.total).toBe(8.39);
    expect(read.duplicate).toBe(false);
    expect(read.aisles).toContain("Crémerie");
    expect(await db.selectFrom("grocery_receipts").select("id").where("account_id", "=", f.accountId).execute()).toHaveLength(0);
  });

  it("un ticket illisible, un service indisponible, de mauvaises photos et l'invité secondaire sont refusés avec le bon message", async () => {
    const f = await household();
    setTicketReader(reader("   "));
    expect((await readTicket(at(), f.sophie, [photo])).draft.readable).toBe(false);
    setTicketReader({ read: async () => { throw new TicketReaderError("unreadable", "x"); } });
    expect((await readTicket(at(), f.sophie, [photo])).draft.readable).toBe(false);
    setTicketReader({ read: async () => { throw new TicketReaderError("unavailable", "x"); } });
    expect((await rejection(readTicket(at(), f.sophie, [photo]))).code).toBe("reader_unavailable");
    setTicketReader(null);
    expect((await rejection(readTicket(at(), f.sophie, [photo]))).status).toBe(503);
    setTicketReader(reader());
    expect((await rejection(readTicket(at(), f.sophie, []))).code).toBe("invalid_photos");
    expect((await rejection(readTicket(at(), f.sophie, [{ ...photo, mime: "application/pdf" }]))).code).toBe("invalid_photo_type");
    expect((await rejection(readTicket(at(), f.sophie, [{ ...photo, content: Buffer.alloc(11 * 1024 * 1024) }]))).code).toBe("photo_too_large");
    expect((await rejection(readTicket(at(), f.elodie, [photo]))).status).toBe(403);
  });

  it("la réponse du modèle est vérifiée ligne par ligne : rayon connu, montant plausible, date du jour si illisible", () => {
    const aisles = ["Crémerie", "Volaille", "Autres"];
    const draft = normalizeDraft(
      "Voici : " + JSON.stringify({ readable: true, store: "Lidl", date: "pas une date", lines: [{ product: "Lait", total: "1,90 €", qty: "2", aisle: "crèmerie" }, { product: "Truc", total: 5, aisle: "Rayon inventé" }, { product: "", total: 3 }, { product: "Sans prix", total: "abc" }, { product: "Remise", total: -0.5, aisle: "Autres" }] }) + " fin",
      aisles,
      "2026-11-06",
    );
    expect(draft).toMatchObject({ readable: true, store: "Lidl", date: "2026-11-06", dateGuessed: true });
    expect(draft.lines.map((l) => [l.product, l.total, l.qty, l.aisle])).toEqual([["Lait", 1.9, 2, "Crémerie"], ["Truc", 5, 1, "Autres"], ["Remise", -0.5, 1, "Autres"]]);
    expect(normalizeDraft("pas du JSON", aisles, "2026-11-06").readable).toBe(false);
    expect(normalizeDraft({ readable: false, lines: [{ product: "x", total: 1 }] }, aisles, "2026-11-06").lines).toEqual([]);
    expect(normalizeDraft({ store: "Lidl", date: "2027-01-01", lines: [{ product: "x", total: 1 }] }, aisles, "2026-11-06").dateGuessed).toBe(true);
  });
});

describe("US-161 RF5 : confirmation", () => {
  const lines = [{ product: "Lait demi-écrémé", reference: "Lidl 1 L", total: 1.9, qty: 2, aisle: "Crémerie" }, { product: "Blanc de poulet", reference: "Fermier 500 g", total: 6.49, qty: 1, aisle: "Volaille" }];

  it("enregistre le ticket, retire de la liste les produits trouvés, met le budget à jour ; un doublon n'est pas compté deux fois", async () => {
    const f = await household();
    // une liste validée avec du lait et des œufs
    const pick = (await menuStart(at(), f.sophie)).groups.flatMap((g) => g.dishes)[0];
    const menu = await menuPropose(at(), f.sophie, { picks: [pick.id] });
    await menuValidate(at(), f.sophie, { picks: [pick.id], dinners: menu.days.map((d) => d.dish.id), express: [] });
    await validateList(at(), f.sophie, {
      scenario: 1,
      lines: [
        { name: "Lait demi-écrémé", qty: 1, store: null, ref: null, price: null, source: "menu" as const },
        { name: "Piles AA", qty: 1, store: null, ref: null, price: null, source: "added" as const },
      ],
    });

    const done = await confirmTicket(at(), f.sophie, { store: "Lidl", city: "Nantes", date: "2026-11-05", lines });
    expect(done).toMatchObject({ duplicate: false, recorded: 2, total: 8.39 });
    expect(done.removed).toEqual(["Lait demi-écrémé"]);
    expect(done.aisles.sort()).toEqual(["Crémerie", "Volaille"]);
    const remaining = (await myList(at(), f.sophie)).stores.flatMap((s) => s.aisles.flatMap((a) => a.lines)).map((l) => l.name);
    expect(remaining).not.toContain("Lait demi-écrémé");
    expect(remaining).toContain("Piles AA");
    const budget = await budgetView({ db, now: new Date(2026, 11, 3) }, f.sophie);
    expect(budget.budget.rows.find((r) => r.rayon === "Crémerie")!.lastMonth).toBe(1.9);
    expect(budget.budget.total.lastMonth).toBe(8.39);
    const stored = await db.selectFrom("grocery_receipt_lines").select(["label", "quantity", "line_total"]).where("account_id", "=", f.accountId).orderBy("position").execute();
    expect(stored.map((l) => [l.label, Number(l.quantity), Number(l.line_total)])).toEqual([["Lait demi-écrémé", 2, 1.9], ["Blanc de poulet", 1, 6.49]]);

    const again = await confirmTicket(at(), f.sophie, { store: "LIDL", city: "Nantes", date: "2026-11-05", lines });
    expect(again).toMatchObject({ duplicate: true, recorded: 0 });
    expect(await db.selectFrom("grocery_receipts").select("id").where("account_id", "=", f.accountId).execute()).toHaveLength(1);
    expect((await readTicket(at(), f.sophie, [photo])).duplicate).toBe(true);
  });

  it("la base commune ne reçoit les prix, sans foyer, que si le foyer les partage ; un produit inconnu est noté sans foyer", async () => {
    const f = await household();
    const notShared = await confirmTicket(at(), f.sophie, { store: "Lidl", city: "Nantes", date: "2026-11-04", lines: [{ product: "Lait demi-écrémé", reference: "Lidl 1 L", total: 0.95, qty: 1, aisle: "Crémerie" }] });
    expect(notShared.shared).toBe(0);
    await setSharing(at(), f.sophie, true);
    const marker = `Produit rare ${Math.random().toString(36).slice(2, 8)}`;
    const shared = await confirmTicket(at(), f.sophie, { store: "Lidl", city: "Nantes", date: "2026-11-03", lines: [{ product: "Lait demi-écrémé", reference: "Lidl 1 L", total: 0.99, qty: 1, aisle: "Crémerie" }, { product: marker, reference: "Marque X", total: 4.5, qty: 1, aisle: "Autres" }] });
    expect(shared.shared).toBe(1);
    const price = await db.selectFrom("grocery_shared_prices").selectAll().where("unit_price", "=", "0.99").where("reference_name", "=", "lidl 1 l").executeTakeFirstOrThrow();
    expect(Object.keys(price).some((k) => /account|household|foyer/.test(k))).toBe(false);
    expect(new Date(price.week_start as Date).getDay()).toBe(1);
    const noted = await db.selectFrom("grocery_unreferenced_events").select(["name_key", "seen_city", "seen_unit_price"]).where("name_key", "=", marker.toLowerCase()).executeTakeFirstOrThrow();
    expect(noted.seen_city).toBe("nantes");
  });

  it("refuse un ticket incomplet ou invalide, et l'invité secondaire", async () => {
    const f = await household();
    const base = { store: "Lidl", city: null, date: "2026-11-05", lines };
    expect((await rejection(confirmTicket(at(), f.sophie, { ...base, store: " " }))).code).toBe("invalid_store");
    expect((await rejection(confirmTicket(at(), f.sophie, { ...base, date: "5 novembre" }))).code).toBe("invalid_date");
    expect((await rejection(confirmTicket(at(), f.sophie, { ...base, date: "2027-01-01" }))).code).toBe("invalid_date");
    expect((await rejection(confirmTicket(at(), f.sophie, { ...base, lines: [] }))).code).toBe("invalid_lines");
    expect((await rejection(confirmTicket(at(), f.sophie, { ...base, lines: [{ ...lines[0], total: 0 }] }))).code).toBe("invalid_line");
    expect((await rejection(confirmTicket(at(), f.sophie, { ...base, lines: [{ ...lines[0], aisle: "Rayon inventé" }] }))).code).toBe("invalid_line");
    expect((await rejection(confirmTicket(at(), f.elodie, base))).status).toBe(403);
    expect(await db.selectFrom("grocery_receipts").select("id").where("account_id", "=", f.accountId).execute()).toHaveLength(0);
  });
});

describe("US-160 : menu à partir d'un ticket", () => {
  it("propose des plats qui utilisent ce qui a été acheté, avec ce qui reste à acheter", async () => {
    const f = await household();
    const done = await confirmTicket(at(), f.sophie, {
      store: "Lidl",
      city: "Nantes",
      date: "2026-11-05",
      lines: [
        { product: "Poulet entier", reference: null, total: 7.5, qty: 1, aisle: "Volaille" },
        { product: "Poivrons", reference: null, total: 1.89, qty: 1, aisle: "Fruits et légumes" },
        { product: "Riz long", reference: null, total: 2.15, qty: 1, aisle: "Féculents" },
      ],
    });
    const ideas = await menuFromTicket(at(), f.sophie, done.receiptId!);
    expect(ideas.length).toBeGreaterThan(0);
    expect(ideas.length).toBeLessThanOrEqual(3);
    for (const idea of ideas) {
      expect(idea.have.length).toBeGreaterThan(0);
      expect(idea.have.length + idea.missing.length).toBeGreaterThanOrEqual(idea.have.length);
    }
    expect(ideas.some((i) => i.missing.length > 0)).toBe(true);
    expect((await rejection(menuFromTicket(at(), f.sophie, "00000000-0000-0000-0000-000000000000"))).code).toBe("not_found");
    expect((await rejection(menuFromTicket(at(), f.elodie, done.receiptId!))).status).toBe(403);
  });
});
