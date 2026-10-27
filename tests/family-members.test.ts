import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEvent, updateEvent } from "@/server/assistant/events";
import { addChild, eraseMember, familyOverview, listFamilyMembers, loadPseudoMembers, MAX_MEMBERS, removeMember, updateMember } from "@/server/assistant/family";
import { randomBytes } from "node:crypto";
import { seal } from "@/server/assistant/fields";
import { Pseudonymizer } from "@/server/assistant/pseudonymize";
import type { Ctx } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { createGuest, createProfile, sessionFor, testDb } from "./helpers/fixtures";

let db: Kysely<DB>;
beforeAll(() => {
  db = testDb();
});
afterAll(async () => {
  await db.destroy();
});

const NOW = new Date("2054-11-02T08:00:00Z");
// La base n'existe qu'une fois beforeAll passé : on la lit au moment de l'appel.
const ctx = { get db() { return db; }, now: NOW } as Ctx;

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

/** Foyer : Camille (principale), Julien (invité core), Élodie (invitée secondaire). Aucun enfant déclaré. */
async function family() {
  const primary = await createProfile(db);
  await db.updateTable("users").set({ first_name: "Camille" }).where("id", "=", primary.id).execute();
  const julien = await createGuest(db, primary.accountId!, "Julien", "core");
  const elodie = await createGuest(db, primary.accountId!, "Élodie");
  return {
    accountId: primary.accountId!,
    camilleId: primary.id,
    camille: await sessionFor(db, primary.id),
    julien: await sessionFor(db, julien.id),
    elodie: await sessionFor(db, elodie.id),
  };
}
type Family = Awaited<ReturnType<typeof family>>;

/** Rendez-vous inséré directement : à venir (le 10 novembre) par défaut. */
async function seedEvent(f: Family, members: string[], over: { status?: "provisional" | "confirmed" | "cancelled"; start?: string; allFamily?: boolean } = {}): Promise<string> {
  const start = new Date(over.start ?? "2054-11-10T15:00:00Z");
  const status = over.status ?? "confirmed";
  const type = await db.selectFrom("event_types").select("id").where("code", "=", "personal").executeTakeFirstOrThrow();
  const row = await db
    .insertInto("family_events")
    .values({
      account_id: f.accountId, event_type_id: type.id, title: seal("Judo"), starts_at: start, ends_at: new Date(start.getTime() + 3_600_000), all_day: false,
      status, source: "chat_text", whole_family: over.allFamily ?? false, requested_by_user_id: f.camilleId, fingerprint: randomBytes(16),
      confirmed_at: status === "provisional" ? null : NOW, confirmed_by_user_id: status === "provisional" ? null : f.camilleId,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  if (members.length) await db.insertInto("family_event_members").values(members.map((m) => ({ event_id: row.id, member_id: m, account_id: f.accountId }))).execute();
  return row.id;
}

describe("liste des membres (US-92)", () => {
  it("fait figurer les parents d'office, avec leur badge et une couleur chacun (CA 1.1, 2.1, 6.1)", async () => {
    const f = await family();
    const { members, removed, max } = await familyOverview(ctx, f.camille);
    expect(members.map((m) => [m.firstName, m.badge, m.linked])).toEqual([["Camille", "primary", true], ["Julien", "guest", true]]);
    expect(members[0].isYou).toBe(true);
    expect(new Set(members.map((m) => m.color)).size).toBe(2);
    expect(removed).toEqual([]);
    expect(max).toBe(12);
    const leo = await addChild(ctx, f.julien, { firstName: "Léo", birth: "2046-03" }); // l'invité core peut ajouter (CA 3.1)
    expect(leo).toMatchObject({ firstName: "Léo", role: "child", birth: "2046-03", badge: null, linked: false, upcoming: 0 });
    expect(new Set((await listFamilyMembers(ctx, f.camille)).map((m) => m.color)).size).toBe(3);
  });

  it("réserve la liste et les changements aux deux parents (CA 3.2, US-93 CA 1.1)", async () => {
    const f = await family();
    const leo = await addChild(ctx, f.camille, { firstName: "Léo" });
    for (const attempt of [listFamilyMembers(ctx, f.elodie), addChild(ctx, f.elodie, { firstName: "Mia" }), updateMember(ctx, f.elodie, leo.id, { firstName: "Léon" }), removeMember(ctx, f.elodie, leo.id), eraseMember(ctx, f.elodie, leo.id)]) {
      expect((await failure(attempt)).status).toBe(403);
    }
    expect((await listFamilyMembers(ctx, f.camille)).map((m) => m.firstName)).toContain("Léo");
  });

  it("ne mélange pas les familles", async () => {
    const f = await family();
    const other = await family();
    const leo = await addChild(ctx, f.camille, { firstName: "Léo" });
    expect((await failure(updateMember(ctx, other.camille, leo.id, { firstName: "Léon" }))).status).toBe(404);
    expect((await failure(removeMember(ctx, other.camille, leo.id))).status).toBe(404);
    expect((await failure(eraseMember(ctx, other.camille, leo.id))).status).toBe(404);
  });
});

describe("ajout d'un membre (US-92)", () => {
  it("accepte un prénom seul : date de naissance facultative, rôle enfant, aucune invitation créée (CA 4.2, 4.4, 8.1)", async () => {
    const f = await family();
    const invitesBefore = await db.selectFrom("users").select("id").where("account_id", "=", f.accountId).execute();
    const mia = await addChild(ctx, f.camille, { firstName: "  Mia  " });
    expect(mia).toMatchObject({ firstName: "Mia", birth: null, role: "child" });
    expect(await db.selectFrom("users").select("id").where("account_id", "=", f.accountId).execute()).toHaveLength(invitesBefore.length);
  });

  it("refuse un prénom vide ou de plus de 30 caractères", async () => {
    const f = await family();
    expect((await failure(addChild(ctx, f.camille, { firstName: "   " }))).code).toBe("invalid_name");
    expect((await failure(addChild(ctx, f.camille, { firstName: "A".repeat(31) }))).code).toBe("invalid_name");
    expect((await addChild(ctx, f.camille, { firstName: "B".repeat(30) })).firstName).toHaveLength(30);
  });

  it("refuse un prénom déjà porté, sans tenir compte des majuscules, et avec le message du BA (CA 5.1)", async () => {
    const f = await family();
    await addChild(ctx, f.camille, { firstName: "Léo" });
    const refused = await failure(addChild(ctx, f.julien, { firstName: " léo " }));
    expect(refused).toMatchObject({ code: "name_taken", status: 409, message: "Un membre porte déjà ce prénom. Ajoutez une initiale pour les distinguer." });
    expect((await failure(addChild(ctx, f.camille, { firstName: "Camille" }))).code).toBe("name_taken"); // un parent compte aussi
    expect((await addChild(ctx, f.camille, { firstName: "Léo B." })).firstName).toBe("Léo B.");
  });

  it("refuse une date de naissance dans le futur ou invraisemblable (CA 4.3)", async () => {
    const f = await family();
    expect(await failure(addChild(ctx, f.camille, { firstName: "Léo", birth: "2054-12" }))).toMatchObject({ code: "invalid_birth_date", message: "La date de naissance ne peut pas être dans le futur." });
    expect((await failure(addChild(ctx, f.camille, { firstName: "Léo", birth: "1850-01" }))).code).toBe("invalid_birth_date");
    expect((await failure(addChild(ctx, f.camille, { firstName: "Léo", birth: "2046-13" }))).code).toBe("invalid_birth_date");
    expect((await addChild(ctx, f.camille, { firstName: "Léo", birth: "2054-11" })).birth).toBe("2054-11"); // né ce mois-ci
  });

  it("plafonne à 12 membres actifs et réattribue la couleur d'un membre retiré (CA 7.1, US-93 CA 9.1)", async () => {
    const f = await family();
    const added = [];
    for (let i = 1; i <= MAX_MEMBERS - 2; i++) added.push(await addChild(ctx, f.camille, { firstName: `Enfant${i}` }));
    const colors = (await listFamilyMembers(ctx, f.camille)).map((m) => m.color);
    expect(colors).toHaveLength(12);
    expect(new Set(colors).size).toBe(12);
    expect(await failure(addChild(ctx, f.camille, { firstName: "Treizième" }))).toMatchObject({ code: "member_limit", status: 409, message: "Nombre maximal de membres atteint (12)." });

    await removeMember(ctx, f.camille, added[3].id);
    const replacement = await addChild(ctx, f.camille, { firstName: "Remplaçant" });
    const now = (await listFamilyMembers(ctx, f.camille)).map((m) => m.color);
    expect(new Set(now).size).toBe(12); // distincte des 11 autres
    expect(replacement.color).toBe(added[3].color);
  });
});

describe("modification d'un membre (US-93)", () => {
  it("modifie le prénom et la date d'un membre sans compte, avec les mêmes contrôles que l'ajout (CA 2.1, 2.2)", async () => {
    const f = await family();
    const leo = await addChild(ctx, f.camille, { firstName: "Léo", birth: "2046-03" });
    await addChild(ctx, f.camille, { firstName: "Mia" });
    expect(await updateMember(ctx, f.julien, leo.id, { birth: "2046-04" })).toMatchObject({ firstName: "Léo", birth: "2046-04" });
    expect(await updateMember(ctx, f.camille, leo.id, { firstName: "Léonard", birth: null })).toMatchObject({ firstName: "Léonard", birth: null });
    expect((await failure(updateMember(ctx, f.camille, leo.id, { firstName: "mia" }))).code).toBe("name_taken");
    expect((await failure(updateMember(ctx, f.camille, leo.id, { firstName: "" }))).code).toBe("invalid_name");
    expect((await failure(updateMember(ctx, f.camille, leo.id, { birth: "2058-01" }))).code).toBe("invalid_birth_date");
    expect(await updateMember(ctx, f.camille, leo.id, { firstName: "Léonard" })).toMatchObject({ firstName: "Léonard" }); // son propre prénom n'est pas un doublon
  });

  it("n'autorise que la date de naissance pour un membre relié à un profil, dont le prénom suit le profil (CA 3.1)", async () => {
    const f = await family();
    const julien = (await listFamilyMembers(ctx, f.camille)).find((m) => m.firstName === "Julien")!;
    expect((await failure(updateMember(ctx, f.camille, julien.id, { firstName: "Jules" }))).code).toBe("linked_member");
    expect(await updateMember(ctx, f.camille, julien.id, { firstName: "Julien", birth: "1985-05" })).toMatchObject({ firstName: "Julien", birth: "1985-05" });
    await db.updateTable("users").set({ first_name: "Jules" }).where("account_id", "=", f.accountId).where("guest_rank", "=", "core").execute();
    expect((await listFamilyMembers(ctx, f.camille)).map((m) => m.firstName)).toContain("Jules");
  });

  it("montre le nouveau prénom sur les rendez-vous passés et à venir (CA 4.1)", async () => {
    const f = await family();
    const leo = await addChild(ctx, f.camille, { firstName: "Léo" });
    const past = await seedEvent(f, [leo.id], { start: "2054-10-01T15:00:00Z" });
    const upcoming = await seedEvent(f, [leo.id]);
    await updateMember(ctx, f.camille, leo.id, { firstName: "Léonard" });
    for (const id of [past, upcoming]) expect((await getEvent(ctx, f.camille, id)).members.map((m) => m.firstName)).toEqual(["Léonard"]);
  });
});

describe("retrait d'un membre (US-93)", () => {
  it("compte les rendez-vous à venir pour la confirmation, sans les passés ni les annulés (CA 5.1)", async () => {
    const f = await family();
    const hugo = await addChild(ctx, f.camille, { firstName: "Hugo" });
    await seedEvent(f, [hugo.id]);
    await seedEvent(f, [hugo.id], { status: "provisional" });
    await seedEvent(f, [hugo.id], { status: "cancelled" });
    await seedEvent(f, [hugo.id], { start: "2054-10-01T15:00:00Z" });
    expect((await listFamilyMembers(ctx, f.camille)).find((m) => m.id === hugo.id)!.upcoming).toBe(2);
  });

  it("archive le membre : absent des listes, mais ses rendez-vous gardent son prénom (CA 6.1, 6.2)", async () => {
    const f = await family();
    const hugo = await addChild(ctx, f.camille, { firstName: "Hugo" });
    const leo = await addChild(ctx, f.camille, { firstName: "Léo" });
    const id = await seedEvent(f, [hugo.id, leo.id]);
    await removeMember(ctx, f.julien, hugo.id);

    const overview = await familyOverview(ctx, f.camille);
    expect(overview.members.map((m) => m.firstName)).not.toContain("Hugo");
    expect(overview.removed.map((m) => m.firstName)).toEqual(["Hugo"]);
    expect(overview.removed[0].removedAt).toBe(NOW.toISOString());
    expect((await getEvent(ctx, f.camille, id)).members.map((m) => m.firstName).sort()).toEqual(["Hugo", "Léo"]);

    // Plus proposé pour un rendez-vous, mais il peut rester sur celui où il figure déjà.
    const form = (memberIds: string[]) => ({ title: "Judo", type: "personal" as const, allFamily: false, memberIds, start: "2054-11-10T16:00", end: "2054-11-10T17:00", allDay: false });
    const other = await seedEvent(f, [leo.id], { start: "2054-11-12T15:00:00Z" });
    const refused = await failure(updateEvent(ctx, f.camille, other, form([leo.id, hugo.id]), { expectedVersion: 1 }));
    expect(refused.code).toBe("invalid_members");
    const kept = await updateEvent(ctx, f.camille, id, form([leo.id, hugo.id]), { expectedVersion: 1 });
    expect(kept.members.map((m) => m.firstName).sort()).toEqual(["Hugo", "Léo"]);
  });

  it("n'inclut pas le membre retiré dans « toute la famille »", async () => {
    const f = await family();
    const hugo = await addChild(ctx, f.camille, { firstName: "Hugo" });
    const id = await seedEvent(f, [], { allFamily: true });
    expect((await getEvent(ctx, f.camille, id)).members.map((m) => m.firstName)).toContain("Hugo");
    await removeMember(ctx, f.camille, hugo.id);
    expect((await getEvent(ctx, f.camille, id)).members.map((m) => m.firstName)).not.toContain("Hugo");
  });

  it("n'est plus reconnu par l'assistant, mais son alias reste traduit dans les textes existants (CA 6.1)", async () => {
    const f = await family();
    const hugo = await addChild(ctx, f.camille, { firstName: "Hugo" });
    await addChild(ctx, f.camille, { firstName: "Léo" });
    await removeMember(ctx, f.camille, hugo.id);
    const pseudo = new Pseudonymizer(await loadPseudoMembers(db, f.accountId));
    expect(pseudo.active.map((m) => m.firstName).sort()).toEqual(["Camille", "Julien", "Léo"]);
    expect(pseudo.resolve("Enfant 1")).toBeNull(); // le modèle ne peut plus rattacher un rendez-vous à Hugo
    expect(pseudo.resolve("Enfant 2")?.firstName).toBe("Léo");
    expect(pseudo.fromModel("Enfant 1 a un rendez-vous")).toBe("Hugo a un rendez-vous"); // un ancien message reste lisible
    expect(pseudo.toModel("Hugo et Léo")).toBe("Enfant 1 et Enfant 2"); // et le prénom ne part jamais en clair
  });

  it("ne restaure pas un membre retiré : un nouveau membre du même prénom est un autre membre (CA 8.1)", async () => {
    const f = await family();
    const hugo = await addChild(ctx, f.camille, { firstName: "Hugo" });
    const old = await seedEvent(f, [hugo.id], { start: "2054-10-01T15:00:00Z" });
    await removeMember(ctx, f.camille, hugo.id);
    const again = await addChild(ctx, f.camille, { firstName: "Hugo" });
    expect(again.id).not.toBe(hugo.id);
    expect((await getEvent(ctx, f.camille, old)).members.map((m) => m.id)).toEqual([hugo.id]);
    const pseudo = new Pseudonymizer(await loadPseudoMembers(db, f.accountId));
    expect(pseudo.toModel("Hugo")).toBe("Enfant 2"); // le prénom désigne le membre actif
    expect(pseudo.warnings).toEqual([]);
    expect((await failure(removeMember(ctx, f.camille, hugo.id))).status).toBe(404); // déjà retiré
    expect((await failure(updateMember(ctx, f.camille, hugo.id, { firstName: "Hugo B." }))).status).toBe(404);
  });

  it("ne retire pas un membre relié à un profil (CA 7.1)", async () => {
    const f = await family();
    const julien = (await listFamilyMembers(ctx, f.camille)).find((m) => m.firstName === "Julien")!;
    expect((await failure(removeMember(ctx, f.camille, julien.id))).code).toBe("linked_member");
    expect((await failure(eraseMember(ctx, f.camille, julien.id))).code).toBe("linked_member");
    expect((await listFamilyMembers(ctx, f.camille)).map((m) => m.firstName)).toContain("Julien");
  });
});

describe("effacement définitif (D34, US-93 RF13)", () => {
  it("supprime les rendez-vous du seul membre et anonymise ceux qu'il partage (CA 13.1)", async () => {
    const f = await family();
    const hugo = await addChild(ctx, f.camille, { firstName: "Hugo", birth: "2047-04" });
    const leo = await addChild(ctx, f.camille, { firstName: "Léo" });
    const alone = await seedEvent(f, [hugo.id]);
    const shared = await seedEvent(f, [hugo.id, leo.id]);
    const family_ = await seedEvent(f, [], { allFamily: true });
    expect(await eraseMember(ctx, f.camille, hugo.id)).toEqual({ deletedEvents: 1 });

    expect(await db.selectFrom("family_events").select("id").where("id", "=", alone).execute()).toEqual([]);
    expect(await db.selectFrom("family_event_history").select("id").where("event_id", "=", alone).execute()).toEqual([]);
    expect((await getEvent(ctx, f.camille, shared)).members.map((m) => m.firstName).sort()).toEqual(["Ancien membre", "Léo"]);
    await getEvent(ctx, f.camille, family_); // « toute la famille » n'est pas touché

    const row = await db.selectFrom("family_members").selectAll().where("id", "=", hugo.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ first_name: null, birth_year: null, birth_month: null, user_id: null });
    expect(row.anonymized_at).not.toBeNull();
    expect(row.archived_at).not.toBeNull();
    const overview = await familyOverview(ctx, f.camille);
    expect([...overview.members, ...overview.removed].map((m) => m.id)).not.toContain(hugo.id);
  });

  it("efface aussi un membre déjà retiré, une seule fois (CA 13.2)", async () => {
    const f = await family();
    const hugo = await addChild(ctx, f.camille, { firstName: "Hugo" });
    await removeMember(ctx, f.camille, hugo.id);
    expect((await familyOverview(ctx, f.camille)).removed.map((m) => m.firstName)).toEqual(["Hugo"]);
    expect(await eraseMember(ctx, f.julien, hugo.id)).toEqual({ deletedEvents: 0 });
    expect((await familyOverview(ctx, f.camille)).removed).toEqual([]);
    expect((await failure(eraseMember(ctx, f.camille, hugo.id))).status).toBe(404);
  });

  it("ne laisse plus le prénom effacé dans les textes envoyés au modèle", async () => {
    const f = await family();
    const hugo = await addChild(ctx, f.camille, { firstName: "Hugo" });
    await eraseMember(ctx, f.camille, hugo.id);
    const pseudo = new Pseudonymizer(await loadPseudoMembers(db, f.accountId));
    expect(pseudo.toModel("Hugo est venu")).toBe("Hugo est venu"); // il n'est plus un membre : le texte de l'utilisateur est inchangé
    expect(pseudo.toModel("Ancien membre")).toBe("Ancien membre");
    expect(pseudo.resolve("Enfant 1")).toBeNull();
  });
});
