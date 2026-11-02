import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { logAdminAction } from "@/server/admin/audit";
import { createSession, getSession, homeFor, type SessionContext } from "@/server/auth/service";
import type { ObjectStore } from "@/server/contracts/storage";
import type { DB } from "@/server/db/schema.generated";
import { forgetManifest, removePresentation, savePresentation } from "@/server/presentation/service";
import { markPresentationSeen } from "@/server/presentation/seen";
import { setPresentationStore } from "@/server/presentation/store";
import { createGuest, createProfile, testDb } from "./helpers/fixtures";

class MemoryStore implements ObjectStore {
  files = new Map<string, Buffer>();
  async put(key: string, bytes: Buffer) {
    this.files.set(key, bytes);
  }
  async get(key: string) {
    const bytes = this.files.get(key);
    if (!bytes) throw new Error("absent");
    return bytes;
  }
  async remove(key: string) {
    this.files.delete(key);
  }
}

const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom", "latin1"), Buffer.alloc(1000, 1)]);
const VTT = Buffer.from("WEBVTT\n\n00:00.000 --> 00:04.000\nMAAQ organise la vie de votre famille.\n", "utf8");

let db: Kysely<DB>;
beforeAll(() => {
  db = testDb();
});
afterAll(async () => {
  await db.destroy();
});
beforeEach(() => {
  setPresentationStore(new MemoryStore());
  forgetManifest();
});
afterEach(() => {
  setPresentationStore(undefined);
  forgetManifest();
});

/** Session ouverte du profil, sur un appareil qui a son schéma (sauf `pattern: false`). */
async function sessionOf(userId: string, pattern = true): Promise<SessionContext> {
  const id = randomUUID();
  await db.insertInto("devices").values({ id, user_id: userId, device_type: "android", browser: "Chrome", pattern_hash: pattern ? "test-pattern" : null }).execute();
  const { token } = await createSession(db, userId, id, new Date());
  const session = await getSession({ db, now: new Date() }, token);
  if (!session) throw new Error("session introuvable");
  return session;
}

const seenAt = async (userId: string) => (await db.selectFrom("users").select("presentation_seen_at").where("id", "=", userId).executeTakeFirstOrThrow()).presentation_seen_at;

describe("« Découvrir MAAQ » dans le parcours (US-140 RF1, RF4)", () => {
  it("sans vidéo configurée, l'écran n'est jamais proposé", async () => {
    const parent = await createProfile(db);
    const session = await sessionOf(parent.id);
    expect(session.user.presentationDue).toBe(false);
    expect(homeFor(session)).toBe("/accueil");
  });

  it("un parent qui n'a pas vu la vidéo la voit avant la configuration initiale, puis le parcours reprend", async () => {
    await savePresentation("admin", { video: MP4, captions: VTT });
    const parent = await createProfile(db, { setupCompleted: false });
    const before = await sessionOf(parent.id);
    expect(before.user.presentationDue).toBe(true);
    expect(homeFor(before)).toBe("/decouvrir");

    await markPresentationSeen({ db, now: new Date() }, before);
    const after = await sessionOf(parent.id);
    expect(after.user.presentationDue).toBe(false);
    expect(homeFor(after)).toBe("/configuration");
  });

  it("un parent déjà configuré la voit une fois, puis arrive sur l'accueil (y compris à la reconnexion)", async () => {
    await savePresentation("admin", { video: MP4, captions: VTT });
    const parent = await createProfile(db);
    expect(homeFor(await sessionOf(parent.id))).toBe("/decouvrir");
    // Reconnexion sans avoir fini : l'écran revient tant qu'il n'est pas vu
    expect(homeFor(await sessionOf(parent.id))).toBe("/decouvrir");
    await markPresentationSeen({ db, now: new Date() }, await sessionOf(parent.id));
    expect(homeFor(await sessionOf(parent.id))).toBe("/accueil");
  });

  it("le schéma tactile passe avant la vidéo, pour un invité comme pour un parent", async () => {
    await savePresentation("admin", { video: MP4, captions: VTT });
    const parent = await createProfile(db);
    const guest = await createGuest(db, parent.accountId!, "Élodie");
    expect(homeFor(await sessionOf(guest.id, false))).toBe("/schema/creer");
    expect(homeFor(await sessionOf(guest.id, true))).toBe("/decouvrir");
  });

  it("un invité (premier ou secondaire) la voit, et seulement lui est marqué : la date est posée une fois et jamais écrasée", async () => {
    await savePresentation("admin", { video: MP4, captions: VTT });
    const parent = await createProfile(db);
    const guest = await createGuest(db, parent.accountId!, "Élodie");
    const session = await sessionOf(guest.id);
    const first = new Date("2026-11-02T10:00:00Z");
    await markPresentationSeen({ db, now: first }, session);
    expect((await seenAt(guest.id))?.toISOString()).toBe(first.toISOString());
    await markPresentationSeen({ db, now: new Date("2026-11-03T10:00:00Z") }, session);
    expect((await seenAt(guest.id))?.toISOString()).toBe(first.toISOString());
    expect(await seenAt(parent.id)).toBeNull();
  });

  it("l'administrateur n'est jamais concerné, et rien n'est écrit pour lui", async () => {
    await savePresentation("admin", { video: MP4, captions: VTT });
    const admin = await createProfile(db, { role: "admin" });
    const session = await sessionOf(admin.id);
    expect(session.user.presentationDue).toBe(false);
    expect(homeFor(session)).toBe("/admin/agents");
    await markPresentationSeen({ db, now: new Date() }, session);
    expect(await seenAt(admin.id)).toBeNull();
  });

  it("retirer la vidéo supprime l'écran pour tous ceux qui ne l'ont pas encore vu", async () => {
    await savePresentation("admin", { video: MP4, captions: VTT });
    const parent = await createProfile(db);
    expect(homeFor(await sessionOf(parent.id))).toBe("/decouvrir");
    await removePresentation();
    expect(homeFor(await sessionOf(parent.id))).toBe("/accueil");
  });
});

describe("journal d'administration de la vidéo (US-140 RF9)", () => {
  it("le dépôt est journalisé avec les éléments touchés, jamais leur contenu", async () => {
    const admin = await createProfile(db, { role: "admin" });
    await logAdminAction(db, { adminId: admin.id, action: "presentation_updated", entityType: "presentation", entityId: "video", details: { elements: ["video", "captions"] }, now: new Date() });
    const row = await db.selectFrom("admin_audit_log").selectAll().where("admin_user_id", "=", admin.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ action_type: "presentation_updated", entity_type: "presentation", entity_id: "video", details: { elements: ["video", "captions"] } });
  });
});
