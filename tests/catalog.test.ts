import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blockAgent, reactivateAgent } from "@/server/admin/agents";
import type { Ctx } from "@/server/auth/service";
import { addAgent, getAgentSheet, getDashboard, listCatalog, normalizeText, removeAgent } from "@/server/catalog/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { createProfile, sessionFor, testDb } from "./helpers/fixtures";

let db: Kysely<DB>;
let adminId: string;
beforeAll(async () => {
  db = testDb();
  adminId = (await createProfile(db, { role: "admin" })).id;
});
afterAll(async () => {
  await db.destroy();
});

const at = (): Ctx => ({ db, now: new Date() });
const tag = () => Math.random().toString(36).slice(2, 8);

async function rejectionOf(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("refus attendu");
}

interface AgentSeed {
  name?: string;
  category?: "pro" | "perso" | "contracts";
  short?: string;
  full?: string;
  examples?: string[];
  requires?: { connector: "google_drive" | "google_calendar" | "validation_mailbox"; scope: "each_profile" | "primary_user" | "account" }[];
  infoRequired?: boolean;
}

/** Agent publié pour un test ; le nom porte un suffixe unique pour retrouver ses agents. */
async function agent(seed: AgentSeed = {}) {
  const category = await db.selectFrom("agent_categories").select("id").where("code", "=", seed.category ?? "pro").executeTakeFirstOrThrow();
  const name = `${seed.name ?? "Agent"}_${tag()}`;
  const row = await db
    .insertInto("agents")
    .values({
      digitorn_agent_ref: `cat-${tag()}${tag()}`,
      name,
      category_id: category.id,
      short_description: seed.short ?? "Description courte",
      full_description: seed.full ?? "Description complète",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  for (const [i, content] of (seed.examples ?? []).entries()) {
    await db.insertInto("agent_sample_prompts").values({ agent_id: row.id, kind: "example", content, sort_order: i + 1 }).execute();
  }
  for (const r of seed.requires ?? []) {
    const type = await db.selectFrom("connector_types").select("id").where("code", "=", r.connector).executeTakeFirstOrThrow();
    await db.insertInto("agent_requirements").values({ agent_id: row.id, connector_type_id: type.id, owner_scope: r.scope }).execute();
  }
  if (seed.infoRequired) {
    await db.insertInto("agent_info_fields").values({ agent_id: row.id, label: "Numéro fiscal", data_type: "text", is_required: true }).execute();
  }
  return { id: row.id, name };
}

async function account() {
  const primary = await createProfile(db);
  const mk = async (rank: "core" | "secondary") => {
    const g = await db
      .insertInto("users")
      .values({ account_id: primary.accountId, role: "guest", guest_rank: rank, first_name: "Invité", last_name: rank, email: `${rank}-${tag()}@maaq.test`, status: "active" })
      .returning("id")
      .executeTakeFirstOrThrow();
    return sessionFor(db, g.id);
  };
  return { primary: await sessionFor(db, primary.id), core: await mk("core"), secondary: await mk("secondary") };
}

describe("US-25 — normalisation de la recherche", () => {
  it("ignore accents et majuscules", () => {
    expect(normalizeText("  Mutuelle SANTÉ à Noël ")).toBe("mutuelle sante a noel");
  });
});

describe("US-23 / US-25 — catalogue et recherche", () => {
  it("RF2-RF4 : une rubrique, par ordre alphabétique, avec les badges « Ajouté » et « En maintenance »", async () => {
    const { primary } = await account();
    const suffix = tag();
    const names = [`Zèbre_${suffix}`, `abeille_${suffix}`, `Éclair_${suffix}`];
    for (const name of names) await agent({ name, category: "perso" });
    const items = (await listCatalog(at(), primary, { category: "perso" })).filter((i) => i.name.includes(suffix));
    expect(items.map((i) => i.name.split("_")[0])).toEqual(["abeille", "Éclair", "Zèbre"]);
    expect(items.every((i) => i.category === "perso" && !i.added && !i.maintenance)).toBe(true);

    await addAgent(at(), primary, items[0].id);
    await blockAgent(at(), adminId, items[1].id, "Maintenance");
    const after = (await listCatalog(at(), primary, { category: "perso" })).filter((i) => i.name.includes(suffix));
    expect(after.map((i) => [i.added, i.maintenance])).toEqual([[true, false], [false, true], [false, false]]);
    await reactivateAgent(at(), adminId, items[1].id);
  });

  it("US-25 RF2-RF3 : recherche dès 2 caractères sur le nom, la description et les exemples, toutes rubriques", async () => {
    const { primary } = await account();
    const word = `mutuelle${tag()}`;
    await agent({ name: "Nom", category: "pro", short: `Gère votre ${word}` });
    await agent({ name: "Autre", category: "perso", examples: [`Renouvelle ma ${word.toUpperCase()}`] });
    await agent({ name: "Sans", category: "perso", short: "Rien à voir" });

    const results = await listCatalog(at(), primary, { query: word });
    expect(results.map((r) => r.category).sort()).toEqual(["perso", "pro"]);
    expect((await listCatalog(at(), primary, { query: `Mútuelle${word.slice(8)}` })).length).toBe(2); // l'accent saisi n'empêche pas la correspondance
    expect((await listCatalog(at(), primary, { query: "m" })).length).toBeGreaterThan(2); // moins de 2 caractères : pas de recherche, tout le catalogue
  });

  it("US-25 RF2 : insensible aux accents", async () => {
    const { primary } = await account();
    const word = `santé${tag()}`;
    await agent({ short: `Votre ${word}` });
    expect((await listCatalog(at(), primary, { query: word.replace("é", "e") })).length).toBe(1);
    expect((await listCatalog(at(), primary, { query: word.toUpperCase() })).length).toBe(1);
  });

  it("US-23 RF11, US-25 RF9 : l'invité secondaire ne voit pas les Agents des Contrats", async () => {
    const { primary, core, secondary } = await account();
    const word = `contrat${tag()}`;
    const contracts = await agent({ category: "contracts", short: word });
    expect((await listCatalog(at(), core, { query: word })).map((i) => i.id)).toEqual([contracts.id]);
    expect((await listCatalog(at(), primary, { category: "contracts" })).map((i) => i.id)).toContain(contracts.id);
    expect(await listCatalog(at(), secondary, { query: word })).toEqual([]);
    expect(await listCatalog(at(), secondary, { category: "contracts" })).toEqual([]);
    expect((await rejectionOf(getAgentSheet(at(), secondary, contracts.id))).code).toBe("not_found");
    expect((await rejectionOf(addAgent(at(), secondary, contracts.id))).code).toBe("not_found");
  });

  it("refuse à l'administrateur", async () => {
    const admin = await sessionFor(db, adminId);
    expect((await rejectionOf(listCatalog(at(), admin, {}))).code).toBe("forbidden");
  });
});

describe("US-24 — fiche d'un agent", () => {
  it("RF1-RF4 : description, exemples, éléments à configurer, actions à valider, maintenance", async () => {
    const { primary } = await account();
    const a = await agent({
      category: "pro",
      full: "Prépare vos courriers.",
      examples: ["Écris à ma banque", "Résilie mon abonnement"],
      requires: [
        { connector: "validation_mailbox", scope: "each_profile" },
        { connector: "google_drive", scope: "account" },
      ],
      infoRequired: true,
    });
    await db.insertInto("agent_validated_actions").values({ agent_id: a.id, label: "Envoyer un email" }).execute();
    await blockAgent(at(), adminId, a.id, "Maintenance");

    const sheet = await getAgentSheet(at(), primary, a.id);
    expect(sheet).toMatchObject({
      name: a.name,
      category: "pro",
      categoryLabel: "Pro",
      description: "Prépare vos courriers.",
      examples: ["Écris à ma banque", "Résilie mon abonnement"],
      needsGeneralInfo: true,
      validatedActions: ["Envoyer un email"],
      maintenance: true,
      added: false,
      max: 10,
    });
    expect(sheet.requirements.map((r) => [r.connector, r.scope])).toEqual([
      ["google_drive", "account"],
      ["validation_mailbox", "each_profile"],
    ]);
    await reactivateAgent(at(), adminId, a.id);
  });
});

describe("US-26 / US-27 / US-28 — ajouter et retirer un agent", () => {
  it("US-26 RF1-RF2, RT1 : ajout, dans la bonne rubrique ; un double envoi n'ajoute qu'une fois", async () => {
    const { primary } = await account();
    const a = await agent({ category: "perso" });
    const first = await addAgent(at(), primary, a.id);
    expect(first).toMatchObject({ category: "perso", categoryLabel: "Perso", agentName: a.name, status: "ready", needsInfo: false, alreadyAdded: false });
    expect(await addAgent(at(), primary, a.id)).toMatchObject({ alreadyAdded: true });

    const [x, y] = await Promise.all([addAgent(at(), primary, a.id), addAgent(at(), primary, a.id)]);
    expect([x.alreadyAdded, y.alreadyAdded]).toEqual([true, true]);
    const rows = await db.selectFrom("profile_agents").select("id").where("user_id", "=", primary.user.id).where("agent_id", "=", a.id).execute();
    expect(rows).toHaveLength(1);
    expect((await getDashboard(at(), primary)).tabs.perso.map((d) => d.id)).toContain(a.id);
  });

  it("US-26 RF6 : chaque profil ajoute ses agents indépendamment", async () => {
    const { primary, core } = await account();
    const a = await agent({ category: "pro" });
    await addAgent(at(), core, a.id);
    expect((await getDashboard(at(), primary)).tabs.pro.map((d) => d.id)).not.toContain(a.id);
    expect((await getDashboard(at(), core)).tabs.pro.map((d) => d.id)).toContain(a.id);
  });

  it("US-27 RF1-RF4 : au-delà de la limite, l'ajout est refusé avec le message et la rubrique ; deux ajouts simultanés ne la dépassent pas", async () => {
    const { primary } = await account();
    await db.updateTable("platform_settings").set({ value_text: "3" }).where("setting_key", "=", "max_agents_per_category").execute();
    try {
      const ids = [];
      for (let i = 0; i < 5; i++) ids.push((await agent({ category: "perso" })).id);
      const settled = await Promise.allSettled(ids.map((id) => addAgent(at(), primary, id)));
      expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(3);
      const refused = settled.find((s): s is PromiseRejectedResult => s.status === "rejected")!;
      expect(refused.reason).toMatchObject({
        code: "limit_reached",
        message: "Vous avez atteint le maximum de 3 agents dans la rubrique Perso. Retirez un agent de cette rubrique pour en ajouter un nouveau.",
      });
      expect((await getDashboard(at(), primary)).max).toBe(3);
      // La limite est propre à chaque rubrique.
      await addAgent(at(), primary, (await agent({ category: "pro" })).id);
    } finally {
      await db.updateTable("platform_settings").set({ value_text: "10" }).where("setting_key", "=", "max_agents_per_category").execute();
    }
  });

  it("US-28 RF3-RF6, RT1 : le retrait masque l'agent sans rien supprimer, efface le tchat, ne touche pas les autres profils", async () => {
    const { primary, core } = await account();
    const a = await agent({ category: "pro" });
    await addAgent(at(), primary, a.id);
    await addAgent(at(), core, a.id);
    await removeAgent(at(), primary, a.id);
    await removeAgent(at(), primary, a.id); // double envoi : sans effet

    expect((await getDashboard(at(), primary)).tabs.pro.map((d) => d.id)).not.toContain(a.id);
    expect((await getDashboard(at(), core)).tabs.pro.map((d) => d.id)).toContain(a.id);
    const row = await db.selectFrom("profile_agents").select("removed_at").where("user_id", "=", primary.user.id).where("agent_id", "=", a.id).executeTakeFirstOrThrow();
    expect(row.removed_at).not.toBeNull();
    const erasures = await db.selectFrom("chat_erasure_requests").select(["reason", "status"]).where("user_id", "=", primary.user.id).where("agent_id", "=", a.id).execute();
    expect(erasures).toEqual([{ reason: "agent_removed", status: "done" }]);
  });

  it("US-26 RF4 : un agent retiré puis ré-ajouté retrouve sa configuration et passe en fin de liste", async () => {
    const { primary } = await account();
    const a = await agent({ category: "pro", infoRequired: true });
    const b = await agent({ category: "pro" });
    await addAgent(at(), primary, a.id);
    await addAgent(at(), primary, b.id);
    const field = await db.selectFrom("agent_info_fields").select("id").where("agent_id", "=", a.id).executeTakeFirstOrThrow();
    await db.insertInto("user_agent_info_values").values({ user_id: primary.user.id, info_field_id: field.id, value_encrypted: Buffer.from("x") }).execute();

    await removeAgent(at(), primary, a.id);
    await addAgent(at(), primary, a.id);
    const order = (await getDashboard(at(), primary)).tabs.pro.map((d) => d.id).filter((id) => [a.id, b.id].includes(id));
    expect(order).toEqual([b.id, a.id]);
    const kept = await db.selectFrom("user_agent_info_values").select("id").where("user_id", "=", primary.user.id).where("info_field_id", "=", field.id).execute();
    expect(kept).toHaveLength(1);
  });
});

describe("US-22 / US-29 — statuts du dashboard", () => {
  it("RT1 : Prêt, À configurer (connecteur ou information manquant), Bloqué", async () => {
    const { primary } = await account();
    const ready = await agent({ category: "pro" });
    const connector = await agent({ category: "pro", requires: [{ connector: "google_calendar", scope: "each_profile" }] });
    const info = await agent({ category: "pro", infoRequired: true });
    const blocked = await agent({ category: "perso" });
    for (const a of [ready, connector, info, blocked]) await addAgent(at(), primary, a.id);
    await blockAgent(at(), adminId, blocked.id, "Maintenance en cours");

    const dashboard = await getDashboard(at(), primary);
    const status = (id: string) => [...dashboard.tabs.pro, ...dashboard.tabs.perso].find((d) => d.id === id)?.status;
    expect(status(ready.id)).toBe("ready");
    expect(status(connector.id)).toBe("to_configure");
    expect(status(info.id)).toBe("to_configure");
    expect(status(blocked.id)).toBe("blocked");
    expect([...dashboard.tabs.perso].find((d) => d.id === blocked.id)?.maintenanceMessage).toBe("Maintenance en cours");
    expect(await addAgent(at(), primary, info.id)).toMatchObject({ needsInfo: true });

    // US-29 RF5 : une fois la connexion faite, l'agent devient prêt sans autre action.
    const type = await db.selectFrom("connector_types").select("id").where("code", "=", "google_calendar").executeTakeFirstOrThrow();
    await db
      .insertInto("agent_connections")
      .values({ user_id: primary.user.id, agent_id: connector.id, connector_type_id: type.id, connected_email: "camille@gmail.com", status: "connected" })
      .execute();
    expect((await getDashboard(at(), primary)).tabs.pro.find((d) => d.id === connector.id)?.status).toBe("ready");
    await reactivateAgent(at(), adminId, blocked.id);
  });

  it("RF3, RF7 : ordre d'ajout, et les Agents des Contrats ne sont pas sur le dashboard", async () => {
    const { primary } = await account();
    const first = await agent({ category: "pro" });
    const second = await agent({ category: "pro" });
    const contracts = await agent({ category: "contracts" });
    await addAgent(at(), primary, second.id);
    await addAgent(at(), primary, first.id);
    await addAgent(at(), primary, contracts.id);
    const dashboard = await getDashboard(at(), primary);
    expect(dashboard.tabs.pro.map((d) => d.id)).toEqual([second.id, first.id]);
    expect([...dashboard.tabs.pro, ...dashboard.tabs.perso].map((d) => d.id)).not.toContain(contracts.id);
  });
});

