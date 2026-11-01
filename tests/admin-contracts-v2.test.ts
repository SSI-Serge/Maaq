import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  addContract,
  addDocumentField,
  archiveContract,
  deleteContract,
  getDocumentFields,
  listContracts,
  moveDocumentField,
  removeDocumentField,
  updateDocumentField,
} from "@/server/admin/contracts";
import { listSettings, updateSettings, validateSetting } from "@/server/admin/settings";
import type { Ctx } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { createProfile, testDb } from "./helpers/fixtures";

let db: Kysely<DB>;
let adminId: string;
beforeAll(async () => {
  db = testDb();
  adminId = (await createProfile(db, { role: "admin" })).id;
});
afterAll(async () => {
  await db.destroy();
});

const ctx = () => ({ db, now: new Date() }) as Ctx;
const unique = () => `Catégorie ${Math.random().toString(36).slice(2, 8)}`;

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

/** Dépose un document dans un champ pour un contrat de base (comme le fera la page Contrats). */
async function deposit(categoryId: string, fieldId: string) {
  const profile = await createProfile(db);
  await sql`select ensure_base_contracts(${profile.accountId}::uuid, ${profile.id}::uuid)`.execute(db);
  const contract = await db.selectFrom("account_contracts").select("id").where("account_id", "=", profile.accountId!).where("contract_definition_id", "=", categoryId).executeTakeFirstOrThrow();
  await db
    .insertInto("contract_field_documents")
    .values({ account_contract_id: contract.id, field_id: fieldId, source_kind: "pdf", page_count: 2, size_bytes: 1000, file_name: Buffer.from("x"), storage_key: `test/${Math.random()}`, uploaded_by_user_id: profile.id, expires_at: new Date(Date.now() + 86_400_000) })
    .execute();
  return { profile, contractId: contract.id };
}

describe("champs de documents d'une catégorie (US-122, US-123)", () => {
  it("ajout : obligatoire par défaut, ordre, aide ; la liste dit combien de documents y sont déposés", async () => {
    const category = await addContract(ctx(), adminId, unique());
    const first = await addDocumentField(ctx(), adminId, category, { name: "Conditions particulières", help: "La page qui indique vos garanties et votre franchise" });
    const second = await addDocumentField(ctx(), adminId, category, { name: "Avis d'échéance", required: false });
    const fields = await getDocumentFields(ctx(), category);
    expect(fields.fields.map((f) => [f.name, f.required, f.used])).toEqual([["Conditions particulières", true, 0], ["Avis d'échéance", false, 0]]);
    expect(fields.fields[0].help).toContain("garanties");
    expect(fields.archived).toBe(false);
    expect(first).not.toBe(second);
    expect((await listContracts(ctx())).find((c) => c.id === category)).toMatchObject({ documentFields: 2, contracts: 0, accounts: 0, archivedAt: null });
  });

  it("CA 1.2 : un nom en double, sans tenir compte des majuscules, est refusé ; nom vide ou trop long aussi", async () => {
    const category = await addContract(ctx(), adminId, unique());
    await addDocumentField(ctx(), adminId, category, { name: "Attestation" });
    expect(await failure(addDocumentField(ctx(), adminId, category, { name: "attestation" }))).toMatchObject({ code: "duplicate_name", message: "Ce nom existe déjà dans la catégorie." });
    expect((await failure(addDocumentField(ctx(), adminId, category, { name: "  " }))).code).toBe("invalid_name");
    expect((await failure(addDocumentField(ctx(), adminId, category, { name: "x".repeat(81) }))).code).toBe("invalid_name");
    expect((await failure(addDocumentField(ctx(), adminId, category, { name: "Autre", help: "y".repeat(201) }))).code).toBe("invalid_help");
  });

  it("10 champs au plus par catégorie", async () => {
    const category = await addContract(ctx(), adminId, unique());
    for (let i = 1; i <= 10; i++) await addDocumentField(ctx(), adminId, category, { name: `Document ${i}` });
    expect(await failure(addDocumentField(ctx(), adminId, category, { name: "Document 11" }))).toMatchObject({ code: "too_many_fields", message: "10 champs au plus par catégorie." });
  });

  it("US-123 RF4 : une catégorie garde au moins un champ obligatoire (ajout, passage en facultatif, retrait)", async () => {
    const category = await addContract(ctx(), adminId, unique());
    expect((await failure(addDocumentField(ctx(), adminId, category, { name: "Seul champ", required: false }))).message).toBe("Une catégorie doit avoir au moins un document obligatoire.");
    const only = await addDocumentField(ctx(), adminId, category, { name: "Conditions" });
    const optional = await addDocumentField(ctx(), adminId, category, { name: "Annexe", required: false });
    expect((await failure(updateDocumentField(ctx(), adminId, category, only, { required: false }))).message).toBe("Une catégorie doit avoir au moins un document obligatoire.");
    expect((await failure(removeDocumentField(ctx(), adminId, category, only))).message).toBe("Une catégorie doit avoir au moins un document obligatoire.");
    // Le champ est resté, obligatoire.
    expect((await getDocumentFields(ctx(), category)).fields.map((f) => [f.name, f.required])).toEqual([["Conditions", true], ["Annexe", false]]);
    // Passer l'autre en obligatoire puis libérer le premier : permis.
    await updateDocumentField(ctx(), adminId, category, optional, { required: true });
    await updateDocumentField(ctx(), adminId, category, only, { required: false });
    expect((await getDocumentFields(ctx(), category)).fields.map((f) => f.required)).toEqual([false, true]);
  });

  it("RF6 : renommer ou changer l'aide ne touche pas aux documents ; RF5 : retirer un champ supprime ses documents et dit combien", async () => {
    const category = await addContract(ctx(), adminId, unique());
    const field = await addDocumentField(ctx(), adminId, category, { name: "Conditions" });
    await addDocumentField(ctx(), adminId, category, { name: "Annexe", required: false });
    const a = await deposit(category, field);
    await deposit(category, field);
    await updateDocumentField(ctx(), adminId, category, field, { name: "Conditions particulières", help: "Première page" });
    expect((await getDocumentFields(ctx(), category)).fields[0]).toMatchObject({ name: "Conditions particulières", help: "Première page", used: 2 });
    const docsBefore = await db.selectFrom("contract_field_documents").select("storage_key").where("field_id", "=", field).execute();
    // Le champ est le seul obligatoire : on rend l'autre obligatoire avant de le retirer.
    const other = (await getDocumentFields(ctx(), category)).fields[1].id;
    await updateDocumentField(ctx(), adminId, category, other, { required: true });
    expect(await removeDocumentField(ctx(), adminId, category, field)).toEqual({ deletedDocuments: 2 });
    expect(await db.selectFrom("contract_field_documents").select("id").where("account_contract_id", "=", a.contractId).execute()).toEqual([]);
    // Les fichiers partent à la file de suppression du stockage.
    const queued = await db.selectFrom("storage_deletion_queue").select("storage_key").where("storage_key", "in", docsBefore.map((d) => d.storage_key)).execute();
    expect(queued).toHaveLength(2);
  });

  it("déplace un champ ; le journal d'administration garde chaque modification", async () => {
    const category = await addContract(ctx(), adminId, unique());
    await addDocumentField(ctx(), adminId, category, { name: "A" });
    const b = await addDocumentField(ctx(), adminId, category, { name: "B", required: false });
    await moveDocumentField(ctx(), adminId, category, b, "up");
    expect((await getDocumentFields(ctx(), category)).fields.map((f) => f.name)).toEqual(["B", "A"]);
    const log = await db.selectFrom("admin_audit_log").select(["action_type", "details"]).where("action_type", "=", "contract_document_field_changed").execute();
    expect(log.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(log)).toContain("moved");
  });
});

describe("archivage et suppression d'une catégorie (US-139, C-19)", () => {
  it("une catégorie sans contrat se supprime avec ses champs", async () => {
    const category = await addContract(ctx(), adminId, unique());
    await addDocumentField(ctx(), adminId, category, { name: "Conditions" });
    await deleteContract(ctx(), adminId, category);
    expect((await listContracts(ctx())).some((c) => c.id === category)).toBe(false);
    expect(await db.selectFrom("contract_document_fields").select("id").where("contract_definition_id", "=", category).execute()).toEqual([]);
  });

  it("une catégorie qui contient des contrats ne se supprime pas : la base refuse, elle s'archive, ses contrats restent en lecture", async () => {
    const category = await addContract(ctx(), adminId, unique());
    const field = await addDocumentField(ctx(), adminId, category, { name: "Conditions" });
    const { contractId } = await deposit(category, field);
    expect((await failure(deleteContract(ctx(), adminId, category))).message).toMatch(/s'archive, elle ne se supprime pas/);
    expect((await listContracts(ctx())).find((c) => c.id === category)).toMatchObject({ contracts: 1, accounts: 1, archivedAt: null });

    await archiveContract(ctx(), adminId, category);
    const listed = await listContracts(ctx());
    const archived = listed.find((c) => c.id === category)!;
    expect(archived.archivedAt).not.toBeNull();
    expect(archived).toMatchObject({ contracts: 1, accounts: 1 });
    // Les archivées viennent après les catégories proposées.
    expect(listed.findIndex((c) => c.archivedAt === null && c.id !== category)).toBeLessThan(listed.findIndex((c) => c.id === category));
    expect(await db.selectFrom("account_contracts").select("id").where("id", "=", contractId).execute()).toHaveLength(1);
  });

  it("catégorie archivée : ses champs ne se modifient plus, plus de nouveau contrat ni de dépôt (garanties de la base)", async () => {
    const category = await addContract(ctx(), adminId, unique());
    const field = await addDocumentField(ctx(), adminId, category, { name: "Conditions" });
    const { profile } = await deposit(category, field);
    await archiveContract(ctx(), adminId, category);
    expect((await failure(addDocumentField(ctx(), adminId, category, { name: "Autre" }))).code).toBe("category_archived");
    expect((await failure(updateDocumentField(ctx(), adminId, category, field, { name: "Renommé" }))).code).toBe("category_archived");
    expect((await failure(removeDocumentField(ctx(), adminId, category, field))).code).toBe("category_archived");
    expect((await getDocumentFields(ctx(), category)).archived).toBe(true);
    // Un nouveau contrat dans la catégorie archivée est refusé par la base.
    await expect(
      db.insertInto("account_contracts").values({ account_id: profile.accountId!, contract_definition_id: category, name: "Complémentaire" }).execute(),
    ).rejects.toThrow(/n'est plus proposée/);
    // Un nouvel utilisateur ne reçoit pas de contrat de base dans une catégorie archivée.
    const other = await createProfile(db);
    await sql`select ensure_base_contracts(${other.accountId}::uuid, ${other.id}::uuid)`.execute(db);
    expect(await db.selectFrom("account_contracts").select("id").where("account_id", "=", other.accountId!).where("contract_definition_id", "=", category).execute()).toEqual([]);
  });
});

describe("réglages de la console pour Contrats V2 (US-65, C-08, C-10)", () => {
  it("nom du courtier (texte libre), adresse de sa boîte, plafond, conservation et seuil de lecture sont réglables ; challenge bloqué tant que le courtier est vide", async () => {
    const settings = await listSettings(ctx());
    const byKey = Object.fromEntries(settings.map((s) => [s.key, s]));
    expect(byKey.contract_broker_name.type).toBe("free_text");
    expect(byKey.max_contracts_per_category).toMatchObject({ type: "integer", value: "20" });
    expect(byKey.contract_document_retention_days.value).toBe("30");
    expect(validateSetting(byKey.contract_broker_name, "x".repeat(121))).toBe("120 caractères au plus.");
    expect(validateSetting(byKey.contract_broker_name, "")).toBeNull();
    expect(validateSetting(byKey.contract_broker_email, "pas une adresse")).toBe("Adresse email invalide");
    expect(validateSetting(byKey.contract_read_confidence_threshold_pct, "101")).toMatch(/au plus 100/);
    expect(validateSetting(byKey.contract_read_confidence_threshold_pct, "-1")).toBe("La valeur doit être au moins 0.");
    expect(validateSetting(byKey.contract_read_confidence_threshold_pct, "")).toBe("La valeur doit être au moins 0.");
    expect(validateSetting(byKey.contract_read_confidence_threshold_pct, "12.5")).toBe("Indiquez un nombre entier.");

    const available = async () => (await sql<{ ok: boolean }>`select contract_challenge_available() as ok`.execute(db)).rows[0].ok;
    expect(await available()).toBe(false);
    await updateSettings(ctx(), adminId, { contract_broker_name: "Courtier Exemple", contract_broker_email: "challenge@courtier.test" });
    expect(await available()).toBe(true);
    await updateSettings(ctx(), adminId, { contract_broker_name: "", contract_broker_email: "" });
    expect(await available()).toBe(false);
  });
});
