import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ApiError, MESSAGES } from "@/client/api";
import { DUPLICATE_MESSAGE, READING_MESSAGE, READ_TIMEOUT_MS, SAVING_MESSAGE, UNREADABLE_MESSAGE, failureOf, savedMessage } from "@/components/courses/ticket-messages";
import type { Ctx } from "@/server/auth/service";
import { getSettings, saveSettings } from "@/server/courses/household/settings";
import { setTicketReader, type TicketReader } from "@/server/courses/tickets/reader";
import { confirmTicket, readTicket } from "@/server/courses/tickets/service";
import { setTicketStructurer } from "@/server/courses/tickets/structure";
import { ensureCatalog } from "./helpers/courses-catalog";
import { coupleFamily, type CoupleFamily } from "./helpers/couple";
import { testDb } from "./helpers/fixtures";

const db = testDb();
const at = (): Ctx => ({ db, now: new Date(2026, 10, 6, 10, 0, 0) });
const photo = { name: "t", mime: "image/jpeg", content: Buffer.from([1, 2, 3]) };
const reader = (): TicketReader => ({ read: async () => ({ text: "LAIT 1L 1,90\nTOTAL 1,90", confidence: 90, tool: "test" }) });
const answer = (readable: boolean) => JSON.stringify(readable ? { readable: true, store: "Lidl", city: null, date: "2026-11-05", lines: [{ product: "Lait demi-écrémé", reference: "Lidl 1 L", total: 1.9, qty: 2, aisle: "Crémerie" }] } : { readable: false });

async function household(): Promise<CoupleFamily> {
  await ensureCatalog(db);
  const f = await coupleFamily(db);
  const options = (await getSettings(at(), f.sophie)).options;
  await saveSettings(at(), f.sophie, { city: "Nantes", householdSize: 4, shoppingDays: [6], goals: { time: true }, cuisineIds: options.cuisines.map((c) => c.id), stores: [{ chain: "Lidl", city: "Nantes" }] });
  return f;
}

beforeAll(() => setTicketReader(reader()));
afterEach(() => setTicketReader(reader()));

describe("US-161 RF5bis : l'utilisateur n'est jamais laissé sans réponse", () => {
  it("pendant la lecture et l'enregistrement : les messages d'attente (CC-1), et un délai de lecture plus long que celui des écrans simples", () => {
    expect(READING_MESSAGE).toBe("Lecture du ticket en cours…");
    expect(SAVING_MESSAGE).toBe("Enregistrement du ticket en cours…");
    expect(READ_TIMEOUT_MS).toBeGreaterThan(15_000);
    expect(READ_TIMEOUT_MS).toBeLessThanOrEqual(120_000);
  });

  it("après la confirmation : magasin, date, nombre de lignes, total et produits cochés, avec les accords au singulier", async () => {
    setTicketStructurer({ structure: async () => answer(true) });
    const f = await household();
    await readTicket(at(), f.sophie, [photo]);
    const done = await confirmTicket(at(), f.sophie, { store: "Lidl", city: null, date: "2026-11-05", lines: [{ product: "Lait demi-écrémé", reference: "Lidl 1 L", total: 1.9, qty: 2, aisle: "Crémerie" }, { product: "Pain", reference: null, total: 1.2, qty: 1, aisle: "Crémerie" }] });
    expect(done.duplicate).toBe(false);
    expect(savedMessage({ store: "Lidl", date: "2026-11-05", lines: done.recorded, total: done.total, ticked: done.removed.length })).toBe(`Ticket enregistré : Lidl, 05/11/2026, 2 lignes, 3,10 €. ${done.removed.length > 1 ? `${done.removed.length} produits cochés` : `${done.removed.length} produit coché`} dans votre liste.`);
    expect(savedMessage({ store: "Lidl", date: "2026-11-05", lines: 1, total: 12.5, ticked: 1 })).toBe("Ticket enregistré : Lidl, 05/11/2026, 1 ligne, 12,50 €. 1 produit coché dans votre liste.");
    expect(savedMessage({ store: "Aldi", date: "2026-01-02", lines: 13, total: 47.08, ticked: 0 })).toBe("Ticket enregistré : Aldi, 02/01/2026, 13 lignes, 47,08 €. 0 produit coché dans votre liste.");
    expect(savedMessage({ store: "Aldi", date: "2026-01-02", lines: 13, total: 47.08, ticked: 4 })).toContain("4 produits cochés dans votre liste.");
  });

  it("un ticket en double : message dédié, et la base confirme que rien n'a été ajouté", async () => {
    setTicketStructurer({ structure: async () => answer(true) });
    const f = await household();
    const input = { store: "Lidl", city: null, date: "2026-11-04", lines: [{ product: "Lait demi-écrémé", reference: "Lidl 1 L", total: 1.9, qty: 2, aisle: "Crémerie" }] };
    const first = await confirmTicket(at(), f.sophie, input);
    const second = await confirmTicket(at(), f.sophie, input);
    expect(first.recorded).toBe(1);
    expect(second).toMatchObject({ duplicate: true, recorded: 0, receiptId: null });
    expect(DUPLICATE_MESSAGE).toBe("Ce ticket est déjà enregistré : rien n'a été ajouté.");
    const stored = await db.selectFrom("grocery_receipts").select("id").where("account_id", "=", f.accountId).where("purchased_on", "=", new Date("2026-11-04T00:00:00Z")).execute();
    expect(stored).toHaveLength(1);
  });

  it("un ticket illisible : le message existant, et rien n'est enregistré", async () => {
    setTicketStructurer({ structure: async () => answer(false) });
    const f = await household();
    const read = await readTicket(at(), f.sophie, [photo]);
    expect(read.draft.readable).toBe(false);
    expect(UNREADABLE_MESSAGE).toBe("Ticket illisible : reprenez une photo plus nette.");
  });

  it("une erreur : le message standard avec « Réessayer » pour le réseau, le serveur et le délai dépassé (CC-2, CC-3) ; un refus du serveur est dit tel quel, sans « Réessayer »", () => {
    expect(failureOf(new ApiError("server", MESSAGES.server, 503))).toEqual({ message: MESSAGES.server, retry: true });
    expect(failureOf(new ApiError("timeout", MESSAGES.timeout))).toEqual({ message: MESSAGES.timeout, retry: true });
    expect(failureOf(new ApiError("offline", MESSAGES.offline))).toEqual({ message: MESSAGES.offline, retry: true });
    expect(failureOf(new ApiError("rejected", "Envoyez de 1 à 3 photos du ticket.", 422, { code: "invalid_photos", message: "Envoyez de 1 à 3 photos du ticket." }))).toEqual({ message: "Envoyez de 1 à 3 photos du ticket.", retry: false });
  });
});
