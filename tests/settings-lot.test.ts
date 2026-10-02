import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MockDigitorn } from "@/server/adapters/digitorn/mock";
import { createSession, getSession, login, type Ctx, type SessionContext } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { actorOf, listAccountDevices, listDevices, revokeDevice } from "@/server/devices/service";
import { Rejection } from "@/server/http";
import { runDueJobs } from "@/server/jobs";
import { getLogbook, listLogbookAgents, PAGE_SIZE, syncLogbook } from "@/server/logbook/service";
import { ensureDigitornRef } from "@/server/profile/digitorn-ref";
import { APP_VERSION, sendSupportMessage } from "@/server/support/service";
import { createProfile, messagesTo, PASSWORD, sessionFor, testDb } from "./helpers/fixtures";

let db: Kysely<DB>;
let mock: MockDigitorn;
let clock = new Date();

beforeAll(() => {
  db = testDb();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(() => {
  clock = new Date();
  mock = new MockDigitorn({ replyDelayMs: 0, executionDelayMs: 0, now: () => clock });
  globalThis.__maaqDigitorn = mock;
});
afterEach(() => {
  vi.restoreAllMocks();
});

const at = (now = new Date()): Ctx => ({ db, now });
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

async function household() {
  const primary = await createProfile(db);
  const guest = async (rank: "core" | "secondary", firstName: string) => {
    const row = await db
      .insertInto("users")
      .values({ account_id: primary.accountId, role: "guest", guest_rank: rank, first_name: firstName, last_name: "Martin", email: `${rank}-${tag()}@maaq.test`, status: "active" })
      .returning(["id", "email"])
      .executeTakeFirstOrThrow();
    return { ...row, session: await sessionFor(db, row.id) };
  };
  return { primary: { ...primary, session: await sessionFor(db, primary.id) }, core: await guest("core", "Thomas"), secondary: await guest("secondary", "Élodie") };
}

async function agent(name = `Agent_${tag()}`) {
  const category = await db.selectFrom("agent_categories").select("id").where("code", "=", "perso").executeTakeFirstOrThrow();
  const row = await db
    .insertInto("agents")
    .values({ digitorn_agent_ref: `lot8-${tag()}${tag()}`, name, category_id: category.id, short_description: "Agent", full_description: "Agent" })
    .returning(["id", "digitorn_agent_ref"])
    .executeTakeFirstOrThrow();
  return { id: row.id, ref: row.digitorn_agent_ref, name };
}

/** Appareil enregistré avec sa session ouverte. */
async function device(userId: string, type: "android" | "iphone" | "desktop" = "android") {
  const id = randomUUID();
  await db.insertInto("devices").values({ id, user_id: userId, device_type: type, browser: "Chrome" }).execute();
  const session = await createSession(db, userId, id, new Date());
  return { id, token: session.token };
}

async function setSetting(key: string, value: string | null) {
  const before = await db.selectFrom("platform_settings").select("value_text").where("setting_key", "=", key).executeTakeFirstOrThrow();
  await db.updateTable("platform_settings").set({ value_text: value }).where("setting_key", "=", key).execute();
  return () => db.updateTable("platform_settings").set({ value_text: before.value_text }).where("setting_key", "=", key).execute();
}

describe("US-53 — appareils et révocation", () => {
  it("RF1, RF6 : l'utilisateur principal voit ses appareils et ceux de ses invités, pas l'inverse", async () => {
    const { primary, core } = await household();
    const mine = await device(primary.id, "iphone");
    await device(core.id, "android");
    const view = await listDevices(at(), { ...primary.session, device: { ...primary.session.device, id: mine.id } });
    expect(view.mine).toMatchObject([{ id: mine.id, type: "iphone", ownerFirstName: "Camille", current: true }]);
    expect(view.guests).toHaveLength(1);
    expect(view.guests[0]).toMatchObject({ firstName: "Thomas" });
    expect(view.guests[0].devices[0]).toMatchObject({ type: "android", current: false });
    expect((await rejectionOf(listDevices(at(), core.session))).status).toBe(403);
  });

  it("RF3, RT1, RT2, RF5 : la révocation ferme les sessions, est journalisée avec son auteur et prévient le profil", async () => {
    const { primary, core } = await household();
    const phone = await device(core.id);
    expect(await getSession(at(), phone.token)).not.toBeNull();

    expect(await revokeDevice(at(), actorOf(primary.session), phone.id)).toEqual({ revokedCurrent: false });
    expect(await getSession(at(), phone.token)).toBeNull();
    expect((await listDevices(at(), primary.session)).guests).toEqual([]);

    const row = await db.selectFrom("devices").select(["revoked_at", "revoked_by_user_id"]).where("id", "=", phone.id).executeTakeFirstOrThrow();
    expect(row.revoked_at).not.toBeNull();
    expect(row.revoked_by_user_id).toBe(primary.id);
    const event = await db.selectFrom("security_events").select(["event_type", "user_id", "actor_user_id"]).where("device_id", "=", phone.id).executeTakeFirstOrThrow();
    expect(event).toEqual({ event_type: "device_revoked", user_id: core.id, actor_user_id: primary.id });
    expect((await messagesTo(core.email)).some((m) => /accès/i.test(m.subject ?? ""))).toBe(true);
  });

  it("RF3, CA 3.1 : un appareil révoqué doit repasser par la vérification d'identité", async () => {
    const { primary } = await household();
    const laptop = await device(primary.id, "desktop");
    // Avant : l'appareil est reconnu.
    expect((await login(at(), { email: primary.email, password: PASSWORD, knownDeviceIds: [laptop.id], timezone: "Europe/Paris" })).kind).toBe("session");
    await revokeDevice(at(), actorOf(primary.session), laptop.id);
    expect((await login(at(), { email: primary.email, password: PASSWORD, knownDeviceIds: [laptop.id], timezone: "Europe/Paris" })).kind).toBe("verify");
  });

  it("RF4 : révoquer « Cet appareil » équivaut à une déconnexion avec effacement des tchats", async () => {
    const { primary } = await household();
    const mine = await device(primary.id);
    const session: SessionContext = { ...primary.session, device: { ...primary.session.device, id: mine.id } };
    expect(await revokeDevice(at(), actorOf(session), mine.id)).toEqual({ revokedCurrent: true });
    const erasure = await db.selectFrom("chat_erasure_requests").select(["reason", "status"]).where("user_id", "=", primary.id).orderBy("id", "desc").executeTakeFirstOrThrow();
    expect(erasure).toMatchObject({ reason: "device_revoked" });
  });

  it("l'utilisateur principal ne peut pas révoquer l'appareil d'un autre compte ; un invité n'a pas ce pouvoir", async () => {
    const { primary, core } = await household();
    const other = await household();
    const foreign = await device(other.primary.id);
    expect((await rejectionOf(revokeDevice(at(), actorOf(primary.session), foreign.id))).status).toBe(403);
    expect(() => actorOf(core.session)).toThrow(Rejection);
  });

  it("une seconde révocation du même appareil est sans effet (double envoi)", async () => {
    const { primary, core } = await household();
    const phone = await device(core.id);
    await revokeDevice(at(), actorOf(primary.session), phone.id);
    expect((await rejectionOf(revokeDevice(at(), actorOf(primary.session), phone.id))).status).toBe(404);
  });

  it("RF7, CA 7.1 : l'administrateur voit les appareils d'un compte et peut les révoquer", async () => {
    const { primary, core } = await household();
    const phone = await device(core.id);
    await device(primary.id, "desktop");
    const admin = await createProfile(db, { role: "admin" });

    const people = await listAccountDevices(at(), primary.accountId!);
    expect(people.map((p) => [p.firstName, p.devices.length])).toEqual([["Camille", 1], ["Thomas", 1], ["Élodie", 0]]);
    await revokeDevice(at(), { userId: admin.id, role: "admin", accountId: null, currentDeviceId: null }, phone.id);
    expect(await getSession(at(), phone.token)).toBeNull();
  });

  it("l'appareil d'un administrateur ne peut pas être révoqué par ce chemin", async () => {
    const { primary } = await household();
    const admin = await createProfile(db, { role: "admin" });
    const adminDevice = await device(admin.id, "desktop");
    expect((await rejectionOf(revokeDevice(at(), actorOf(primary.session), adminDevice.id))).status).toBe(403);
  });
});

describe("US-40, US-50 — carnet de bord", () => {
  /** Une demande de `who` à l'agent, passée par le simulateur comme en vrai. */
  async function ask(who: { id: string }, a: { ref: string }, text: string, participants: string[] = []) {
    const requestId = randomUUID();
    await mock.submitRequest({
      requestId,
      userRef: await ensureDigitornRef(db, who.id),
      agentRef: a.ref,
      text,
      context: { rank: "primary_user", autoParticipants: participants, ccAddresses: [], info: {} },
    });
  }

  it("RT1, RT3 : la synchronisation importe les entrées, et une seconde passe n'en duplique aucune", async () => {
    const { primary } = await household();
    const a = await agent();
    await ask(primary, a, "Classe ce relevé");
    const first = await syncLogbook(at(clock));
    expect(first).toMatchObject({ status: "succeeded" });
    expect(first.imported).toBeGreaterThanOrEqual(1);

    const before = (await getLogbook(at(), primary.session, a.id)).entries.length;
    expect((await syncLogbook(at(clock))).imported).toBe(0);
    expect((await getLogbook(at(), primary.session, a.id)).entries).toHaveLength(before);
  });

  it("RF2 : une entrée porte sa date, son auteur, son type, son résumé et son résultat, de la plus récente à la plus ancienne", async () => {
    const { primary } = await household();
    const a = await agent();
    clock = new Date(Date.now() - 3 * 3_600_000);
    await ask(primary, a, "Première demande");
    clock = new Date(Date.now() - 1 * 3_600_000);
    await ask(primary, a, "Seconde demande");
    clock = new Date();
    await syncLogbook(at());
    const { entries } = await getLogbook(at(), primary.session, a.id);
    expect(entries.map((e) => e.summary)).toEqual(["Seconde demande", "Première demande"]);
    expect(entries[0]).toMatchObject({ authorFirstName: "Camille", type: "request", result: expect.any(String) });
    expect(Date.parse(entries[0].occurredAt)).toBeGreaterThan(Date.parse(entries[1].occurredAt));
  });

  it("RF3, D3 : le noyau voit tout ; un invité secondaire voit ses demandes et celles où il participe", async () => {
    const { primary, core, secondary } = await household();
    const a = await agent();
    await ask(primary, a, "Rendez-vous avec Élodie", [secondary.email]);
    await ask(core, a, "Rendez-vous sans Élodie");
    await ask(secondary, a, "Ma demande à moi");
    await syncLogbook(at(clock));

    const texts = async (s: SessionContext) => (await getLogbook(at(), s, a.id)).entries.map((e) => e.summary).sort();
    expect(await texts(core.session)).toEqual(["Ma demande à moi", "Rendez-vous avec Élodie", "Rendez-vous sans Élodie"]);
    expect(await texts(primary.session)).toHaveLength(3);
    expect(await texts(secondary.session)).toEqual(["Ma demande à moi", "Rendez-vous avec Élodie"]);
  });

  it("RF1, RF4, US-50 RF2 : le sélecteur propose, par ordre alphabétique, les agents ayant des entrées, retirés du dashboard ou non", async () => {
    const { primary, core } = await household();
    const zeta = await agent(`Zeta_${tag()}`);
    const alpha = await agent(`Alpha_${tag()}`);
    // Camille n'a ajouté aucun des deux : Thomas, du noyau, les utilise ; Alpha a même été retiré de son dashboard.
    await db.insertInto("profile_agents").values({ user_id: core.id, agent_id: zeta.id }).execute();
    await db.insertInto("profile_agents").values({ user_id: core.id, agent_id: alpha.id, removed_at: new Date() }).execute();
    await ask(core, zeta, "Demande Zeta");
    await ask(core, alpha, "Demande Alpha");
    await syncLogbook(at(clock));

    const names = (await listLogbookAgents(at(), primary.session)).map((x) => x.name);
    expect(names).toEqual([alpha.name, zeta.name]);
  });

  it("US-50 RF3 : sans aucune entrée visible, la liste des agents est vide", async () => {
    const { secondary } = await household();
    expect(await listLogbookAgents(at(), secondary.session)).toEqual([]);
  });

  async function insertEntries(accountId: string, agentId: string, count: number, requester: string | null, ageDays = 1) {
    for (let i = 0; i < count; i++) {
      await db
        .insertInto("logbook_entries")
        .values({
          account_id: accountId,
          agent_id: agentId,
          external_ref: `seed-${randomUUID()}`,
          occurred_at: new Date(Date.now() - ageDays * 86_400_000 - i * 60_000),
          requester_user_id: requester,
          entry_type: "request",
          summary: `Entrée ${i}`,
        })
        .execute();
    }
  }

  it("RF9, CA 9.1 : 20 entrées d'abord, puis le reste avec « Voir plus »", async () => {
    const { primary } = await household();
    const a = await agent();
    await insertEntries(primary.accountId!, a.id, 35, primary.id);
    const first = await getLogbook(at(), primary.session, a.id);
    expect(first.entries).toHaveLength(PAGE_SIZE);
    expect(first.hasMore).toBe(true);
    const second = await getLogbook(at(), primary.session, a.id, PAGE_SIZE);
    expect(second.entries).toHaveLength(15);
    expect(second.hasMore).toBe(false);
    expect(new Set([...first.entries, ...second.entries].map((e) => e.id)).size).toBe(35);
  });

  it("RF6, CA 6.1, 6.2 : au-delà de la durée de rétention réglée par l'administrateur, l'entrée n'apparaît plus", async () => {
    const { primary } = await household();
    const a = await agent();
    await insertEntries(primary.accountId!, a.id, 1, primary.id, 13 * 30); // environ 13 mois
    await insertEntries(primary.accountId!, a.id, 1, primary.id, 15 * 31); // plus de 14 mois
    expect((await getLogbook(at(), primary.session, a.id)).entries).toHaveLength(1);
    const restore = await setSetting("logbook_retention_months", "12");
    try {
      expect((await getLogbook(at(), primary.session, a.id)).entries).toHaveLength(0);
    } finally {
      await restore();
    }
  });

  it("RF8, CA 8.1 : les entrées d'un invité supprimé s'affichent sans son nom", async () => {
    const { primary } = await household();
    const a = await agent();
    await insertEntries(primary.accountId!, a.id, 1, null);
    expect((await getLogbook(at(), primary.session, a.id)).entries[0].authorFirstName).toBeNull();
  });

  it("une entrée en cours d'anonymisation est masquée (US-57 RF7)", async () => {
    const { primary } = await household();
    const a = await agent();
    await insertEntries(primary.accountId!, a.id, 1, primary.id);
    await db.updateTable("logbook_entries").set({ anonymization_status: "pending" }).where("agent_id", "=", a.id).execute();
    expect((await getLogbook(at(), primary.session, a.id)).entries).toEqual([]);
  });

  it("RF3 : l'administrateur n'a pas de carnet", async () => {
    const admin = await createProfile(db, { role: "admin" });
    expect((await rejectionOf(listLogbookAgents(at(), await sessionFor(db, admin.id)))).status).toBe(403);
  });

  it("RF5 : « Dernière mise à jour » est la fin de la dernière synchronisation réussie", async () => {
    const { primary } = await household();
    const a = await agent();
    await syncLogbook(at());
    const page = await getLogbook(at(), primary.session, a.id);
    expect(page.lastSyncAt).not.toBeNull();
    expect(Date.now() - Date.parse(page.lastSyncAt!)).toBeLessThan(60_000);
  });

  it("RT4 : un échec est enregistré, signalé par email à l'administrateur, et réessayé à la synchronisation suivante", async () => {
    const { primary } = await household();
    const a = await agent();
    await ask(primary, a, "Demande avant la panne");
    const alertAddress = `alerte-${tag()}@maaq.test`;
    const restore = await setSetting("alert_email", alertAddress);
    try {
      const spy = vi.spyOn(mock, "fetchLogbook").mockRejectedValueOnce(new Error("Digitorn injoignable"));
      const failed = await syncLogbook(at(clock));
      expect(failed).toMatchObject({ status: "failed", error: "Digitorn injoignable" });
      expect((await messagesTo(alertAddress))[0].text).toContain("Digitorn injoignable");
      expect(spy).toHaveBeenCalledOnce();
    } finally {
      await restore();
    }
    // La panne n'a rien fait perdre : la passe suivante récupère tout.
    expect((await syncLogbook(at(clock))).imported).toBeGreaterThanOrEqual(1);
    expect((await getLogbook(at(), primary.session, a.id)).entries.map((e) => e.summary)).toContain("Demande avant la panne");
  });
});

describe("traitements périodiques", () => {
  it("US-40 RT2 : la synchronisation n'a lieu que lorsque l'échéance est passée", async () => {
    await db.insertInto("logbook_sync_runs").values({ started_at: new Date(), status: "succeeded", finished_at: new Date() }).execute();
    expect(await runDueJobs(at())).toEqual({ logbook: "not_due", purged: null });
    const forced = await runDueJobs(at(), { force: true });
    expect(forced.logbook).toMatchObject({ status: "succeeded" });
    expect(forced.purged).not.toBeNull();
  });

  it("US-40 RT6, US-70 RT3 : les tables techniques et compteurs anciens sont nettoyés", async () => {
    const { primary } = await household();
    const old = new Date(Date.now() - 3 * 86_400_000);
    await db.insertInto("idempotency_keys").values({ user_id: primary.id, idempotency_key: `old-key-${tag()}`, request_path: "/x", response_status: 200, created_at: old }).execute();
    await runDueJobs(at(), { force: true });
    const left = await db.selectFrom("idempotency_keys").select("idempotency_key").where("user_id", "=", primary.id).execute();
    expect(left).toEqual([]);
  });
});

describe("US-62, US-63 — contact du support", () => {
  const send = (session: SessionContext, text: string, channel: "written" | "dictated" = "written") => sendSupportMessage(at(), session, { text, channel });

  it("RF3 : entre 10 et 2 000 caractères", async () => {
    const { primary } = await household();
    expect((await rejectionOf(send(primary.session, "Bug"))).code).toBe("message_too_short");
    expect((await rejectionOf(send(primary.session, "a".repeat(2001)))).code).toBe("message_too_long");
  });

  it("RF4, RF5 : le support reçoit le message avec les informations du profil, et le profil en reçoit une copie", async () => {
    const { primary } = await household();
    const address = `support-${tag()}@maaq.test`;
    const restore = await setSetting("support_email", address);
    try {
      await send(primary.session, "L'agent Admin_lib n'ouvre plus son tchat depuis ce matin.");
      const [mail] = await messagesTo(address);
      expect(mail.text).toContain("Prénom : Camille");
      expect(mail.text).toContain(`Email : ${primary.email}`);
      expect(mail.text).toContain("Rôle : Utilisateur principal");
      expect(mail.text).toContain("Appareil : Android");
      expect(mail.text).toContain(`Version de l'application : ${APP_VERSION}`);
      expect(mail.text).toContain("n'ouvre plus son tchat");
      expect((await messagesTo(primary.email)).some((m) => m.subject?.includes("Copie"))).toBe(true);
    } finally {
      await restore();
    }
  });

  it("US-63 RF6 : un message dicté arrive comme texte, avec la mention du canal", async () => {
    const { core } = await household();
    const address = `support-${tag()}@maaq.test`;
    const restore = await setSetting("support_email", address);
    try {
      await send(core.session, "Texte transcrit de ma dictée orale.", "dictated");
      const [mail] = await messagesTo(address);
      expect(mail.text).toContain("Rôle : Invité");
      expect(mail.text).toContain("message dicté (texte transcrit)");
    } finally {
      await restore();
    }
  });

  it("l'administrateur peut aussi écrire au support", async () => {
    const admin = await createProfile(db, { role: "admin" });
    const address = `support-${tag()}@maaq.test`;
    const restore = await setSetting("support_email", address);
    try {
      await send(await sessionFor(db, admin.id), "Un souci dans la console d'administration.");
      expect((await messagesTo(address))[0].text).toContain("Rôle : Administrateur");
    } finally {
      await restore();
    }
  });

  it("RT1 : sans adresse de support renseignée, l'envoi est refusé et rien ne part", async () => {
    const { primary } = await household();
    const restore = await setSetting("support_email", null);
    try {
      expect((await rejectionOf(send(primary.session, "Un message suffisamment long."))).code).toBe("support_unavailable");
    } finally {
      await restore();
    }
  });
});
