import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkCode, issueCode } from "@/server/auth/codes";
import { maskEmail, maskPhone } from "@/server/auth/format";
import {
  completePasswordReset,
  getSession,
  homeFor,
  login,
  logout,
  requestRecoveryCode,
  sendDeviceCode,
  setPattern,
  unlockWithPattern,
  verifyDevice,
  verifyRecoveryCode,
  type Ctx,
  type SessionContext,
} from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { createProfile, lastCodeSentTo, messagesTo, minutesLater, PASSWORD, testDb } from "./helpers/fixtures";

let db: Kysely<DB>;
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const PATTERN = [0, 1, 2, 5, 8];

beforeAll(() => {
  db = testDb();
});
afterAll(async () => {
  await db.destroy();
});

function at(now: Date): Ctx {
  return { db, now };
}

/** Connexion complète sur un nouvel appareil : mot de passe, code reçu par email, session ouverte. */
async function signInNewDevice(email: string, now = new Date()) {
  const first = await login(at(now), { email, password: PASSWORD, knownDeviceIds: [], timezone: "Europe/Paris" });
  if (first.kind !== "verify") throw new Error(`attendu : vérification, obtenu ${first.kind}`);
  const pending = { userId: first.userId, deviceIdentifier: first.deviceIdentifier, timezone: "Europe/Paris" };
  await sendDeviceCode(at(now), pending, "email");
  const code = await lastCodeSentTo(email);
  const verified = await verifyDevice(at(now), pending, code!, ANDROID);
  if (verified.kind !== "session") throw new Error(`attendu : session, obtenu ${verified.kind}`);
  return verified;
}

async function sessionOf(token: string, now = new Date()): Promise<SessionContext> {
  const session = await getSession(at(now), token);
  if (!session) throw new Error("session introuvable");
  return session;
}

describe("US-3 — connexion par mot de passe", () => {
  it("RF3 : un email inconnu et un mauvais mot de passe donnent le même refus", async () => {
    const profile = await createProfile(db);
    const unknown = await login(at(new Date()), { email: "inconnu@maaq.test", password: PASSWORD, knownDeviceIds: [], timezone: "UTC" });
    const wrong = await login(at(new Date()), { email: profile.email, password: "mauvais-1234", knownDeviceIds: [], timezone: "UTC" });
    expect(unknown).toEqual({ kind: "invalid" });
    expect(wrong).toEqual({ kind: "invalid" });
  });

  it("l'email est reconnu sans tenir compte de la casse", async () => {
    const profile = await createProfile(db);
    const result = await login(at(new Date()), { email: profile.email.toUpperCase(), password: PASSWORD, knownDeviceIds: [], timezone: "UTC" });
    expect(result.kind).toBe("verify");
  });

  it("RF4 : 5 échecs bloquent la connexion 15 minutes, même avec le bon mot de passe", async () => {
    const profile = await createProfile(db);
    const now = new Date();
    for (let i = 0; i < 4; i++) {
      expect((await login(at(now), { email: profile.email, password: "mauvais-1234", knownDeviceIds: [], timezone: "UTC" })).kind).toBe("invalid");
    }
    const fifth = await login(at(now), { email: profile.email, password: "mauvais-1234", knownDeviceIds: [], timezone: "UTC" });
    expect(fifth.kind).toBe("locked");
    if (fifth.kind === "locked") expect(fifth.until.getTime()).toBe(minutesLater(now, 15).getTime());

    const blocked = await login(at(minutesLater(now, 5)), { email: profile.email, password: PASSWORD, knownDeviceIds: [], timezone: "UTC" });
    expect(blocked.kind).toBe("locked");

    const after = await login(at(minutesLater(now, 16)), { email: profile.email, password: PASSWORD, knownDeviceIds: [], timezone: "UTC" });
    expect(after.kind).toBe("verify");
    const events = await db.selectFrom("security_events").select("event_type").where("user_id", "=", profile.id).execute();
    expect(events.map((e) => e.event_type)).toContain("login_locked");
  });

  it("RF10 : un invité supprimé ou un profil jamais activé reçoit le refus standard", async () => {
    const removed = await createProfile(db, { role: "guest", status: "removed" });
    const pending = await createProfile(db, { role: "guest", status: "pending_activation" });
    for (const email of [removed.email, pending.email]) {
      expect(await login(at(new Date()), { email, password: PASSWORD, knownDeviceIds: [], timezone: "UTC" })).toEqual({ kind: "invalid" });
    }
  });

  it("RF6 : chaque profil arrive sur son écran", async () => {
    const admin = await createProfile(db, { role: "admin" });
    const notConfigured = await createProfile(db, { setupCompleted: false });
    const adminSession = await signInNewDevice(admin.email);
    expect(adminSession.next).toBe("/admin");

    const primary = await signInNewDevice(notConfigured.email);
    expect(primary.next).toBe("/schema/creer"); // RF7 : schéma d'abord
    await setPattern(at(new Date()), { userId: notConfigured.id, deviceId: primary.deviceId, points: PATTERN, mode: "first" });
    expect(homeFor(await sessionOf(primary.token))).toBe("/configuration");
  });

  it("RF11 : un compte en délai de grâce est dirigé vers la reprise de compte", async () => {
    const profile = await createProfile(db, { accountStatus: "grace_period" });
    const session = await signInNewDevice(profile.email);
    await setPattern(at(new Date()), { userId: profile.id, deviceId: session.deviceId, points: PATTERN, mode: "first" });
    expect(homeFor(await sessionOf(session.token))).toBe("/reprise-compte");
  });
});

describe("US-51 — vérification d'un nouvel appareil", () => {
  it("RF1-RF3, RF8 : le code reçu ouvre la session et enregistre l'appareil", async () => {
    const profile = await createProfile(db);
    const session = await signInNewDevice(profile.email);
    const device = await db.selectFrom("devices").selectAll().where("id", "=", session.deviceId).executeTakeFirstOrThrow();
    expect(device).toMatchObject({ user_id: profile.id, device_type: "android", browser: "Chrome", timezone: "Europe/Paris" });
    const subjects = (await messagesTo(profile.email)).map((m) => m.subject);
    expect(subjects).toContain("Nouvel appareil connecté à votre compte");
  });

  it("RF7 : un appareil reconnu ne redemande pas de code", async () => {
    const profile = await createProfile(db);
    const first = await signInNewDevice(profile.email);
    const again = await login(at(new Date()), { email: profile.email, password: PASSWORD, knownDeviceIds: [first.deviceId], timezone: "UTC" });
    expect(again.kind).toBe("session");
  });

  it("RF7 : un appareil révoqué redemande la vérification", async () => {
    const profile = await createProfile(db);
    const first = await signInNewDevice(profile.email);
    await db.updateTable("devices").set({ revoked_at: new Date() }).where("id", "=", first.deviceId).execute();
    const again = await login(at(new Date()), { email: profile.email, password: PASSWORD, knownDeviceIds: [first.deviceId], timezone: "UTC" });
    expect(again.kind).toBe("verify");
    expect(await getSession(at(new Date()), first.token)).toBeNull();
  });

  it("RF1 : le SMS n'est possible que si un numéro est connu", async () => {
    const profile = await createProfile(db, { phone: null });
    const first = await login(at(new Date()), { email: profile.email, password: PASSWORD, knownDeviceIds: [], timezone: "UTC" });
    if (first.kind !== "verify") throw new Error("vérification attendue");
    const result = await sendDeviceCode(at(new Date()), { userId: first.userId, deviceIdentifier: first.deviceIdentifier, timezone: "UTC" }, "sms");
    expect(result).toEqual({ kind: "no_phone" });
  });

  it("RF4 : un code faux est refusé, sans ouvrir de session", async () => {
    const profile = await createProfile(db);
    const first = await login(at(new Date()), { email: profile.email, password: PASSWORD, knownDeviceIds: [], timezone: "UTC" });
    if (first.kind !== "verify") throw new Error("vérification attendue");
    const pending = { userId: first.userId, deviceIdentifier: first.deviceIdentifier, timezone: "UTC" };
    await sendDeviceCode(at(new Date()), pending, "email");
    const code = (await lastCodeSentTo(profile.email))!;
    const wrong = code === "000000" ? "111111" : "000000";
    expect((await verifyDevice(at(new Date()), pending, wrong, ANDROID)).kind).toBe("incorrect");
  });
});

describe("Codes à 6 chiffres (US-8, US-51, US-66)", () => {
  it("expirent après leur durée de validité", async () => {
    const profile = await createProfile(db);
    const now = new Date();
    const issued = await issueCode(db, { userId: profile.id, purpose: "device_verification", channel: "email", target: profile.email, deviceIdentifier: crypto.randomUUID(), now });
    if (!issued.ok) throw new Error("code attendu");
    expect(await checkCode(db, { userId: profile.id, purpose: "device_verification", code: issued.code, now: minutesLater(now, 11) })).toBe("expired");
  });

  it("ne servent qu'une fois", async () => {
    const profile = await createProfile(db);
    const now = new Date();
    const issued = await issueCode(db, { userId: profile.id, purpose: "password_reset", channel: "email", target: profile.email, now });
    if (!issued.ok) throw new Error("code attendu");
    expect(await checkCode(db, { userId: profile.id, purpose: "password_reset", code: issued.code, now })).toBe("ok");
    expect(await checkCode(db, { userId: profile.id, purpose: "password_reset", code: issued.code, now })).toBe("missing");
  });

  it("sont invalidés après 5 essais incorrects", async () => {
    const profile = await createProfile(db);
    const now = new Date();
    const issued = await issueCode(db, { userId: profile.id, purpose: "access_recovery", channel: "email", target: profile.email, now });
    if (!issued.ok) throw new Error("code attendu");
    const wrong = issued.code === "000000" ? "111111" : "000000";
    const results = [];
    for (let i = 0; i < 5; i++) results.push(await checkCode(db, { userId: profile.id, purpose: "access_recovery", code: wrong, now }));
    expect(results).toEqual(["incorrect", "incorrect", "incorrect", "incorrect", "invalidated"]);
    expect(await checkCode(db, { userId: profile.id, purpose: "access_recovery", code: issued.code, now })).toBe("invalidated");
  });

  it("US-8 RF8 : nouveau code après 60 s, 5 envois par heure au maximum", async () => {
    const profile = await createProfile(db);
    const start = new Date();
    const send = (now: Date) => issueCode(db, { userId: profile.id, purpose: "access_recovery", channel: "email", target: profile.email, now });
    expect((await send(start)).ok).toBe(true);
    const tooSoon = await send(new Date(start.getTime() + 30_000));
    expect(tooSoon).toMatchObject({ ok: false, reason: "cooldown" });
    for (let i = 1; i < 5; i++) expect((await send(minutesLater(start, i * 2))).ok).toBe(true);
    expect(await send(minutesLater(start, 12))).toMatchObject({ ok: false, reason: "rate_limited" });
    expect((await send(minutesLater(start, 61))).ok).toBe(true);
  });

  it("un nouveau code remplace le précédent", async () => {
    const profile = await createProfile(db);
    const now = new Date();
    const first = await issueCode(db, { userId: profile.id, purpose: "password_reset", channel: "email", target: profile.email, now });
    const second = await issueCode(db, { userId: profile.id, purpose: "password_reset", channel: "email", target: profile.email, now: minutesLater(now, 2) });
    if (!first.ok || !second.ok) throw new Error("codes attendus");
    if (first.code !== second.code) {
      expect(await checkCode(db, { userId: profile.id, purpose: "password_reset", code: first.code, now: minutesLater(now, 2) })).toBe("incorrect");
    }
    expect(await checkCode(db, { userId: profile.id, purpose: "password_reset", code: second.code, now: minutesLater(now, 2) })).toBe("ok");
  });
});

describe("US-6 / US-7 — schéma tactile", () => {
  it("RF5-RF8 : déverrouille, compte les échecs, verrouille au 3e et prévient par email", async () => {
    const profile = await createProfile(db);
    const signed = await signInNewDevice(profile.email);
    await setPattern(at(new Date()), { userId: profile.id, deviceId: signed.deviceId, points: PATTERN, mode: "first" });
    const session = await sessionOf(signed.token);

    expect(await unlockWithPattern(at(new Date()), session, PATTERN)).toEqual({ kind: "ok" });
    expect(await unlockWithPattern(at(new Date()), session, [0, 3, 6, 7])).toEqual({ kind: "incorrect", remaining: 2 });
    expect(await unlockWithPattern(at(new Date()), session, [0, 3, 6, 7])).toEqual({ kind: "incorrect", remaining: 1 });
    expect(await unlockWithPattern(at(new Date()), session, [0, 3, 6, 7])).toEqual({ kind: "locked" });
    // US-7 RF3 : même le bon schéma ne passe plus.
    expect(await unlockWithPattern(at(new Date()), session, PATTERN)).toEqual({ kind: "locked" });

    const subjects = (await messagesTo(profile.email)).map((m) => m.subject);
    expect(subjects).toContain("Accès par schéma tactile verrouillé");
    expect(homeFor(await sessionOf(signed.token))).toBe("/schema/creer"); // US-7 RF4
  });

  it("RF8 : un schéma correct remet le compteur à zéro", async () => {
    const profile = await createProfile(db);
    const signed = await signInNewDevice(profile.email);
    await setPattern(at(new Date()), { userId: profile.id, deviceId: signed.deviceId, points: PATTERN, mode: "first" });
    const session = await sessionOf(signed.token);
    await unlockWithPattern(at(new Date()), session, [8, 7, 6, 3]);
    await unlockWithPattern(at(new Date()), session, [8, 7, 6, 3]);
    expect(await unlockWithPattern(at(new Date()), session, PATTERN)).toEqual({ kind: "ok" });
    expect(await unlockWithPattern(at(new Date()), session, [8, 7, 6, 3])).toEqual({ kind: "incorrect", remaining: 2 });
  });

  it("RF11 : le schéma est propre à chaque appareil", async () => {
    const profile = await createProfile(db);
    const phoneA = await signInNewDevice(profile.email);
    const phoneB = await signInNewDevice(profile.email, minutesLater(new Date(), 2)); // 2e code : après le délai de 60 s
    await setPattern(at(new Date()), { userId: profile.id, deviceId: phoneA.deviceId, points: PATTERN, mode: "first" });
    await setPattern(at(new Date()), { userId: profile.id, deviceId: phoneB.deviceId, points: [6, 7, 8, 5], mode: "first" });
    expect((await unlockWithPattern(at(new Date()), await sessionOf(phoneA.token), [6, 7, 8, 5])).kind).toBe("incorrect");
    expect((await unlockWithPattern(at(new Date()), await sessionOf(phoneB.token), [6, 7, 8, 5])).kind).toBe("ok");
  });

  it("RF12 : l'administrateur n'a pas de schéma", async () => {
    const admin = await createProfile(db, { role: "admin" });
    const signed = await signInNewDevice(admin.email);
    expect(await setPattern(at(new Date()), { userId: admin.id, deviceId: signed.deviceId, points: PATTERN, mode: "first" })).toBe(false);
  });

  it("RT1 : le schéma n'est jamais stocké en clair", async () => {
    const profile = await createProfile(db);
    const signed = await signInNewDevice(profile.email);
    await setPattern(at(new Date()), { userId: profile.id, deviceId: signed.deviceId, points: PATTERN, mode: "first" });
    const { pattern_hash } = await db.selectFrom("devices").select("pattern_hash").where("id", "=", signed.deviceId).executeTakeFirstOrThrow();
    expect(pattern_hash).toMatch(/^\$argon2id\$/);
    expect(pattern_hash).not.toContain("0-1-2-5-8");
  });
});

describe("US-8 — récupération du schéma", () => {
  it("RF3-RF5, RF9 : un code reçu par email permet de recréer le schéma et lève le verrouillage", async () => {
    const profile = await createProfile(db);
    const signed = await signInNewDevice(profile.email);
    await setPattern(at(new Date()), { userId: profile.id, deviceId: signed.deviceId, points: PATTERN, mode: "first" });
    await db.updateTable("devices").set({ pattern_locked_at: new Date(), pattern_failed_count: 3 }).where("id", "=", signed.deviceId).execute();

    await requestRecoveryCode(at(new Date()), profile.email, "access_recovery");
    const code = await lastCodeSentTo(profile.email);
    const verified = await verifyRecoveryCode(at(new Date()), {
      email: profile.email,
      code: code!,
      purpose: "access_recovery",
      knownDeviceIds: [signed.deviceId],
    });
    expect(verified).toMatchObject({ kind: "ok", userId: profile.id, deviceId: signed.deviceId });

    await setPattern(at(new Date()), { userId: profile.id, deviceId: signed.deviceId, points: [2, 4, 6, 7], mode: "recovery" });
    const session = await sessionOf(signed.token);
    expect(session.device.patternLocked).toBe(false);
    expect(await unlockWithPattern(at(new Date()), session, [2, 4, 6, 7])).toEqual({ kind: "ok" });
    expect((await messagesTo(profile.email)).map((m) => m.subject)).toContain("Votre schéma tactile a été modifié");
  });

  it("RF3 : aucun email n'est envoyé pour une adresse inconnue, sans que la réponse le révèle", async () => {
    await expect(requestRecoveryCode(at(new Date()), "personne@maaq.test", "access_recovery")).resolves.toBeUndefined();
    expect(await messagesTo("personne@maaq.test")).toEqual([]);
  });
});

describe("US-66 — mot de passe oublié", () => {
  it("RF6-RF10 : nouveau mot de passe, blocage levé, autres sessions fermées, email de confirmation", async () => {
    const profile = await createProfile(db);
    const phoneA = await signInNewDevice(profile.email);
    const phoneB = await signInNewDevice(profile.email, minutesLater(new Date(), 2));
    await db.updateTable("users").set({ login_locked_until: minutesLater(new Date(), 10), failed_login_count: 0 }).where("id", "=", profile.id).execute();

    await requestRecoveryCode(at(new Date()), profile.email, "password_reset");
    const code = await lastCodeSentTo(profile.email);
    const verified = await verifyRecoveryCode(at(new Date()), {
      email: profile.email,
      code: code!,
      purpose: "password_reset",
      knownDeviceIds: [phoneA.deviceId],
    });
    if (verified.kind !== "ok") throw new Error("code attendu valide");

    const base = { userId: profile.id, deviceId: verified.deviceId, timezone: "Europe/Paris" };
    expect(await completePasswordReset(at(new Date()), { ...base, password: "court1", confirmation: "court1" })).toEqual({ kind: "weak" });
    expect(await completePasswordReset(at(new Date()), { ...base, password: "Nouveau-2026", confirmation: "Nouveau-2027" })).toEqual({ kind: "mismatch" });
    expect(await completePasswordReset(at(new Date()), { ...base, password: "Nouveau-2026", confirmation: "Nouveau-2026" })).toEqual({
      kind: "ok",
      offerPattern: true,
    });

    expect(await getSession(at(new Date()), phoneA.token)).not.toBeNull();
    expect(await getSession(at(new Date()), phoneB.token)).toBeNull();
    const relogin = await login(at(new Date()), { email: profile.email, password: "Nouveau-2026", knownDeviceIds: [phoneA.deviceId], timezone: "UTC" });
    expect(relogin.kind).toBe("session");
    expect((await messagesTo(profile.email)).map((m) => m.subject)).toContain("Votre mot de passe a été modifié");
  });

  it("RF11 : un compte en délai de grâce ne reçoit aucun code", async () => {
    const profile = await createProfile(db, { accountStatus: "grace_period" });
    await requestRecoveryCode(at(new Date()), profile.email, "password_reset");
    expect(await messagesTo(profile.email)).toEqual([]);
  });

  it("RF12 : pas de proposition de schéma pour l'administrateur", async () => {
    const admin = await createProfile(db, { role: "admin" });
    const signed = await signInNewDevice(admin.email);
    const result = await completePasswordReset(at(new Date()), {
      userId: admin.id,
      deviceId: signed.deviceId,
      password: "Admin-nouveau-1",
      confirmation: "Admin-nouveau-1",
      timezone: "UTC",
    });
    expect(result).toEqual({ kind: "ok", offerPattern: false });
  });
});

describe("US-9 — déconnexion", () => {
  it("RF4, RT1 : la session est invalidée côté serveur et l'effacement des tchats demandé", async () => {
    const profile = await createProfile(db);
    const signed = await signInNewDevice(profile.email);
    await logout(at(new Date()), await sessionOf(signed.token));
    expect(await getSession(at(new Date()), signed.token)).toBeNull();
    const request = await db.selectFrom("chat_erasure_requests").selectAll().where("user_id", "=", profile.id).executeTakeFirstOrThrow();
    expect(request).toMatchObject({ reason: "logout", status: "done" });
  });

  it("RF6 : après la déconnexion, l'appareil reste reconnu", async () => {
    const profile = await createProfile(db);
    const signed = await signInNewDevice(profile.email);
    await logout(at(new Date()), await sessionOf(signed.token));
    const again = await login(at(new Date()), { email: profile.email, password: PASSWORD, knownDeviceIds: [signed.deviceId], timezone: "UTC" });
    expect(again.kind).toBe("session");
  });
});

describe("Sessions", () => {
  it("US-6 RT3 : une session mémorisée expire après 3 mois", async () => {
    const profile = await createProfile(db);
    const signed = await signInNewDevice(profile.email);
    const in89Days = new Date(Date.now() + 89 * 86_400_000);
    const in93Days = new Date(Date.now() + 93 * 86_400_000);
    expect(await getSession(at(in89Days), signed.token)).not.toBeNull();
    expect(await getSession(at(in93Days), signed.token)).toBeNull();
  });
});

describe("Mise en forme", () => {
  it("masque l'email et le téléphone comme les maquettes", () => {
    expect(maskEmail("camille@exemple.fr")).toBe("c•••••@exemple.fr");
    expect(maskPhone("+33612345678")).toBe("06 •• •• 56 78");
  });
});
