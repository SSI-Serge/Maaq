import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activate, inspectActivation } from "@/server/accounts/activate";
import { createAccount, getAccount, listAccounts, resendActivation, updateDailyLimit } from "@/server/admin/accounts";
import { blockAgent, listAgents, listPublishableAgents, publishAgent, reactivateAgent, type PublishInput } from "@/server/admin/agents";
import {
  addContract,
  addContractField,
  archiveContract,
  archiveContractField,
  getContractFields,
  listContracts,
  moveContract,
  renameContract,
} from "@/server/admin/contracts";
import { listSettings, settingHistory, updateSettings, validateSetting } from "@/server/admin/settings";
import { getSession, type Ctx } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { idempotent } from "@/server/idempotency";
import { createProfile, messagesTo, minutesLater, testDb } from "./helpers/fixtures";

let db: Kysely<DB>;
let adminId: string;

beforeAll(async () => {
  db = testDb();
  adminId = (await createProfile(db, { role: "admin" })).id;
  const legal = await db.selectFrom("legal_document_versions").select("id").executeTakeFirst();
  if (!legal) {
    await db
      .insertInto("legal_document_versions")
      .values([
        { document_type: "privacy_policy", version_label: "test", content: "Politique", published_at: new Date(0) },
        { document_type: "terms_of_use", version_label: "test", content: "Conditions", published_at: new Date(0) },
      ])
      .execute();
  }
});
afterAll(async () => {
  await db.destroy();
});

const now = () => ({ db, now: new Date() }) as Ctx;

async function rejectionOf(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("refus attendu");
}

function agentInput(overrides: Partial<PublishInput> = {}): PublishInput {
  return {
    digitornRef: "admin_rdv",
    name: "Admin_RDV",
    category: "perso",
    shortDescription: "Prise de rendez-vous",
    fullDescription: "Prend vos rendez-vous et vous demande validation.",
    examples: ["Prends rendez-vous chez le dentiste"],
    suggestions: ["Prendre un rendez-vous"],
    connectors: [
      { code: "google_calendar", scope: "each_profile" },
      { code: "google_drive", scope: "account" },
    ],
    infoFields: [{ label: "Téléphone", dataType: "phone", required: true, maxItems: 1, sharedKey: "telephone" }],
    ccMaxCount: 10,
    validatedActions: ["Créer un rendez-vous"],
    ...overrides,
  };
}

describe("US-45 — mettre un agent à disposition", () => {
  it("RF2-RF4, RT1 : publie l'agent avec sa configuration et le journalise", async () => {
    expect((await listPublishableAgents(now())).map((a) => a.ref)).toContain("admin_rdv");
    const id = await publishAgent(now(), adminId, agentInput());

    const agent = (await listAgents(now(), "Admin_RDV")).find((a) => a.id === id)!;
    expect(agent).toMatchObject({ status: "available", category: "perso", categoryLabel: "Perso" });
    expect((await listPublishableAgents(now())).map((a) => a.ref)).not.toContain("admin_rdv");

    const requirements = await db.selectFrom("agent_requirements").select("owner_scope").where("agent_id", "=", id).execute();
    expect(requirements.map((r) => r.owner_scope).sort()).toEqual(["account", "each_profile"]);
    const fields = await db.selectFrom("agent_info_fields").selectAll().where("agent_id", "=", id).execute();
    expect(fields).toMatchObject([{ label: "Téléphone", data_type: "phone", shared_key: "telephone", max_items: 1 }]);
    const prompts = await db.selectFrom("agent_sample_prompts").select("kind").where("agent_id", "=", id).execute();
    expect(prompts.map((p) => p.kind).sort()).toEqual(["example", "first_suggestion"]);
    const audit = await db.selectFrom("admin_audit_log").selectAll().where("entity_id", "=", id).execute();
    expect(audit.map((a) => a.action_type)).toEqual(["agent_published"]);
  });

  it("refuse un agent déjà publié ou inconnu chez Digitorn", async () => {
    await publishAgent(now(), adminId, agentInput({ digitornRef: "admin_impots", name: "Admin_Impots" }));
    expect((await rejectionOf(publishAgent(now(), adminId, agentInput({ digitornRef: "admin_impots" })))).code).toBe("agent_unavailable");
    expect((await rejectionOf(publishAgent(now(), adminId, agentInput({ digitornRef: "inconnu" })))).code).toBe("agent_unavailable");
  });

  it("refuse deux champs d'information de même libellé", async () => {
    const twice = [
      { label: "Adresse", dataType: "text" as const, required: true, maxItems: 1, sharedKey: null },
      { label: "adresse", dataType: "text" as const, required: false, maxItems: 1, sharedKey: null },
    ];
    expect((await rejectionOf(publishAgent(now(), adminId, agentInput({ digitornRef: "perso_courses", infoFields: twice })))).code).toBe(
      "duplicate_field",
    );
  });

  it("RF1 : la recherche filtre par nom, description ou rubrique", async () => {
    const results = await listAgents(now(), "rendez-vous");
    expect(results.every((a) => /rendez-vous/i.test(a.name + a.shortDescription + a.categoryLabel))).toBe(true);
    expect(await listAgents(now(), "aucun-agent-ne-porte-ce-nom")).toEqual([]);
  });
});

describe("US-46 / US-47 — bloquer et réactiver un agent", () => {
  it("bloque avec un message obligatoire, puis réactive en effaçant le message", async () => {
    const id = (await listAgents(now(), "Admin_RDV"))[0].id;
    expect((await rejectionOf(blockAgent(now(), adminId, id, "   "))).code).toBe("invalid_message");
    expect((await rejectionOf(blockAgent(now(), adminId, id, "x".repeat(201)))).code).toBe("invalid_message");

    await blockAgent(now(), adminId, id, "Maintenance jusqu'à demain");
    const blocked = (await listAgents(now(), "Admin_RDV"))[0];
    expect(blocked).toMatchObject({ status: "blocked", maintenanceMessage: "Maintenance jusqu'à demain", blockedBy: "Camille Test" });
    expect((await rejectionOf(blockAgent(now(), adminId, id, "Encore"))).code).toBe("not_available");

    await reactivateAgent(now(), adminId, id);
    expect((await listAgents(now(), "Admin_RDV"))[0]).toMatchObject({ status: "available", maintenanceMessage: null });
    expect((await rejectionOf(reactivateAgent(now(), adminId, id))).code).toBe("not_blocked");

    const actions = await db.selectFrom("admin_audit_log").select("action_type").where("entity_id", "=", id).orderBy("id").execute();
    expect(actions.map((a) => a.action_type)).toEqual(["agent_published", "agent_blocked", "agent_reactivated"]);
  });
});

describe("US-64 — créer le compte d'un utilisateur principal", () => {
  const base = { firstName: "Élise", lastName: "Roy", phone: "06 11 22 33 44", guestQuota: 2, dailyRequestLimit: 50 };

  it("RF3 : vérifie chaque champ et refuse un email déjà utilisé", async () => {
    const existing = await createProfile(db);
    const invalid = await rejectionOf(createAccount(now(), adminId, { ...base, email: "pas-un-email", phone: "123", guestQuota: -1, dailyRequestLimit: 0 }));
    expect(invalid.details).toMatchObject({
      email: "Adresse email invalide",
      phone: "Numéro de téléphone invalide",
      guestQuota: expect.any(String),
      dailyRequestLimit: expect.any(String),
    });
    const taken = await rejectionOf(createAccount(now(), adminId, { ...base, email: existing.email.toUpperCase() }));
    expect(taken.details).toMatchObject({ email: "Cette adresse est déjà associée à un compte MAAQ." });
  });

  it("RF4 : crée le compte en attente d'activation et envoie le lien", async () => {
    const email = `elise-${Date.now()}@maaq.test`;
    const { accountId } = await createAccount(now(), adminId, { ...base, email });
    const account = await getAccount(now(), accountId);
    expect(account).toMatchObject({ status: "activation_pending", guestQuota: 2, dailyRequestLimit: 50, phone: "+33611223344", guests: 0 });
    expect(account.activationLink).toMatchObject({ expired: false });

    const [mail] = await messagesTo(email);
    expect(mail.subject).toBe("Activez votre compte MAAQ");
    expect(mail.text).toMatch(/\/activation\?jeton=/);
    expect((await listAccounts(now(), "Roy")).map((a) => a.id)).toContain(accountId);
  });

  it("RF5 : l'activation accepte les textes, fixe le mot de passe et ouvre la session", async () => {
    const email = `activation-${Date.now()}@maaq.test`;
    const { accountId } = await createAccount(now(), adminId, { ...base, email });
    const token = (await messagesTo(email))[0].text.match(/jeton=([\w-]+)/)![1];

    expect(await inspectActivation(now(), token)).toMatchObject({ kind: "valid", firstName: "Élise" });
    const input = { token, accepted: true, password: "Activation-2026", confirmation: "Activation-2026", timezone: "Europe/Paris", userAgent: null };
    expect(await activate(now(), { ...input, accepted: false })).toEqual({ kind: "not_accepted" });
    expect(await activate(now(), { ...input, password: "court", confirmation: "court" })).toEqual({ kind: "weak" });
    expect(await activate(now(), { ...input, confirmation: "Autre-2026xx" })).toEqual({ kind: "mismatch" });

    const result = await activate(now(), input);
    if (result.kind !== "session") throw new Error("session attendue");
    const session = await getSession(now(), result.token);
    expect(session?.user).toMatchObject({ role: "primary_user", setupCompleted: false });
    expect((await getAccount(now(), accountId)).status).toBe("active");
    const accepted = await db.selectFrom("legal_acceptances").select("version_id").where("user_id", "=", session!.user.id).execute();
    expect(accepted.length).toBeGreaterThanOrEqual(2);

    // Usage unique (RT2).
    expect(await activate(now(), input)).toMatchObject({ kind: "used" });
  });

  it("RF6 : un lien expiré ou remplacé n'active plus le compte", async () => {
    const email = `expire-${Date.now()}@maaq.test`;
    const { accountId } = await createAccount(now(), adminId, { ...base, email });
    const firstToken = (await messagesTo(email))[0].text.match(/jeton=([\w-]+)/)![1];
    expect(await inspectActivation({ db, now: minutesLater(new Date(), 31) }, firstToken)).toMatchObject({ kind: "expired", linkKind: "account_activation" });

    await resendActivation(now(), adminId, accountId);
    const mails = await messagesTo(email);
    expect(mails).toHaveLength(2);
    const secondToken = mails[0].text.match(/jeton=([\w-]+)/)![1];
    expect(await inspectActivation(now(), firstToken)).toMatchObject({ kind: "expired" });
    expect(await inspectActivation(now(), secondToken)).toMatchObject({ kind: "valid" });
  });
});

describe("US-69 — plafond quotidien de demandes", () => {
  it("RF2-RF4 : valeur entière ≥ 1, modification journalisée avec l'ancienne et la nouvelle valeur", async () => {
    const email = `plafond-${Date.now()}@maaq.test`;
    const { accountId } = await createAccount(now(), adminId, { firstName: "Paul", lastName: "Plafond", email, phone: "", guestQuota: 1, dailyRequestLimit: 50 });
    expect((await rejectionOf(updateDailyLimit(now(), adminId, accountId, 0))).code).toBe("invalid_limit");
    expect((await rejectionOf(updateDailyLimit(now(), adminId, accountId, 2.5))).code).toBe("invalid_limit");

    await updateDailyLimit(now(), adminId, accountId, 80);
    await updateDailyLimit(now(), adminId, accountId, 80); // même valeur : rien de plus
    const account = await getAccount(now(), accountId);
    expect(account.dailyRequestLimit).toBe(80);
    expect(account.limitHistory).toMatchObject([{ before: 50, after: 80, admin: "Camille Test" }]);
  });
});

describe("US-48 — contrats obligatoires", () => {
  it("RF2-RF4 : ajoute, refuse un doublon, renomme, déplace et retire", async () => {
    const suffix = Date.now();
    const a = await addContract(now(), adminId, `Assurance voyage ${suffix}`);
    const b = await addContract(now(), adminId, `Prévoyance ${suffix}`);
    expect((await rejectionOf(addContract(now(), adminId, `ASSURANCE VOYAGE ${suffix}`))).code).toBe("duplicate_name");

    await renameContract(now(), adminId, a, `Assurance voyages ${suffix}`);
    let names = (await listContracts(now())).map((c) => c.name);
    expect(names.indexOf(`Assurance voyages ${suffix}`)).toBeLessThan(names.indexOf(`Prévoyance ${suffix}`));

    await moveContract(now(), adminId, b, "up");
    names = (await listContracts(now())).map((c) => c.name);
    expect(names.indexOf(`Prévoyance ${suffix}`)).toBeLessThan(names.indexOf(`Assurance voyages ${suffix}`));

    await archiveContract(now(), adminId, a);
    expect((await listContracts(now())).map((c) => c.id)).not.toContain(a);
    // Un contrat retiré libère son nom.
    await addContract(now(), adminId, `Assurance voyages ${suffix}`);
  });

  it("RF10 : définit les champs, dont une liste de choix", async () => {
    const id = await addContract(now(), adminId, `Assurance scolaire ${Date.now()}`);
    await addContractField(now(), adminId, id, { label: "Numéro de police", type: "text", required: true, options: [] });
    expect((await rejectionOf(addContractField(now(), adminId, id, { label: "Formule", type: "choice", required: false, options: ["Seule"] }))).code).toBe(
      "invalid_options",
    );
    await addContractField(now(), adminId, id, { label: "Formule", type: "choice", required: false, options: ["Base", "Confort", "Base"] });
    expect((await rejectionOf(addContractField(now(), adminId, id, { label: "numéro de police", type: "text", required: false, options: [] }))).code).toBe(
      "duplicate_label",
    );

    let fields = (await getContractFields(now(), id)).fields;
    expect(fields).toMatchObject([
      { label: "Numéro de police", type: "text", required: true, options: [] },
      { label: "Formule", type: "choice", required: false, options: ["Base", "Confort"] },
    ]);
    await archiveContractField(now(), adminId, id, fields[0].id);
    fields = (await getContractFields(now(), id)).fields;
    expect(fields.map((f) => f.label)).toEqual(["Formule"]);
  });
});

describe("US-65 — paramètres de la plateforme", () => {
  it("RF2 : contrôle les valeurs selon leur type et leurs bornes", async () => {
    const settings = await listSettings(now());
    const sync = settings.find((s) => s.key === "logbook_sync_interval_hours")!;
    const alert = settings.find((s) => s.key === "alert_email")!;
    expect(validateSetting(sync, "0")).toMatch(/au moins 1/);
    expect(validateSetting(sync, "25")).toMatch(/au plus 24/);
    expect(validateSetting(sync, "3.5")).toBe("Indiquez un nombre entier.");
    expect(validateSetting(sync, "6")).toBeNull();
    expect(validateSetting(alert, "pas-un-email")).toBe("Adresse email invalide");
    expect(validateSetting(alert, "")).toBeNull();
  });

  it("RF4, RF6 : enregistre tout ou rien, et trace chaque modification", async () => {
    const invalid = await rejectionOf(updateSettings(now(), adminId, { logbook_sync_interval_hours: "6", alert_email: "faux" }));
    expect(invalid.details).toEqual({ alert_email: "Adresse email invalide" });
    expect((await listSettings(now())).find((s) => s.key === "logbook_sync_interval_hours")!.value).toBe("5");

    expect(await updateSettings(now(), adminId, { logbook_sync_interval_hours: "6", alert_email: "alertes@maaq.test" })).toBe(2);
    expect(await updateSettings(now(), adminId, { logbook_sync_interval_hours: "6" })).toBe(0);
    const history = await settingHistory(now());
    expect(history.slice(0, 2).map((h) => [h.key, h.before, h.after]).sort()).toEqual([
      ["alert_email", null, "alertes@maaq.test"],
      ["logbook_sync_interval_hours", "5", "6"],
    ]);
  });
});

describe("CC-7 — pas de double exécution", () => {
  it("une même clé d'idempotence n'exécute l'action qu'une fois et rend la même réponse", async () => {
    let runs = 0;
    const action = async () => {
      runs += 1;
      return Response.json({ run: runs }, { status: 201 });
    };
    const request = () => new Request("http://localhost/api/admin/contracts", { method: "POST", headers: { "Idempotency-Key": "cle-de-test-123" } });
    const first = await idempotent(now(), request(), adminId, action);
    const second = await idempotent(now(), request(), adminId, action);
    expect(runs).toBe(1);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());
  });
});
