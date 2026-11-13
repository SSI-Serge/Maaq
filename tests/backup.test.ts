import { gunzipSync } from "node:zlib";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetDailyBackup, runDailyBackup } from "@/server/backup";
import type { DB } from "@/server/db/schema.generated";
import { createProfile, testDb } from "./helpers/fixtures";

let db: Kysely<DB>;
beforeAll(() => {
  db = testDb();
});
afterAll(async () => {
  await db.destroy();
});

function memoryStore() {
  const files = new Map<string, Buffer>();
  return { files, store: { put: async (key: string, bytes: Buffer) => void files.set(key, bytes) } };
}

describe("sauvegarde quotidienne automatique de la base", () => {
  it("sans bucket : rien ; hors de la nuit : rien", async () => {
    resetDailyBackup();
    expect(await runDailyBackup({ db, now: new Date("2026-11-20T02:00:00Z") }, { bucket: undefined })).toEqual({ status: "off" });
    const m = memoryStore();
    expect(await runDailyBackup({ db, now: new Date("2026-11-20T12:00:00Z") }, { store: m.store })).toEqual({ status: "not_due" });
    expect(m.files.size).toBe(0);
  });

  it("la nuit : un fichier compressé par jour, relisible, avec toutes les tables ; pas de second fichier le même jour", async () => {
    resetDailyBackup();
    const profile = await createProfile(db);
    const m = memoryStore();
    const first = await runDailyBackup({ db, now: new Date("2026-11-20T02:05:00Z") }, { store: m.store });
    expect(first).toMatchObject({ status: "done", key: "sauvegarde-2026-11-20.json.gz" });
    const dump = JSON.parse(gunzipSync(m.files.get("sauvegarde-2026-11-20.json.gz")!).toString("utf8")) as { takenAt: string; tables: Record<string, { id?: string }[]> };
    expect(dump.takenAt).toBe("2026-11-20T02:05:00.000Z");
    expect(Object.keys(dump.tables)).toEqual(expect.arrayContaining(["users", "accounts", "family_members", "platform_settings"]));
    expect(dump.tables.users.some((u) => u.id === profile.id)).toBe(true);
    expect(await runDailyBackup({ db, now: new Date("2026-11-20T02:10:00Z") }, { store: m.store })).toEqual({ status: "already_done" });
    expect((await runDailyBackup({ db, now: new Date("2026-11-21T01:00:00Z") }, { store: m.store })).status).toBe("done");
    expect([...m.files.keys()].sort()).toEqual(["sauvegarde-2026-11-20.json.gz", "sauvegarde-2026-11-21.json.gz"]);
  });
});
