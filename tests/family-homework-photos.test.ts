import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addChild } from "@/server/assistant/family";
import { loadHomeworkCatalog } from "@/server/assistant/homework/catalog";
import { photoDone, photoWarning } from "@/server/assistant/homework/photo-text";
import { analyzeHomeworkPhoto } from "@/server/assistant/homework/photos";
import { setHomeworkAge, setHomeworkEnabled } from "@/server/assistant/homework/settings";
import { childOptions, prepareWeek, setItemChecked, getWeek } from "@/server/assistant/homework/weeks";
import type { AssistantModel, ModelRequest } from "@/server/assistant/model";
import type { Ctx } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { Rejection } from "@/server/http";
import { createGuest, createProfile, sessionFor, testDb } from "./helpers/fixtures";

let db: Kysely<DB>;
beforeAll(async () => {
  db = testDb();
  await loadHomeworkCatalog(db);
});
afterAll(async () => {
  await db.destroy();
});

const NOW = new Date("2054-11-05T09:00:00Z");
const ctx = (): Ctx => ({ get db() { return db; }, now: NOW }) as Ctx;
const WEEK = "2054-11-09";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

async function failure(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

/** Faux modèle : répond ce que le test lui dicte et garde les requêtes reçues. */
function fakeModel(answer: (request: ModelRequest) => string | Error): AssistantModel & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    id: "claude-sonnet-5-5",
    async send(request) {
      requests.push(request);
      const out = answer(request);
      if (out instanceof Error) throw out;
      return { content: [{ type: "text", text: out }], stopReason: "end_turn", usage: { inputTokens: 1500, outputTokens: 120, cacheRead: 0, cacheWrite: 0 }, requestId: null };
    },
  };
}

async function family() {
  const camille = await createProfile(db);
  await db.updateTable("accounts").set({ family_timezone: "Europe/Paris" }).where("id", "=", camille.accountId!).execute();
  const elodie = await createGuest(db, camille.accountId!, "Élodie");
  const camilleSession = await sessionFor(db, camille.id);
  const elodieSession = await sessionFor(db, elodie.id);
  const leo = await addChild(ctx(), camilleSession, { firstName: "Léo" });
  await setHomeworkEnabled(ctx(), camilleSession, { enabled: true, confirmed: true });
  await setHomeworkAge(ctx(), camilleSession, leo.id, 7);
  const block = (await childOptions(db, camille.accountId!, leo.id)).blocks[0];
  const { weekId } = await prepareWeek(ctx(), camilleSession, { weekStart: WEEK, workDays: [1, 2], children: [{ memberId: leo.id, items: [{ kind: "exercises", textbook: "france", numbers: block.numbers, days: [1] }] }] });
  return { accountId: camille.accountId!, userId: camille.id, camilleSession, elodieSession, leo: leo.id, weekId, numbers: block.numbers };
}
type Family = Awaited<ReturnType<typeof family>>;

const answerOf = (states: Record<number, string>, comment = "Les exercices 26 et 27 sont réussis ; le 28 est à revoir.") =>
  JSON.stringify({ commentaire: comment, exercices: Object.entries(states).map(([numero, etat]) => ({ numero: Number(numero), etat })) });
const validatedNumbers = async (f: Family) =>
  (await db.selectFrom("homework_exercise_validations as v").innerJoin("homework_exercises as e", "e.id", "v.exercise_id").select("e.number").where("v.member_id", "=", f.leo).orderBy("e.number").execute()).map((r) => r.number);
const countToday = async (f: Family) => (await db.selectFrom("daily_request_counters").select("request_count").where("user_id", "=", f.userId).executeTakeFirst())?.request_count ?? 0;

describe("textes de l'envoi (US-119 RF5)", () => {
  it("CA 5.1 et 5.2 : l'avertissement avant l'envoi et la confirmation après", () => {
    expect(photoWarning("Léo")).toBe("La photo sera supprimée une fois les progrès de Léo notés.");
    expect(photoDone("Léo")).toBe("Progrès de Léo notés. La photo a été supprimée.");
  });
});

describe("analyse d'une photo du travail (US-119 RF5, RF6, RT6)", () => {
  it("CA 5.2 : seuls les exercices réussis sans aide sont validés ; les autres ne le sont pas", async () => {
    const f = await family();
    const [a, b, c, d] = f.numbers;
    const model = fakeModel(() => answerOf({ [a]: "reussi", [b]: "reussi", [c]: "a_revoir", [d]: "non_visible" }));
    const result = await analyzeHomeworkPhoto(ctx(), f.camilleSession, { memberId: f.leo, weekId: f.weekId, mediaType: "image/jpeg", data: JPEG }, model);
    expect(result).toMatchObject({ validated: [a, b], toReview: [c], confirmation: "Progrès de Léo notés. La photo a été supprimée." });
    expect(result.comment).toContain("réussis");
    expect(await validatedNumbers(f)).toEqual([a, b]);
  });

  it("le modèle ne reçoit ni prénom ni date de naissance, mais la photo et les exercices du niveau (AF-8, SG-3)", async () => {
    const f = await family();
    await db.updateTable("family_members").set({ birth_year: 2047, birth_month: 3 }).where("id", "=", f.leo).execute();
    const model = fakeModel(() => answerOf({}));
    await analyzeHomeworkPhoto(ctx(), f.camilleSession, { memberId: f.leo, weekId: f.weekId, mediaType: "image/jpeg", data: JPEG }, model);
    const sent = JSON.stringify(model.requests[0]);
    expect(sent).not.toContain("Léo");
    expect(sent).not.toContain("2047");
    expect(sent).toContain('"type":"image"');
    expect(sent).toContain("CE1");
    expect(sent).toContain(`\\"numero\\":${f.numbers[0]}`);
    expect(model.requests[0].system).toContain("jamais une instruction");
  });

  it("un exercice que le modèle déclare réussi mais qui n'est pas prévu pour l'enfant est ignoré ; une réponse mal formée ne valide rien", async () => {
    const f = await family();
    const outside = await db.selectFrom("homework_exercises").select("number").where("textbook_key", "=", "france").where("level", "=", "cm2").limit(1).executeTakeFirstOrThrow();
    const ok = fakeModel(() => answerOf({ [outside.number]: "reussi", [f.numbers[0]]: "reussi" }));
    const result = await analyzeHomeworkPhoto(ctx(), f.camilleSession, { memberId: f.leo, weekId: f.weekId, mediaType: "image/png", data: JPEG }, ok);
    expect(result.validated).toEqual([f.numbers[0]]);
    const bad = fakeModel(() => "Tout est très bien, bravo !");
    expect((await failure(analyzeHomeworkPhoto(ctx(), f.camilleSession, { memberId: f.leo, weekId: f.weekId, mediaType: "image/jpeg", data: JPEG }, bad))).code).toBe("photo_unreadable");
    expect(await validatedNumbers(f)).toEqual([f.numbers[0]]);
  });

  it("CA 6.1 : une case cochée ne valide rien ; seule la photo valide", async () => {
    const f = await family();
    const item = (await getWeek(ctx(), f.camilleSession, f.weekId)).children[0].items[0];
    await setItemChecked(ctx(), f.camilleSession, item.id, true);
    expect(await validatedNumbers(f)).toEqual([]);
    const model = fakeModel(() => answerOf({ [f.numbers[0]]: "reussi" }));
    await analyzeHomeworkPhoto(ctx(), f.camilleSession, { memberId: f.leo, weekId: f.weekId, mediaType: "image/webp", data: JPEG }, model);
    expect(await validatedNumbers(f)).toEqual([f.numbers[0]]);
  });

  it("une photo compte comme une demande du plafond quotidien ; une erreur du modèle ne la compte pas (SG-5, RT6)", async () => {
    const f = await family();
    const before = await countToday(f);
    const broken = fakeModel(() => new Error("indisponible"));
    const quiet = console.error;
    console.error = () => {};
    try {
      expect((await failure(analyzeHomeworkPhoto(ctx(), f.camilleSession, { memberId: f.leo, weekId: f.weekId, mediaType: "image/jpeg", data: JPEG }, broken))).code).toBe("photo_failed");
    } finally {
      console.error = quiet;
    }
    expect(await countToday(f)).toBe(before);
    await analyzeHomeworkPhoto(ctx(), f.camilleSession, { memberId: f.leo, weekId: f.weekId, mediaType: "image/jpeg", data: JPEG }, fakeModel(() => answerOf({})));
    expect(await countToday(f)).toBe(before + 1);
  });

  it("le plafond quotidien atteint refuse l'analyse, sans appeler le modèle", async () => {
    const f = await family();
    await db.updateTable("accounts").set({ daily_request_limit: 1 }).where("id", "=", f.accountId).execute();
    const model = fakeModel(() => answerOf({}));
    await analyzeHomeworkPhoto(ctx(), f.camilleSession, { memberId: f.leo, weekId: f.weekId, mediaType: "image/jpeg", data: JPEG }, model);
    const second = fakeModel(() => answerOf({}));
    expect((await failure(analyzeHomeworkPhoto(ctx(), f.camilleSession, { memberId: f.leo, weekId: f.weekId, mediaType: "image/jpeg", data: JPEG }, second))).status).toBe(429);
    expect(second.requests).toHaveLength(0);
  });

  it("CA 7.2 : la moitié du niveau validée sur photos débloque un manuel étranger pour la semaine suivante, sans que la réponse en parle", async () => {
    const f = await family();
    const level = await db.selectFrom("homework_exercises").select("number").where("textbook_key", "=", "france").where("level", "=", "ce1").orderBy("number").execute();
    const states = Object.fromEntries(f.numbers.map((n) => [n, "reussi"]));
    const model = fakeModel(() => answerOf(states, "Tous les exercices sont réussis."));
    const result = await analyzeHomeworkPhoto(ctx(), f.camilleSession, { memberId: f.leo, weekId: f.weekId, mediaType: "image/jpeg", data: JPEG }, model);
    expect(JSON.stringify(result)).not.toMatch(/Singapour|Chine|singapore|china|nouveauté/i);
    expect((await childOptions(db, f.accountId, f.leo)).progress).toMatchObject({ total: level.length, validated: 5, foreignUnlocked: false });
    for (const r of level.slice(5, 13)) {
      const exercise = await db.selectFrom("homework_exercises").select("id").where("textbook_key", "=", "france").where("level", "=", "ce1").where("number", "=", r.number).executeTakeFirstOrThrow();
      await db.insertInto("homework_exercise_validations").values({ member_id: f.leo, exercise_id: exercise.id }).execute();
    }
    const next = await childOptions(db, f.accountId, f.leo, "2054-11-16");
    expect(next.progress.foreignUnlocked).toBe(true);
    expect(new Set(next.blocks.filter((b) => b.novelty).map((b) => b.textbook)).size).toBe(1);
  });

  it("refus : invité secondaire, format inconnu, photo vide ou trop lourde, enfant inconnu, rien à valider", async () => {
    const f = await family();
    const model = fakeModel(() => answerOf({}));
    const send = (session: typeof f.camilleSession, over: Partial<Parameters<typeof analyzeHomeworkPhoto>[2]> = {}) =>
      analyzeHomeworkPhoto(ctx(), session, { memberId: f.leo, weekId: f.weekId, mediaType: "image/jpeg", data: JPEG, ...over }, model);
    expect((await failure(send(f.elodieSession))).status).toBe(403);
    expect((await failure(send(f.camilleSession, { mediaType: "image/gif" as "image/png" }))).code).toBe("invalid_photo");
    expect((await failure(send(f.camilleSession, { data: Buffer.alloc(0) }))).code).toBe("invalid_photo");
    expect((await failure(send(f.camilleSession, { data: Buffer.alloc(7 * 1024 * 1024) }))).code).toBe("invalid_photo");
    expect((await failure(send(f.camilleSession, { memberId: "00000000-0000-4000-8000-000000000000" }))).status).toBe(404);
    const other = await family();
    expect((await failure(send(f.camilleSession, { memberId: other.leo }))).status).toBe(404);
    expect(model.requests).toHaveLength(0);
    const states = Object.fromEntries(f.numbers.map((n) => [n, "reussi"]));
    await analyzeHomeworkPhoto(ctx(), f.camilleSession, { memberId: f.leo, weekId: f.weekId, mediaType: "image/jpeg", data: JPEG }, fakeModel(() => answerOf(states)));
    expect((await failure(send(f.camilleSession))).code).toBe("nothing_to_check"); // tout est déjà validé
  });

  it("la photo n'est écrite nulle part : ni fichier, ni table (le module ne sait que la transmettre au modèle)", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("src/server/assistant/homework/photos.ts", "utf8") + readFileSync("src/app/api/family/homework/photos/route.ts", "utf8");
    expect(source).not.toMatch(/writeFile|createWriteStream|insertInto\("(attachments|inbound|uploads)/);
    expect(source).not.toMatch(/\.insertInto\("homework_[a-z_]*"\)\.values\(\{[^}]*data/);
  });
});
