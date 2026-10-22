import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getStorefrontDetail, listStorefronts, marketplaceCounters, remapCategory, reviewReport, setAdminPause } from "@/server/admin/storefronts";
import { coupDeMainBrain } from "@/server/agents/coup-de-main";
import type { AgentTurnInput, LlmClient, LlmMessage } from "@/server/agents/types";
import type { DB } from "@/server/db/schema.generated";
import { DbStorefrontStore } from "@/server/marketplace/db-store";
import { DbMatchStore } from "@/server/marketplace/match-db-store";
import { MemoryMatchStore } from "@/server/marketplace/match-store";
import { matchRequest, type RelevanceOutput } from "@/server/marketplace/matching";
import type { StorefrontFields } from "@/server/marketplace/model";
import { MemoryStorefrontStore, type StorefrontStore } from "@/server/marketplace/store";
import { fakeLlm } from "./helpers/fake-llm";
import { createProfile, testDb } from "./helpers/fixtures";

const NOW = new Date("2026-10-22T09:00:00Z");

async function publish(store: StorefrontStore, userId: string, fields: Partial<StorefrontFields> = {}) {
  const groups = ["displayName", "category", "services", "description", "area", "availability", "price", "languages", "notice", "qualifications", "contact"];
  await store.save(userId, { displayName: "Sarah Tresses", categoryCode: "coiffure", services: ["tresses"], description: "Tresses.", postcode: "69007", city: "Lyon", modes: ["at_supplier", "travels"], travelAreas: ["01"], availabilityMode: "by_arrangement", contactMethod: "whatsapp", contactValue: "0612345678", ...fields }, Object.fromEntries(groups.map((g) => [g, "confirmed" as const])));
  return store.setState(userId, { status: "published", publishedAt: "2026-10-01T10:00:00Z", lastConfirmedAt: "2026-10-01T10:00:00Z" });
}

function fakeRelevance(scores: Record<string, number>) {
  const complete: LlmClient["complete"] = async ({ messages }: { messages: LlmMessage[] }) => {
    const text = messages.at(-1)!.content;
    const json = JSON.parse(text.slice(text.indexOf("[")).trim()) as { id: string; nom: string }[];
    const evaluations: RelevanceOutput["evaluations"] = json.map((c) => ({ id: c.id, score: scores[c.nom] ?? 0, reason: `${c.nom} fait des tresses.`, concerns: [] }));
    return { evaluations } as never;
  };
  return { complete };
}

function turn(text: string): AgentTurnInput {
  return { userRef: "camille", text, context: { rank: "primary_user", autoParticipants: [], ccAddresses: [], info: {} }, history: [], today: NOW, timezone: "Europe/Paris", channel: "web" };
}

describe("signalement — côté acheteur, en mémoire", () => {
  it("signaler écarte la vitrine pour la personne et crée un signalement ouvert ; une suspension la sort des suggestions", async () => {
    const storefronts = new MemoryStorefrontStore(() => NOW);
    const store = new MemoryMatchStore(storefronts, () => NOW);
    const sf = await publish(storefronts, "sarah");
    const request = await store.createRequest("camille", { text: "des tresses", categoryCode: "coiffure", postcode: "69007" });
    const [suggestion] = await store.addSuggestions([{ requestId: request.id, buyerUserId: "camille", storefrontId: sf.id, reason: "x", internalReason: "x", score: 0.9, fit: "strong" }]);

    const fake = fakeLlm([{ calls: [{ tool: "signaler_vitrine", input: { suggestion_id: suggestion.id, motif: "misleading", commentaire: "Elle ne fait pas de tresses en vrai" } }], text: (r) => r[0] }]);
    const brain = coupDeMainBrain(fake.llm, { store, profileOf: async (ref) => ({ id: ref, firstName: "Camille" }), now: () => NOW });
    const reply = await brain.generate(turn("Je veux signaler cette vitrine, c'est trompeur"));
    expect(reply.reply.text).toContain("Signalement transmis à MAAQ (Description trompeuse)");
    const [report] = await store.listReports();
    expect(report).toMatchObject({ reporterUserId: "camille", storefrontId: sf.id, suggestionId: suggestion.id, reason: "misleading", comment: "Elle ne fait pas de tresses en vrai", status: "open" });
    expect((await store.getSuggestion("camille", suggestion.id))!.status).toBe("dismissed");

    expect(await storefronts.listEligible("2026-10-22")).toHaveLength(1);
    await storefronts.setState("sarah", { adminPaused: true, adminPauseReason: "Signalement en cours" });
    expect(await storefronts.listEligible("2026-10-22")).toEqual([]);
    expect(await store.getEligible(sf.id, "2026-10-22")).toBeNull();
    await storefronts.setState("sarah", { adminPaused: false, adminPauseReason: null });
    expect(await storefronts.listEligible("2026-10-22")).toHaveLength(1);
  });
});

describe("Admin › Vitrines — base", () => {
  let db: Kysely<DB>;
  let adminId: string;

  beforeAll(async () => {
    db = testDb();
    adminId = (await createProfile(db, { role: "admin" })).id;
  });
  afterAll(async () => {
    await db.destroy();
  });

  it("liste signalées d'abord, détail avec raisons internes et journal, suspension, catégorie, décision ; tout est journalisé", async () => {
    const clock = new Date("2026-10-22T10:00:00Z");
    const ctx = { db, now: clock };
    const buyer = await createProfile(db);
    const supplier = await createProfile(db);
    const other = await createProfile(db);
    const storefronts = new DbStorefrontStore(db, undefined, () => clock);
    const reported = await publish(storefronts, supplier.id, { displayName: `Signalée ${supplier.id.slice(0, 4)}` });
    const clean = await publish(storefronts, other.id, { displayName: `Propre ${other.id.slice(0, 4)}`, postcode: "75011", city: "Paris", modes: ["remote"], travelAreas: [] });
    const store = new DbMatchStore(db, () => clock);

    // Une suggestion montrée (journal + raison interne), puis un signalement.
    const request = await store.createRequest(buyer.id, { text: "des tresses", categoryCode: "coiffure", postcode: "69007" });
    const outcome = await matchRequest({ store, llm: fakeRelevance({ [reported.displayName!]: 0.9, [clean.displayName!]: 0.2 }), now: () => clock, today: "2026-10-22" }, request);
    expect(outcome.suggestions.map((v) => v.storefront.id)).toEqual([reported.id]);
    const report = await store.createReport({ reporterUserId: buyer.id, storefrontId: reported.id, suggestionId: outcome.suggestions[0].suggestion.id, reason: "inappropriate", comment: "Photo déplacée" });

    const rows = await listStorefronts(ctx);
    expect(rows[0].id).toBe(reported.id);
    expect(rows[0]).toMatchObject({ openReports: 1, suggestionsShown: 1, introductions: 0, status: "published", adminPaused: false, supplier: { email: supplier.email } });
    expect((await listStorefronts(ctx, "reported")).map((r) => r.id)).toEqual([reported.id]);
    expect((await listStorefronts(ctx, "published")).some((r) => r.id === clean.id)).toBe(true);
    expect((await listStorefronts(ctx, "all", other.email)).map((r) => r.id)).toEqual([clean.id]);

    const detail = await getStorefrontDetail(ctx, reported.id);
    expect(detail.reports).toHaveLength(1);
    expect(detail.reports[0]).toMatchObject({ reasonLabel: "Contenu inapproprié", reporterFirstName: "Camille", status: "open", comment: "Photo déplacée" });
    expect(detail.suggestions[0]).toMatchObject({ buyerFirstName: "Camille", requestText: "des tresses", fit: "strong", status: "shown" });
    expect(detail.suggestions[0].internalReason).toContain("Catégorie : coiffure demandée, vitrine coiffure ✔");
    expect(detail.matchLog[0].entry.decision).toBe("shown");
    expect(detail.preview.name).toBe(reported.displayName);
    expect(JSON.stringify(detail)).not.toContain("0612345678");
    // La vitrine retenue (score faible) apparaît aussi dans le journal de son propre détail.
    expect((await getStorefrontDetail(ctx, clean.id)).matchLog[0].entry.decision).toBe("withheld");

    const counters = await marketplaceCounters(ctx);
    expect(counters.reports.open).toBeGreaterThanOrEqual(1);
    expect(counters.suggestions.shown).toBeGreaterThanOrEqual(1);
    expect(counters.eligibleByCategory.find((c) => c.code === "coiffure")!.count).toBeGreaterThanOrEqual(2);
    expect(counters.eligibleByDepartement.find((d) => d.departement === "69")!.count).toBeGreaterThanOrEqual(1);
    expect(counters.eligibleByDepartement.find((d) => d.departement === "à distance")!.count).toBeGreaterThanOrEqual(1);

    // Suspension : raison obligatoire, hors vue, visible du fournisseur, journalisée.
    await expect(setAdminPause(ctx, adminId, reported.id, true, "")).rejects.toMatchObject({ code: "reason_required" });
    await setAdminPause(ctx, adminId, reported.id, true, "Signalement en cours d'examen");
    expect((await storefronts.get(supplier.id))!).toMatchObject({ adminPaused: true, adminPauseReason: "Signalement en cours d'examen", status: "published" });
    expect(await db.selectFrom("v_eligible_storefronts").select("id").where("id", "=", reported.id).execute()).toEqual([]);
    expect((await listStorefronts(ctx, "suspended")).map((r) => r.id)).toEqual([reported.id]);
    expect((await marketplaceCounters(ctx)).storefronts.suspended).toBeGreaterThanOrEqual(1);

    // Catégorie corrigée : confirmée, inconnue refusée, journalisée.
    await expect(remapCategory(ctx, adminId, reported.id, "plomberie")).rejects.toMatchObject({ code: "unknown_category" });
    await remapCategory(ctx, adminId, reported.id, "beaute");
    const remapped = (await storefronts.get(supplier.id))!;
    expect(remapped.categoryCode).toBe("beaute");
    expect(remapped.provenance.category?.source).toBe("confirmed");

    // Décision sur le signalement : une seule fois.
    const reviewed = await reviewReport(ctx, adminId, report.id, "reviewed", "Vitrine suspendue, fournisseur prévenu");
    expect(reviewed).toMatchObject({ status: "reviewed", adminDecision: "Vitrine suspendue, fournisseur prévenu", adminUserId: adminId });
    await expect(reviewReport(ctx, adminId, report.id, "dismissed", null)).rejects.toMatchObject({ code: "already_reviewed" });
    expect((await listStorefronts(ctx, "reported")).some((r) => r.id === reported.id)).toBe(false);

    await setAdminPause(ctx, adminId, reported.id, false, null);
    expect((await storefronts.get(supplier.id))!.adminPaused).toBe(false);
    expect(await db.selectFrom("v_eligible_storefronts").select("id").where("id", "=", reported.id).execute()).toHaveLength(1);

    const audit = (await getStorefrontDetail(ctx, reported.id)).audit.map((a) => a.action);
    expect([...audit].sort()).toEqual(["storefront_category_changed", "storefront_paused", "storefront_resumed"]);
    const reportAudit = await db.selectFrom("admin_audit_log").select("action_type").where("entity_type", "=", "listing_report").where("entity_id", "=", report.id).execute();
    expect(reportAudit).toEqual([{ action_type: "report_reviewed" }]);
    await expect(getStorefrontDetail(ctx, "00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({ code: "not_found" });
  });
});
