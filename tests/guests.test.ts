import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ChildLinkCard, ChildQuestion, LINK_DECLINED, LINK_DONE } from "@/components/family/ChildLinkBanner";
import { addChild, childLinkCandidates, setChildProfile } from "@/server/assistant/family";
import { isChildProfile } from "@/server/assistant/profile-member";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activate, inspectActivation } from "@/server/accounts/activate";
import type { Messenger } from "@/server/adapters/messaging";
import { createSession, getSession, type Ctx } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { deliverInvitation } from "@/server/guests/invitations";
import { addGuest, confirmEmailChange, designateCoreGuest, inspectEmailChange, listGuests, removeGuest, sendInvitation, updateGuest } from "@/server/guests/service";
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

  it("RF4, RT1 : pour un invité actif, le nouvel email ne s'applique qu'après sa confirmation ; l'ancien reste valable d'ici là", async () => {
    const { session } = await primary();
    const { guestId, token, email } = await addAndDeliver(session);
    await activate(at(), { token, accepted: true, password: "Invite-2026x", confirmation: "Invite-2026x", timezone: "UTC", userAgent: null });
    const newEmail = unique("julien-pro");
    expect(await updateGuest(at(), session, guestId, { firstName: "Julien", lastName: "Martin", email: newEmail, phone: "" })).toEqual({ emailPending: true });

    // Rien n'a changé : l'email de connexion est toujours l'ancien, le téléphone, lui, est mis à jour.
    const emailOf = async () => (await db.selectFrom("users").select(["email", "phone"]).where("id", "=", guestId).executeTakeFirstOrThrow());
    expect(await emailOf()).toEqual({ email, phone: null });
    expect((await db.selectFrom("security_events").select("event_type").where("user_id", "=", guestId).execute()).map((e) => e.event_type)).not.toContain("login_email_changed");
    // Le lien part à la NOUVELLE adresse ; l'ancienne est informée, sans lien.
    const toNew = (await messagesTo(newEmail)).find((m) => m.subject === "Confirmez votre nouvel email de connexion MAAQ")!;
    const toOld = (await messagesTo(email)).find((m) => m.subject === "Demande de changement de votre email de connexion MAAQ")!;
    expect(toOld.text).not.toContain("/confirmer-email");
    expect(toOld.text).toContain("Rien ne change tant que vous n'avez pas confirmé");
    const link = /\/confirmer-email\?jeton=(\S+)/.exec(toNew.text)![1];
    const jeton = decodeURIComponent(link);
    // Le nouvel email ne se lit pas dans le lien.
    expect(link).not.toContain(encodeURIComponent(newEmail));
    expect(Buffer.from(jeton.split(".")[0], "base64url").toString("utf8")).not.toContain(newEmail);

    // Un lien falsifié ou trop vieux est refusé.
    expect((await rejectionOf(confirmEmailChange(at(), jeton.slice(0, -2) + "xx"))).code).toBe("link_expired");
    expect((await rejectionOf(confirmEmailChange(at(new Date(Date.now() + 49 * 3_600_000)), jeton))).code).toBe("link_expired");
    expect(await inspectEmailChange(at(), jeton)).toEqual({ firstName: "Julien", newEmail });
    expect(await emailOf()).toEqual({ email, phone: null });

    // L'invité confirme : l'email change, les deux adresses sont prévenues, le lien ne sert qu'une fois.
    expect(await confirmEmailChange(at(), jeton)).toEqual({ firstName: "Julien", newEmail });
    expect((await emailOf()).email).toBe(newEmail);
    expect((await messagesTo(email)).map((m) => m.subject)).toContain("Votre email de connexion MAAQ a changé");
    expect((await messagesTo(newEmail)).map((m) => m.subject)).toContain("Votre email de connexion MAAQ a changé");
    expect((await db.selectFrom("security_events").select("event_type").where("user_id", "=", guestId).execute()).map((e) => e.event_type)).toContain("login_email_changed");
    expect((await rejectionOf(confirmEmailChange(at(), jeton))).code).toBe("link_expired");
  });

  it("une adresse prise entre-temps par un autre compte est refusée à la confirmation ; sans changement d'email, pas de confirmation", async () => {
    const { session } = await primary();
    const { guestId, token, email } = await addAndDeliver(session);
    await activate(at(), { token, accepted: true, password: "Invite-2026x", confirmation: "Invite-2026x", timezone: "UTC", userAgent: null });
    expect(await updateGuest(at(), session, guestId, { firstName: "Jules", lastName: "Martin", email, phone: "" })).toEqual({ emailPending: false });
    const wanted = unique("convoitee");
    await updateGuest(at(), session, guestId, { firstName: "Jules", lastName: "Martin", email: wanted, phone: "" });
    const jeton = decodeURIComponent(/\/confirmer-email\?jeton=(\S+)/.exec((await messagesTo(wanted))[0].text)![1]);
    const other = await createProfile(db);
    await db.updateTable("users").set({ email: wanted }).where("id", "=", other.id).execute();
    expect((await rejectionOf(confirmEmailChange(at(), jeton))).code).toBe("email_taken");
    expect((await db.selectFrom("users").select("email").where("id", "=", guestId).executeTakeFirstOrThrow()).email).toBe(email);
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

describe("S-56 — le lien avec la fiche enfant est proposé à l'invitation", () => {
  async function household() {
    const { profile, session } = await primary();
    // Le premier invité du compte devient l'invité 1 : le couple est en place.
    await addGuest(at(), session, guestInput());
    const lea = await addChild(at(), session, { firstName: "Léa", birth: "2018-03" });
    return { profile, session, lea };
  }
  const linkOf = async (memberId: string) => (await db.selectFrom("family_members").select("child_profile_user_id").where("id", "=", memberId).executeTakeFirstOrThrow()).child_profile_user_id;

  it("« Oui » avec une fiche : le profil en attente est relié dès l'invitation, invité secondaire, et la fiche n'est plus proposée", async () => {
    const f = await household();
    const before = await listGuests(at(), f.profile.accountId!);
    expect(before.childSheets.map((x) => x.firstName)).toEqual(["Léa"]);
    expect(before.childSheets[0].age).toBeGreaterThanOrEqual(7);
    const { guestId } = await addGuest(at(), f.session, { ...guestInput(), firstName: "Léa", childMemberId: f.lea.id });
    expect(await linkOf(f.lea.id)).toBe(guestId);
    const user = await db.selectFrom("users").select(["guest_rank", "status"]).where("id", "=", guestId).executeTakeFirstOrThrow();
    expect(user).toEqual({ guest_rank: "secondary", status: "pending_activation" });
    const after = await listGuests(at(), f.profile.accountId!);
    expect(after.childSheets).toEqual([]);
    expect(after.guests.find((g) => g.id === guestId)?.childSheet).toBe("Léa");
    expect(after.guests.filter((g) => g.id !== guestId).every((g) => g.childSheet === null)).toBe(true);
    // Le profil est celui d'un enfant avant même l'activation : rien à rattraper.
    expect(await isChildProfile(db, guestId)).toBe(true);
    expect(await childLinkCandidates(at(), f.session)).toEqual([]);
  });

  it("un enfant premier invité du compte reste invité secondaire ; il ne peut pas être désigné invité 1", async () => {
    const { session } = await primary();
    const tom = await addChild(at(), session, { firstName: "Tom" });
    expect((await rejectionOf(addGuest(at(), session, { ...guestInput(), designateCore: true, childMemberId: tom.id }))).code).toBe("child_not_core");
    const { guestId } = await addGuest(at(), session, { ...guestInput(), childMemberId: tom.id });
    expect((await db.selectFrom("users").select("guest_rank").where("id", "=", guestId).executeTakeFirstOrThrow()).guest_rank).toBe("secondary");
  });

  it("refus : fiche déjà reliée, fiche d'un parent, fiche d'un autre foyer ; rien n'est créé", async () => {
    const f = await household();
    await addGuest(at(), f.session, { ...guestInput(), childMemberId: f.lea.id });
    expect((await rejectionOf(addGuest(at(), f.session, { ...guestInput(), childMemberId: f.lea.id }))).code).toBe("child_sheet_taken");
    const own = await db.selectFrom("family_members").select("id").where("user_id", "=", f.profile.id).executeTakeFirstOrThrow();
    expect((await rejectionOf(addGuest(at(), f.session, { ...guestInput(), childMemberId: own.id }))).code).toBe("invalid_child_sheet");
    const other = await household();
    const email = unique("refus");
    expect((await rejectionOf(addGuest(at(), f.session, { ...guestInput(email), childMemberId: other.lea.id }))).code).toBe("invalid_child_sheet");
    expect(await db.selectFrom("users").select("id").where("email", "=", email).execute()).toEqual([]);
    expect(await linkOf(other.lea.id)).toBeNull();
  });

  it("supprimer l'invitation libère la fiche", async () => {
    const f = await household();
    const { guestId } = await addGuest(at(), f.session, { ...guestInput(), childMemberId: f.lea.id });
    await removeGuest(at(), f.session, guestId);
    expect((await listGuests(at(), f.profile.accountId!)).childSheets.map((x) => x.firstName)).toEqual(["Léa"]);
  });

  it("rattrapage : un invité secondaire actif non relié est proposé aux parents tant qu'une fiche enfant est libre ; « Relier » le relie", async () => {
    const f = await household();
    const added = await addAndDeliver(f.session, { ...guestInput(), firstName: "Léa" });
    // En attente d'activation : pas encore proposé.
    expect(await childLinkCandidates(at(), f.session)).toEqual([]);
    await activate(at(), { token: added.token, accepted: true, password: "Motdepasse-2026!", confirmation: "Motdepasse-2026!", timezone: "Europe/Paris", userAgent: null });
    const candidates = await childLinkCandidates(at(), f.session);
    expect(candidates).toEqual([{ userId: added.guestId, firstName: "Léa", sheets: [expect.objectContaining({ memberId: f.lea.id, firstName: "Léa" })] }]);
    // Réservé aux parents : le profil lui-même n'y a pas accès.
    expect((await rejectionOf(childLinkCandidates(at(), await sessionFor(db, added.guestId)))).code).toBe("forbidden");
    await setChildProfile(at(), f.session, f.lea.id, added.guestId);
    expect(await childLinkCandidates(at(), f.session)).toEqual([]);
    expect((await listGuests(at(), f.profile.accountId!)).guests.find((g) => g.id === added.guestId)?.childSheet).toBe("Léa");
  });

  it("écran : les impacts sont affichés avant toute réponse ; « Oui » montre la fiche, le rappel neutre et le lien vers les membres", () => {
    const sheets = [{ memberId: "m1", firstName: "Léa", age: 8 }];
    const render = (props: { kid: boolean | null; sheet: string | null; sheets?: typeof sheets }) => renderToStaticMarkup(createElement(ChildQuestion, { sheets, onKid: () => undefined, onSheet: () => undefined, ...props }));
    const start = render({ kid: null, sheet: null });
    expect(start).toContain("Est-ce un de vos enfants ?");
    expect(start).toContain("Si vous répondez oui, votre enfant aura un espace adapté");
    expect(start).toContain("Si vous répondez non, ce profil verra les RDV de toute la famille, comme tout invité.");
    expect(start).not.toContain("Quelle fiche est la sienne ?");
    expect(render({ kid: false, sheet: null })).not.toContain("Quelle fiche est la sienne ?");
    const yes = render({ kid: true, sheet: "m1" });
    expect(yes).toContain("Quelle fiche est la sienne ?");
    expect(yes).toContain("Enfant · 8 ans · pas encore de profil");
    expect(yes).toContain("Léa verra la tâche des devoirs, ses exercices, son calendrier et seulement ses propres RDV. Pas de tchats des agents ni de catalogue.");
    expect(render({ kid: true, sheet: null })).not.toContain("Léa verra");
    const none = render({ kid: true, sheet: null, sheets: [] });
    expect(none).toContain("Toutes les fiches au rôle « Enfant » ont déjà un profil.");
    expect(none).toContain('href="/assistant/membres"');
  });

  it("écran : le bandeau de rattrapage propose « Relier à [fiche] » et « Non »", () => {
    const html = renderToStaticMarkup(createElement(ChildLinkCard, { candidate: { userId: "u", firstName: "Léa", sheets: [{ memberId: "m1", firstName: "Léa", age: null }] }, busy: false, onLink: () => undefined, onNo: () => undefined }));
    expect(html).toContain("Léa a son profil. Est-ce le profil d&#x27;un de vos enfants ?");
    expect(html).toContain("Relier à Léa");
    expect(html).toContain(">Non<");
    expect(LINK_DONE("Léa")).toBe("Le profil de Léa est relié à sa fiche. Vous pourrez changer ce lien dans Réglages › Membres.");
    expect(LINK_DECLINED).toBe("C'est noté. Vous pourrez relier ce profil plus tard dans Réglages › Membres.");
  });
});
