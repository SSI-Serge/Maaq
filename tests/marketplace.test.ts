import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RequestContext } from "@/server/adapters/digitorn/types";
import type { AgentTurnInput } from "@/server/agents/types";
import { contextBlock, VITRINE_FAILURE_MESSAGE, vitrineBrain } from "@/server/agents/vitrine";
import { describeStorefront, toPatch } from "@/server/agents/vitrine-tools";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { DbStorefrontStore } from "@/server/marketplace/db-store";
import { buyerPreview, departementOf, publicationIssues, SERVICE_CATEGORIES, servedDepartements, touchedGroups } from "@/server/marketplace/model";
import { confirmStorefront, getStorefrontView, normalizePatch, pauseStorefront, publishStorefront, setUnavailableUntil, storefrontStore, updateStorefront, viewOf } from "@/server/marketplace/service";
import { GroupEmpty, MemoryStorefrontStore, StorefrontNotFound, type StorefrontStore } from "@/server/marketplace/store";
import { fakeLlm, type ScriptStep } from "./helpers/fake-llm";
import { createProfile, sessionFor, testDb } from "./helpers/fixtures";

const TODAY = new Date("2026-10-21T09:00:00Z");

function context(): RequestContext {
  return { rank: "primary_user", autoParticipants: [], ccAddresses: [], info: {} };
}

function turn(text: string, overrides: Partial<AgentTurnInput> = {}): AgentTurnInput {
  return { userRef: "u1", text, context: context(), history: [], today: TODAY, timezone: "Europe/Paris", channel: "web", ...overrides };
}

/** Vitrine de Sarah, complète et confirmée : la base des tests de publication. */
async function completeStorefront(store: StorefrontStore, userId = "u1") {
  await store.save(
    userId,
    {
      displayName: "Sarah Tresses",
      services: ["tresses", "twists"],
      postcode: "69007",
      city: "Lyon",
      modes: ["at_supplier", "travels"],
      travelNote: "le samedi seulement",
      availabilityMode: "by_arrangement",
      contactMethod: "whatsapp",
      contactValue: "0612345678",
    },
    { availability: "proposed" },
  );
  await store.save(userId, { categoryCode: "coiffure", description: "Tresses et twists, chez moi à Lyon ou en déplacement le samedi." }, { category: "proposed", description: "proposed" });
  return store;
}

describe("vitrine — règles du modèle", () => {
  it("trouve le département d'un code postal, Corse et outre-mer compris", () => {
    expect(departementOf("69007")).toBe("69");
    expect(departementOf("20000")).toBe("2A");
    expect(departementOf("20200")).toBe("2B");
    expect(departementOf("97400")).toBe("974");
    expect(departementOf("6900")).toBeNull();
  });

  it("ne propose comme locale qu'une zone dite : chez soi, déplacements, jamais à distance seul", () => {
    expect(servedDepartements({ postcode: "69007", modes: ["at_supplier"], travelAreas: [] })).toEqual(["69"]);
    expect(servedDepartements({ postcode: "69007", modes: ["travels"], travelAreas: ["01", "69"] })).toEqual(["69", "01"]);
    expect(servedDepartements({ postcode: "69007", modes: ["remote"], travelAreas: ["01"] })).toEqual([]);
  });

  it("repère les groupes touchés par une modification", () => {
    expect(touchedGroups({ postcode: "69007", priceMode: "quote", languages: undefined })).toEqual(["area", "price"]);
  });

  it("liste ce qui bloque la publication : manquant, proposé, non confirmé", async () => {
    const store = await completeStorefront(new MemoryStorefrontStore(() => TODAY));
    const before = publicationIssues((await store.get("u1"))!);
    expect(before.map((i) => `${i.group}:${i.reason}`)).toEqual(["category:proposed", "description:proposed", "area:unconfirmed", "availability:proposed", "contact:unconfirmed"]);

    await store.confirm("u1", ["category", "description", "area", "availability", "contact"]);
    expect(publicationIssues((await store.get("u1"))!)).toEqual([]);

    // Un tarif renseigné devient critique ; une modification lui fait perdre sa confirmation.
    await store.save("u1", { priceMode: "from", priceMin: 40 });
    expect(publicationIssues((await store.get("u1"))!)).toEqual([{ group: "price", reason: "unconfirmed" }]);
    await store.confirm("u1", ["price"]);
    await store.save("u1", { priceMin: 45 });
    expect(publicationIssues((await store.get("u1"))!)).toEqual([{ group: "price", reason: "unconfirmed" }]);
  });

  it("montre à l'acheteur un aperçu sans adresse ni contact, « Sur devis » sans tarif", async () => {
    const store = await completeStorefront(new MemoryStorefrontStore(() => TODAY));
    const preview = buyerPreview((await store.get("u1"))!);
    expect(preview).toMatchObject({ name: "Sarah Tresses", category: "Coiffure et barbier", price: "Sur devis", availability: "À convenir", area: "Lyon (69) · chez le fournisseur · se déplace (le samedi seulement)" });
    expect(JSON.stringify(preview)).not.toContain("0612345678");
    expect(JSON.stringify(preview)).not.toContain("69007");
  });

  it("refuse une catégorie inconnue et un tarif incohérent, nettoie les listes", async () => {
    const store = new MemoryStorefrontStore(() => TODAY);
    await expect(normalizePatch(store, { categoryCode: "plomberie" })).rejects.toBeInstanceOf(Rejection);
    await expect(normalizePatch(store, { priceMode: "range", priceMin: 60, priceMax: 40 })).rejects.toBeInstanceOf(Rejection);
    expect(await normalizePatch(store, { services: [" Tresses", "tresses", "", "Twists"], priceMode: "quote", priceMin: 10, travelAreas: ["2a"] })).toEqual({ services: ["Tresses", "Twists"], priceMode: "quote", priceMin: null, priceMax: null, travelAreas: ["2A"] });
  });

  it("convertit les champs français de l'agent vers le modèle, sans toucher aux absents", () => {
    expect(toPatch({ modes: ["chez_moi", "deplacement"], precision_deplacement: "le samedi seulement", tarif: { mode: "a_partir_de", min: 40 }, contact: { methode: "whatsapp", valeur: "06 12" }, disponibilite: { mode: "a_convenir" } })).toEqual({
      modes: ["at_supplier", "travels"],
      travelNote: "le samedi seulement",
      priceMode: "from",
      priceMin: 40,
      priceMax: null,
      contactMethod: "whatsapp",
      contactValue: "06 12",
      availabilityMode: "by_arrangement",
      availabilityText: null,
    });
    expect(toPatch({})).toEqual({});
  });
});

describe("vitrine — magasin en mémoire", () => {
  it("crée le brouillon au premier enregistrement, confirme, exclut les vitrines en pause", async () => {
    const store = new MemoryStorefrontStore(() => TODAY);
    expect(await store.get("u1")).toBeNull();
    await expect(store.confirm("u1", ["area"])).rejects.toBeInstanceOf(StorefrontNotFound);

    const draft = await store.save("u1", { displayName: "Sarah" });
    expect(draft).toMatchObject({ status: "draft", displayName: "Sarah", provenance: { displayName: { source: "stated" } } });
    await expect(store.confirm("u1", ["price"])).rejects.toBeInstanceOf(GroupEmpty);

    await store.setState("u1", { status: "published", publishedAt: TODAY.toISOString() });
    expect((await store.listEligible("2026-10-21")).map((s) => s.userId)).toEqual(["u1"]);
    await store.setState("u1", { pausedUntil: "2026-10-30" });
    expect(await store.listEligible("2026-10-21")).toEqual([]);
    expect((await store.listEligible("2026-10-31")).length).toBe(1);
    await store.setState("u1", { status: "paused", pausedUntil: null });
    expect(await store.listEligible("2026-10-21")).toEqual([]);
  });
});

describe("vitrine — agent avec faux modèle", () => {
  function setup(steps: ScriptStep[]) {
    const store = new MemoryStorefrontStore(() => TODAY);
    const fake = fakeLlm(steps);
    return { store, ...fake, brain: vitrineBrain(fake.llm, { store }) };
  }

  it("extrait ce qui est dit, propose le reste à part, et le contexte distingue les deux", async () => {
    const { store, brain, runs } = setup([
      {
        calls: [
          { tool: "enregistrer_dits", input: { champs: { services: ["tresses", "twists"], ville: "Lyon", modes: ["chez_moi", "deplacement"], precision_deplacement: "le samedi seulement" } } },
          { tool: "proposer_champs", input: { champs: { categorie: "coiffure", disponibilite: { mode: "a_convenir" } } } },
        ],
        text: "Voici ce que j'ai compris. Quel nom souhaitez-vous afficher ?",
      },
      { calls: [{ tool: "lire_vitrine", input: {} }], text: (r) => r[0] },
    ]);

    const first = await brain.generate(turn("Je fais des tresses et des twists à Lyon. Je travaille chez moi, mais je peux me déplacer le samedi."));
    expect(first.calls).toEqual(["enregistrer_dits", "proposer_champs"]);
    expect(first.problems).toEqual([]);
    const saved = (await store.get("u1"))!;
    expect(saved).toMatchObject({ services: ["tresses", "twists"], modes: ["at_supplier", "travels"], travelNote: "le samedi seulement", categoryCode: "coiffure", availabilityMode: "by_arrangement" });
    expect(saved.provenance.services?.source).toBe("stated");
    expect(saved.provenance.area?.source).toBe("stated");
    expect(saved.provenance.category?.source).toBe("proposed");
    expect(saved.provenance.availability?.source).toBe("proposed");

    const second = await brain.generate(turn("Qu'est-ce qu'il manque ?"));
    expect(second.reply.text).toContain("Catégorie : Coiffure et barbier [proposé par vous, à confirmer]");
    expect(second.reply.text).toContain("Zone : code postal ? · Lyon · chez le fournisseur · se déplace (le samedi seulement) [dit par le fournisseur]");
    expect(second.reply.text).toContain("Nom affiché (manquant)");
    expect(runs[1].messages.at(-1)!.content).toContain("Vitrine actuelle :");
  });

  it("refuse une catégorie inconnue sans planter et garde la trace du problème", async () => {
    const { brain } = setup([{ calls: [{ tool: "proposer_champs", input: { champs: { categorie: "coiffure", tarif: { mode: "fourchette", min: 80, max: 40 } } } }], text: (r) => r[0] }]);
    const result = await brain.generate(turn("Entre 80 et 40 euros"));
    expect(result.reply.text).toContain("Refusé");
    expect(result.problems).toHaveLength(1);
  });

  it("confirme seulement des groupes renseignés, et la publication reste hors du tchat", async () => {
    const { store, brain } = setup([
      { calls: [{ tool: "confirmer_champs", input: { groupes: ["price"] } }], text: (r) => r[0] },
      { calls: [{ tool: "confirmer_champs", input: { groupes: ["area", "contact", "category", "description", "availability"] } }], text: (r) => r[0] },
    ]);
    await completeStorefront(store);
    const refused = await brain.generate(turn("Oui c'est ça"));
    expect(refused.reply.text).toContain("Refusé");
    const confirmed = await brain.generate(turn("Oui c'est ça"));
    expect(confirmed.reply.text).toContain("Publiable");
    expect(confirmed.reply.text).toContain("écran « Ma vitrine »");
    expect((await store.get("u1"))!.status).toBe("draft");
  });

  it("met en pause une vitrine publiée seulement, et refuse une indisponibilité passée", async () => {
    const { store, brain } = setup([
      { calls: [{ tool: "mettre_en_pause", input: {} }], text: (r) => r[0] },
      { calls: [{ tool: "indisponible_jusquau", input: { date: "2026-10-01" } }], text: (r) => r[0] },
      { calls: [{ tool: "indisponible_jusquau", input: { date: "2026-11-02" } }, { tool: "mettre_en_pause", input: {} }], text: (r) => r.join("\n") },
    ]);
    await completeStorefront(store);
    expect((await brain.generate(turn("Pause"))).reply.text).toContain("n'est pas publiée");
    await store.setState("u1", { status: "published", publishedAt: TODAY.toISOString() });
    expect((await brain.generate(turn("Indispo"))).reply.text).toContain("déjà passé");
    const text = (await brain.generate(turn("Indispo puis pause"))).reply.text;
    expect(text).toContain("indisponible jusqu'au 2026-11-02");
    expect((await store.get("u1"))!).toMatchObject({ status: "paused", pausedUntil: "2026-11-02" });
  });

  it("rend un message d'excuse si le modèle ne répond rien, et le contexte décrit une vitrine vide", async () => {
    const { brain, store } = setup([{ text: "" }]);
    expect((await brain.generate(turn("Bonjour"))).reply.text).toBe(VITRINE_FAILURE_MESSAGE);
    expect(await contextBlock({ store }, "u1", turn("x"), "2026-10-21")).toContain("Aucune vitrine");
    expect(describeStorefront(null, (c) => c)).toContain("Aucune vitrine");
  });
});

describe("vitrine — base et service", () => {
  let db: Kysely<DB>;

  beforeAll(() => {
    db = testDb();
  });
  afterAll(async () => {
    await db.destroy();
  });

  it("enregistre en base avec le contact chiffré, confirme, publie, met en pause", async () => {
    const user = await createProfile(db);
    const clock = new Date("2026-10-21T10:00:00Z");
    const store = new DbStorefrontStore(db, undefined, () => clock);
    expect((await store.listCategories()).map((c) => c.code)).toEqual(SERVICE_CATEGORIES.map((c) => c.code));

    await completeStorefront(store, user.id);
    const saved = (await store.get(user.id))!;
    expect(saved).toMatchObject({ status: "draft", displayName: "Sarah Tresses", contactValue: "0612345678", modes: ["at_supplier", "travels"], version: 2 });
    const raw = await db.selectFrom("storefronts").select(["contact_value_encrypted"]).where("user_id", "=", user.id).executeTakeFirstOrThrow();
    expect(Buffer.from(raw.contact_value_encrypted!).toString("utf8")).not.toContain("0612345678");

    await store.confirm(user.id, ["category", "description", "area", "availability", "contact"]);
    const confirmed = (await store.get(user.id))!;
    expect(confirmed.provenance.area).toEqual({ source: "confirmed", at: clock.toISOString() });
    expect(confirmed.lastConfirmedAt).toBe(clock.toISOString());

    await store.setState(user.id, { status: "published", publishedAt: clock.toISOString() });
    expect((await store.listEligible("2026-10-21")).some((s) => s.userId === user.id)).toBe(true);
    const eligibleView = await db.selectFrom("v_eligible_storefronts").select(["display_name"]).where("user_id", "=", user.id).execute();
    expect(eligibleView).toEqual([{ display_name: "Sarah Tresses" }]);

    await store.setState(user.id, { pausedUntil: "2026-10-25" });
    expect((await store.listEligible("2026-10-21")).some((s) => s.userId === user.id)).toBe(false);
    expect(await db.selectFrom("v_eligible_storefronts").select("id").where("user_id", "=", user.id).execute()).toEqual([]);
  });

  it("service : modification depuis l'écran = confirmée, publication refusée tant qu'il manque quelque chose", async () => {
    const user = await createProfile(db);
    const session = await sessionFor(db, user.id);
    const ctx = { db, now: new Date("2026-10-21T10:00:00Z") };
    const store = storefrontStore(db);

    expect((await getStorefrontView(ctx, session)).storefront).toBeNull();
    await expect(publishStorefront(ctx, session)).rejects.toMatchObject({ code: "not_found" });

    await completeStorefront(store, user.id);
    const incomplete = await publishStorefront(ctx, session).catch((e: Rejection) => e);
    expect(incomplete).toMatchObject({ code: "storefront_incomplete" });
    expect((incomplete as Rejection).message).toContain("Catégorie : proposé par MAAQ, à confirmer");

    // Modifier une ligne soi-même vaut confirmation ; les autres restent à confirmer.
    const edited = await updateStorefront(ctx, session, { categoryCode: "coiffure", priceMode: "from", priceMin: 40 });
    expect(edited.storefront!.provenance.category?.source).toBe("confirmed");
    expect(edited.storefront!.provenance.price?.source).toBe("confirmed");
    expect(edited.issueLines).toEqual(["Description : proposé par MAAQ, à confirmer", "Zone : à relire et confirmer", "Disponibilité : proposé par MAAQ, à confirmer", "Contact : à relire et confirmer"]);
    await expect(confirmStorefront(ctx, session, ["languages"])).rejects.toMatchObject({ code: "group_empty" });

    const ready = await confirmStorefront(ctx, session, ["description", "area", "availability", "contact"]);
    expect(ready.canPublish).toBe(true);
    expect(ready.preview).toMatchObject({ price: "À partir de 40 €" });

    await expect(pauseStorefront(ctx, session, true)).rejects.toMatchObject({ code: "not_published" });
    const published = await publishStorefront(ctx, session);
    expect(published.storefront).toMatchObject({ status: "published", publishedAt: ctx.now.toISOString() });

    await expect(setUnavailableUntil(ctx, session, "2026-10-01")).rejects.toMatchObject({ code: "date_past" });
    expect((await setUnavailableUntil(ctx, session, "2026-11-02")).storefront!.pausedUntil).toBe("2026-11-02");
    expect((await pauseStorefront(ctx, session, true)).storefront!.status).toBe("paused");
    expect((await pauseStorefront(ctx, session, false)).storefront!.status).toBe("published");
    expect((await viewOf(store, user.id)).canPublish).toBe(true);
  });
});
