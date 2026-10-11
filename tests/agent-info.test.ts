import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Ctx } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { agentInfoOverview, checkValue, getAgentInfoForm, saveAgentInfo } from "@/server/profile/agent-info";
import { createProfile, sessionFor, testDb } from "./helpers/fixtures";

let db: Kysely<DB>;
beforeAll(() => {
  db = testDb();
});
afterAll(async () => {
  await db.destroy();
});

const at = (): Ctx => ({ db, now: new Date() });

async function rejectionOf(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("refus attendu");
}

/** Agent de test avec ses champs, ajouté au dashboard des profils indiqués. */
async function agentWithFields(name: string, fields: { label: string; type: string; required: boolean; max?: number; key?: string }[], userIds: string[]) {
  const agent = await db
    .insertInto("agents")
    .values({
      digitorn_agent_ref: `test-${name}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      category_id: (await db.selectFrom("agent_categories").select("id").where("code", "=", "perso").executeTakeFirstOrThrow()).id,
      short_description: "Agent de test",
      full_description: "Agent de test",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  for (const [i, f] of fields.entries()) {
    await db
      .insertInto("agent_info_fields")
      .values({
        agent_id: agent.id,
        label: f.label,
        data_type: f.type as "text",
        is_required: f.required,
        max_items: f.max ?? 1,
        shared_key: f.key ?? null,
        sort_order: i + 1,
      })
      .execute();
  }
  for (const userId of userIds) await db.insertInto("profile_agents").values({ user_id: userId, agent_id: agent.id }).execute();
  const ids = await db.selectFrom("agent_info_fields").select(["id", "label"]).where("agent_id", "=", agent.id).orderBy("sort_order").execute();
  return { agentId: agent.id, field: Object.fromEntries(ids.map((f) => [f.label, f.id])) as Record<string, string> };
}

async function account() {
  const primary = await createProfile(db);
  const guest = await db
    .insertInto("users")
    .values({
      account_id: primary.accountId,
      role: "guest",
      guest_rank: "core",
      first_name: "Julien",
      last_name: "Martin",
      email: `julien-${Math.random().toString(36).slice(2, 8)}@maaq.test`,
      status: "active",
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { primary, primarySession: await sessionFor(db, primary.id), guestId: guest.id, guestSession: await sessionFor(db, guest.id) };
}

describe("US-10 RF4 — contrôle des formats", () => {
  it("téléphone, code postal, date passée, email", () => {
    expect(checkValue("phone", "06 12 34 56 78")).toEqual({ value: "+33612345678" });
    expect(checkValue("phone", "12")).toEqual({ error: "Numéro de téléphone invalide" });
    expect(checkValue("postal_code", "75011")).toEqual({ value: "75011" });
    expect(checkValue("postal_code", "7501")).toEqual({ error: "Format invalide — 5 chiffres" });
    expect(checkValue("past_date", "1985-04-12", new Date("2026-10-01"))).toEqual({ value: "1985-04-12" });
    expect(checkValue("past_date", "2030-01-01", new Date("2026-10-01"))).toEqual({ error: "La date doit être passée" });
    expect(checkValue("past_date", "2026-02-30")).toEqual({ error: "Date invalide" });
    expect(checkValue("email", "pas-un-email")).toEqual({ error: "Adresse email invalide" });
  });
});

describe("US-10 RF12 / US-12 — informations propres à chaque agent", () => {
  it("enregistre des valeurs contrôlées, normalisées et chiffrées", async () => {
    const { primary, primarySession } = await account();
    const { agentId, field } = await agentWithFields(
      "Admin_Test",
      [
        { label: "Téléphone", type: "phone", required: true, key: "telephone" },
        { label: "Code postal", type: "postal_code", required: false },
        { label: "Personnes à charge", type: "text", required: false, max: 2 },
      ],
      [primary.id],
    );

    let form = await getAgentInfoForm(at(), primarySession, primary.id, agentId);
    expect(form).toMatchObject({ complete: false, profile: { isSelf: true } });

    const invalid = await rejectionOf(saveAgentInfo(at(), primarySession, primary.id, agentId, { [field["Téléphone"]]: ["12"], [field["Personnes à charge"]]: ["A", "B", "C"] }));
    expect(invalid.details).toEqual({ [field["Téléphone"]]: "Numéro de téléphone invalide", [field["Personnes à charge"]]: "2 éléments au maximum" });
    const missing = await rejectionOf(saveAgentInfo(at(), primarySession, primary.id, agentId, {}));
    expect(missing.details).toEqual({ [field["Téléphone"]]: "Ce champ est obligatoire" });

    form = await saveAgentInfo(at(), primarySession, primary.id, agentId, {
      [field["Téléphone"]]: ["06 12 34 56 78"],
      [field["Personnes à charge"]]: ["Léa", "Tom"],
    });
    expect(form.complete).toBe(true);
    expect(form.fields.map((f) => f.values)).toEqual([["+33612345678"], [], ["Léa", "Tom"]]);

    // US-10 RT1 : rien n'est lisible en clair dans la base.
    const stored = await db.selectFrom("user_agent_info_values").select("value_encrypted").where("user_id", "=", primary.id).execute();
    expect(stored).toHaveLength(3);
    expect(stored.every((r) => !Buffer.from(r.value_encrypted).toString("utf8").includes("33612345678"))).toBe(true);

    // Réduire une liste supprime les éléments en trop.
    form = await saveAgentInfo(at(), primarySession, primary.id, agentId, { [field["Téléphone"]]: ["+33612345678"], [field["Personnes à charge"]]: ["Léa"] });
    expect(form.fields[2].values).toEqual(["Léa"]);
  });

  it("D15 : une valeur de même clé commune est proposée, puis reste une copie propre à l'agent", async () => {
    const { primary, primarySession } = await account();
    const first = await agentWithFields("Admin_Un", [{ label: "Téléphone", type: "phone", required: true, key: "telephone" }], [primary.id]);
    const second = await agentWithFields("Admin_Deux", [{ label: "Numéro de mobile", type: "phone", required: true, key: "telephone" }], [primary.id]);
    await saveAgentInfo(at(), primarySession, primary.id, first.agentId, { [first.field["Téléphone"]]: ["0611223344"] });

    let form = await getAgentInfoForm(at(), primarySession, primary.id, second.agentId);
    expect(form.fields[0]).toMatchObject({ values: [], prefill: { values: ["+33611223344"], sourceAgent: "Admin_Un" } });

    await saveAgentInfo(at(), primarySession, primary.id, second.agentId, { [second.field["Numéro de mobile"]]: ["0699887766"] });
    form = await getAgentInfoForm(at(), primarySession, primary.id, first.agentId);
    expect(form.fields[0].values).toEqual(["+33611223344"]); // l'autre agent n'est pas modifié
  });

  it("US-11 RF2, US-12 RF6 : l'utilisateur principal renseigne son invité ; l'invité ne voit que lui-même", async () => {
    const { primary, primarySession, guestId, guestSession } = await account();
    const { agentId, field } = await agentWithFields("Admin_Partage", [{ label: "Email perso", type: "email", required: true }], [primary.id, guestId]);

    await saveAgentInfo(at(), primarySession, guestId, agentId, { [field["Email perso"]]: ["julien.perso@exemple.fr"] });
    const guestView = await getAgentInfoForm(at(), guestSession, guestId, agentId);
    expect(guestView.fields[0].values).toEqual(["julien.perso@exemple.fr"]);

    // US-11 RF12 : la dernière modification l'emporte, quel qu'en soit l'auteur.
    await saveAgentInfo(at(), guestSession, guestId, agentId, { [field["Email perso"]]: ["julien@exemple.fr"] });
    expect((await getAgentInfoForm(at(), primarySession, guestId, agentId)).fields[0].values).toEqual(["julien@exemple.fr"]);

    expect((await rejectionOf(getAgentInfoForm(at(), guestSession, primary.id, agentId))).code).toBe("forbidden");
  });

  it("US-10 RF13 : vue par agent avec les informations manquantes signalées", async () => {
    const { primary, primarySession } = await account();
    const withFields = await agentWithFields("Admin_Champs", [{ label: "Code postal", type: "postal_code", required: true }], [primary.id]);
    await agentWithFields("Admin_Vide", [], [primary.id]);

    let overview = await agentInfoOverview(at(), primarySession, primary.id);
    expect(overview.map((a) => [a.agentName, a.status])).toEqual([
      ["Admin_Champs", "missing"],
      ["Admin_Vide", "none"],
    ]);
    await saveAgentInfo(at(), primarySession, primary.id, withFields.agentId, { [withFields.field["Code postal"]]: ["75011"] });
    overview = await agentInfoOverview(at(), primarySession, primary.id);
    expect(overview[0].status).toBe("complete");
  });

  it("refuse un agent absent du dashboard du profil", async () => {
    const { primary, primarySession } = await account();
    const elsewhere = await agentWithFields("Admin_Ailleurs", [], []);
    expect((await rejectionOf(getAgentInfoForm(at(), primarySession, primary.id, elsewhere.agentId))).code).toBe("not_found");
  });
});
