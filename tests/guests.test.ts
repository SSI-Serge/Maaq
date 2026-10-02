import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activate, inspectActivation } from "@/server/accounts/activate";
import type { Messenger } from "@/server/adapters/messaging";
import { createSession, getSession, type Ctx } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { deliverInvitation } from "@/server/guests/invitations";
import { addGuest, designateCoreGuest, listGuests, removeGuest, sendInvitation, updateGuest } from "@/server/guests/service";
import { Rejection } from "@/server/http";
import { completeSetup, getSetup, saveMyInfo } from "@/server/profile/setup";
import { createProfile, messagesTo, minutesLater, sessionFor, testDb } from "./helpers/fixtures";

let db: Kysely<DB>;
beforeAll(async () => {
  db = testDb();
  // Textes à accepter à l'activation ; « doNothing » car plusieurs fichiers de test les préparent en parallèle.
  await db
    .insertInto("legal_document_versions")
    .values([
      { document_type: "privacy_policy", version_label: "test", content: "Politique", published_at: new Date(0) },
      { document_type: "terms_of_use", version_label: "test", content: "Conditions", published_at: new Date(0) },
    ])
    .onConflict((oc) => oc.columns(["document_type", "version_label"]).doNothing())
    .execute();
});
afterAll(async () => {
  await db.destroy();
});

const at = (now = new Date()): Ctx => ({ db, now });
const unique = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 9)}@maaq.test`;
const guestInput = (email = unique("invite")) => ({ firstName: "Julien", lastName: "Martin", email, phone: "06 98 76 54 32", designateCore: false });

async function rejectionOf(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("refus attendu");
}

async function primary() {
  const profile = await createProfile(db);
  return { profile, session: await sessionFor(db, profile.id) };
}

/** Ajoute un invité et envoie réellement son invitation (boîte de test). */
async function addAndDeliver(session: Awaited<ReturnType<typeof sessionFor>>, input = guestInput()) {
  const { guestId, delivery } = await addGuest(at(), session, input);
  await deliverInvitation(db, delivery.linkId, delivery.content);
  return { guestId, token: delivery.content.token, email: input.email };
}

describe("US-10 / US-11 — configuration initiale", () => {
  it("RF1, RF7 : deux étapes, reprise à l'étape non terminée, invité 1 enregistré sans invitation", async () => {
    const profile = await createProfile(db, { setupCompleted: false });
    const session = await sessionFor(db, profile.id);
    expect((await getSetup(at(), session)).step).toBe("step_1_my_info");

    expect((await rejectionOf(saveMyInfo(at(), session, { firstName: " ", lastName: "Faucher" }))).details).toEqual({ firstName: "Ce champ est obligatoire" });
    await saveMyInfo(at(), session, { firstName: "Camille", lastName: "Faucher" });
    expect((await getSetup(at(), session)).step).toBe("step_2_guest_info");

    const email = unique("julien");
    await completeSetup(at(), session, { firstName: "Julien", lastName: "Martin", email, phone: "" });
    const setup = await getSetup(at(), session);
    expect(setup.step).toBe("completed");
    expect(setup.coreGuest).toMatchObject({ email, invited: false });

    const list = await listGuests(at(), profile.accountId!);
    expect(list.guests).toMatchObject([{ email, rank: "core", status: "not_invited" }]);
    expect(await messagesTo(email)).toEqual([]); // US-11 RF3
  });

  it("RF1 : « Passer cette étape » termine la configuration sans invité", async () => {
    const profile = await createProfile(db, { setupCompleted: false });
    const session = await sessionFor(db, profile.id);
    await saveMyInfo(at(), session, { firstName: "Camille", lastName: "Faucher" });
    await completeSetup(at(), session, null);
    expect(await getSetup(at(), session)).toMatchObject({ step: "completed", coreGuest: null });
  });
});

describe("US-18 / US-21 — ajouter un invité et quota", () => {
  it("RF5 : le premier invité devient invité 1, les suivants sont secondaires", async () => {
    const { profile, session } = await primary();
    await addAndDeliver(session);
    await addAndDeliver(session);
    const list = await listGuests(at(), profile.accountId!);
    expect(list.guests.map((g) => g.rank)).toEqual(["core", "secondary"]);
    expect(list.guests.every((g) => g.status === "invitation_sent")).toBe(true);
  });

  it("RF3 : refuse l'email de l'utilisateur principal ou d'un compte existant", async () => {
    const { profile, session } = await primary();
    const other = await createProfile(db);
    expect((await rejectionOf(addGuest(at(), session, guestInput(profile.email)))).details).toMatchObject({
      email: "Cette adresse est déjà associée à un compte MAAQ",
    });
    expect((await rejectionOf(addGuest(at(), session, guestInput(other.email.toUpperCase())))).details).toMatchObject({
      email: "Cette adresse est déjà associée à un compte MAAQ",
    });
  });

  it("RT1, US-21 RF2-RF3 : le quota est vérifié côté serveur ; un invité supprimé libère sa place", async () => {
    const { profile, session } = await primary(); // quota de 3
    const first = await addAndDeliver(session);
    await addAndDeliver(session);
    await addAndDeliver(session);
    expect(await listGuests(at(), profile.accountId!)).toMatchObject({ quota: 3, used: 3 });
    expect((await rejectionOf(addGuest(at(), session, guestInput()))).code).toBe("quota_reached");

    await removeGuest(at(), session, first.guestId);
    expect((await listGuests(at(), profile.accountId!)).used).toBe(2);
    await addAndDeliver(session);
  });

  it("US-4 RF1-RF2 : l'invitation part par email et SMS, avec le nom de l'hôte et un lien de 30 minutes", async () => {
    const { session } = await primary();
    const { email } = await addAndDeliver(session);
    const [mail] = await messagesTo(email);
    expect(mail.subject).toBe("Camille Test vous invite sur MAAQ");
    expect(mail.text).toMatch(/\/activation\?jeton=/);
    expect(mail.text).toMatch(/30 minutes/);
    expect((await messagesTo("+33698765432")).length).toBeGreaterThan(0);
  });

  it("RF7, RF12 : après 3 nouvelles tentatives, l'invitation passe en « Échec d'envoi »", async () => {
    const { profile, session } = await primary();
    const { delivery } = await addGuest(at(), session, guestInput());
    expect((await listGuests(at(), profile.accountId!)).guests[0].status).toBe("sending");
    const failing: Messenger = {
      sendEmail: async () => {
        throw new Error("indisponible");
      },
      sendSms: async () => {},
    };
    expect(await deliverInvitation(db, delivery.linkId, delivery.content, { sender: failing, sleep: async () => {} })).toBe("failed");
    expect((await listGuests(at(), profile.accountId!)).guests[0].status).toBe("send_failed");
    const link = await db.selectFrom("activation_links").select("delivery_attempts").where("id", "=", delivery.linkId).executeTakeFirstOrThrow();
    expect(link.delivery_attempts).toBe(4);
  });
});

describe("US-5 — renvoyer un lien expiré", () => {
  it("RF1, RF3-RF4 : statut « Invitation expirée » après 30 min, nouveau lien qui invalide l'ancien", async () => {
    const { profile, session } = await primary();
    const { guestId, token } = await addAndDeliver(session);
    expect((await listGuests(at(minutesLater(new Date(), 31)), profile.accountId!)).guests[0].status).toBe("invitation_expired");

    const delivery = await sendInvitation(at(), session, guestId);
    await deliverInvitation(db, delivery.linkId, delivery.content);
    expect((await listGuests(at(), profile.accountId!)).guests[0].status).toBe("invitation_sent");
    expect(await inspectActivation(at(), token)).toMatchObject({ kind: "expired", host: "Camille" });
    expect(await inspectActivation(at(), delivery.content.token)).toMatchObject({ kind: "valid", role: "guest" });
  });

  it("RF6 : 3 renvois par heure au maximum", async () => {
    const { session } = await primary();
    const { guestId } = await addAndDeliver(session);
    for (let i = 0; i < 3; i++) await sendInvitation(at(), session, guestId);
    expect((await rejectionOf(sendInvitation(at(), session, guestId))).code).toBe("resend_limited");
    await sendInvitation(at(minutesLater(new Date(), 61)), session, guestId);
  });

  it("RF7 : réservé à l'utilisateur principal", async () => {
    const { session } = await primary();
    const { guestId } = await addAndDeliver(session);
    const guestSession = await sessionFor(db, guestId);
    expect((await rejectionOf(sendInvitation(at(), guestSession, guestId))).code).toBe("forbidden");
  });
});

describe("US-4 — activer son accès d'invité", () => {
  it("RF4-RF5, RF7, RF10 : activation, session ouverte, lien à usage unique, statut « Actif »", async () => {
    const { profile, session } = await primary();
    const { guestId, token, email } = await addAndDeliver(session);
    const info = await inspectActivation(at(), token);
    expect(info).toMatchObject({
      kind: "valid",
      role: "guest",
      profile: { firstName: "Julien", lastName: "Martin", email, phone: "+33698765432" },
      host: { firstName: "Camille", lastName: "Test" },
    });

    const input = { token, accepted: true, password: "Invite-2026x", confirmation: "Invite-2026x", timezone: "Europe/Paris", userAgent: null };
    const result = await activate(at(), input);
    if (result.kind !== "session") throw new Error("session attendue");
    expect((await getSession(at(), result.token))?.user).toMatchObject({ id: guestId, role: "guest" });
    expect(await activate(at(), input)).toMatchObject({ kind: "used" });
    expect((await listGuests(at(), profile.accountId!)).guests[0].status).toBe("active");
  });

  it("RF8 : le lien d'un invité supprimé est traité comme expiré", async () => {
    const { session } = await primary();
    const { guestId, token } = await addAndDeliver(session);
    await removeGuest(at(), session, guestId);
    expect(await inspectActivation(at(), token)).toMatchObject({ kind: "expired", linkKind: "guest_invitation", host: "Camille" });
  });
});

describe("US-19 — modifier un invité", () => {
  it("RF3 : pour un invité non activé, changer l'email invalide le lien en cours", async () => {
    const { profile, session } = await primary();
    const { guestId, token } = await addAndDeliver(session);
    await updateGuest(at(), session, guestId, { firstName: "Julien", lastName: "Martin", email: unique("nouveau"), phone: "06 98 76 54 32" });
    expect((await listGuests(at(), profile.accountId!)).guests[0].status).toBe("not_invited");
    expect(await inspectActivation(at(), token)).toMatchObject({ kind: "expired" });
  });

  it("RF4, RT1 : pour un invité actif, l'email de connexion change ; les deux adresses sont prévenues", async () => {
    const { session } = await primary();
    const { guestId, token, email } = await addAndDeliver(session);
    await activate(at(), { token, accepted: true, password: "Invite-2026x", confirmation: "Invite-2026x", timezone: "UTC", userAgent: null });
    const newEmail = unique("julien-pro");
    await updateGuest(at(), session, guestId, { firstName: "Julien", lastName: "Martin", email: newEmail, phone: "" });

    const user = await db.selectFrom("users").select(["email", "phone"]).where("id", "=", guestId).executeTakeFirstOrThrow();
    expect(user).toEqual({ email: newEmail, phone: null });
    expect((await messagesTo(email)).map((m) => m.subject)).toContain("Votre email de connexion MAAQ a changé");
    expect((await messagesTo(newEmail)).map((m) => m.subject)).toContain("Votre email de connexion MAAQ a changé");
    const events = await db.selectFrom("security_events").select("event_type").where("user_id", "=", guestId).execute();
    expect(events.map((e) => e.event_type)).toContain("login_email_changed");
  });
});

describe("US-20 — supprimer un invité", () => {
  it("RF2-RF4, RT1-RT2 : accès retiré sur tous les appareils, invité prévenu, données purgées après le délai réglé", async () => {
    const { profile, session } = await primary();
    const { guestId, token, email } = await addAndDeliver(session);
    const activation = await activate(at(), { token, accepted: true, password: "Invite-2026x", confirmation: "Invite-2026x", timezone: "UTC", userAgent: null });
    if (activation.kind !== "session") throw new Error("session attendue");
    const device = await db.selectFrom("devices").select("id").where("user_id", "=", guestId).executeTakeFirstOrThrow();
    const second = await createSession(db, guestId, device.id, new Date());

    const now = new Date();
    await removeGuest(at(now), session, guestId);
    expect(await getSession(at(), activation.token)).toBeNull();
    expect(await getSession(at(), second.token)).toBeNull();
    const sessions = await db.selectFrom("sessions").select(["id", "revoked_at", "revoked_reason"]).where("user_id", "=", guestId).execute();
    expect(sessions.every((s) => s.revoked_at !== null)).toBe(true);
    expect(sessions.find((s) => s.id === second.sessionId)?.revoked_reason).toBe("guest_removed");

    const removed = await db.selectFrom("users").select(["status", "purge_scheduled_at"]).where("id", "=", guestId).executeTakeFirstOrThrow();
    expect(removed.status).toBe("removed");
    expect(Math.round((new Date(removed.purge_scheduled_at!).getTime() - now.getTime()) / 86_400_000)).toBe(30);
    expect((await messagesTo(email)).map((m) => m.subject)).toContain("Votre accès à MAAQ a été retiré");
    expect((await listGuests(at(), profile.accountId!)).guests).toEqual([]);
  });

  it("RF6, RF11 : pas de promotion automatique ; l'utilisateur principal désigne le nouvel invité 1", async () => {
    const { profile, session } = await primary();
    const core = await addAndDeliver(session);
    const secondary = await addAndDeliver(session);
    await removeGuest(at(), session, core.guestId);

    let list = await listGuests(at(), profile.accountId!);
    expect(list).toMatchObject({ hasCoreGuest: false, guests: [{ id: secondary.guestId, rank: "secondary" }] });
    const third = await addAndDeliver(session); // sans désignation : secondaire
    expect((await listGuests(at(), profile.accountId!)).guests.find((g) => g.id === third.guestId)!.rank).toBe("secondary");

    await designateCoreGuest(at(), session, secondary.guestId);
    list = await listGuests(at(), profile.accountId!);
    expect(list.hasCoreGuest).toBe(true);
    expect(list.guests[0]).toMatchObject({ id: secondary.guestId, rank: "core" });
    expect((await rejectionOf(designateCoreGuest(at(), session, third.guestId))).code).toBe("core_exists");
  });

  it("RF11 : la case « Désigner comme invité 1 » du formulaire d'ajout", async () => {
    const { profile, session } = await primary();
    const core = await addAndDeliver(session);
    await removeGuest(at(), session, core.guestId);
    const designated = await addGuest(at(), session, { ...guestInput(), designateCore: true });
    expect((await listGuests(at(), profile.accountId!)).guests.find((g) => g.id === designated.guestId)!.rank).toBe("core");
  });
});
