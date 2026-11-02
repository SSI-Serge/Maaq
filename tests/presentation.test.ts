import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ObjectStore } from "@/server/contracts/storage";
import { Rejection } from "@/server/http";
import { MAX_VIDEO_BYTES, forgetManifest, getPresentation, imageType, isMp4, isVtt, parseRange, readMedia, removePresentation, savePresentation, sizeLabel, adminView } from "@/server/presentation/service";
import { setPresentationStore } from "@/server/presentation/store";

class MemoryStore implements ObjectStore {
  files = new Map<string, Buffer>();
  failOn: string | null = null;
  async put(key: string, bytes: Buffer) {
    if (this.failOn && key.includes(this.failOn)) throw new Error("stockage indisponible");
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

const MP4 = (size = 2_000_000) => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom", "latin1"), Buffer.alloc(size - 12, 1)]);
const VTT = Buffer.from("WEBVTT\n\n00:00.000 --> 00:04.000\nMAAQ, l'assistant qui organise la vie de votre famille.\n", "utf8");
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 2)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 3)]);

let store: MemoryStore;
beforeEach(() => {
  store = new MemoryStore();
  setPresentationStore(store);
  forgetManifest();
});
afterEach(() => {
  setPresentationStore(undefined);
  forgetManifest();
});

async function refusal(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Rejection) return error;
    throw error;
  }
  throw new Error("un refus était attendu");
}

describe("vidéo de présentation : dépôt par l'administrateur (US-140 RF9)", () => {
  it("sans dépôt, aucune vidéo n'est configurée : l'écran n'est jamais proposé", async () => {
    expect(await getPresentation()).toBeNull();
    expect((await adminView()).view).toBeNull();
    expect(await readMedia("video")).toBeNull();
  });

  it("un premier dépôt demande la vidéo ET ses sous-titres (RF3) ; ni l'un ni l'autre seuls ne suffisent", async () => {
    expect((await refusal(savePresentation("admin-1", { video: MP4() }))).code).toBe("invalid_file");
    expect((await refusal(savePresentation("admin-1", { captions: VTT }))).message).toMatch(/sous-titres/);
    expect(await getPresentation()).toBeNull();
    expect(store.files.size).toBe(0);
  });

  it("contrôle le type réel des fichiers et leur taille", async () => {
    expect((await refusal(savePresentation("a", { video: Buffer.from("pas une vidéo, juste du texte assez long"), captions: VTT }))).message).toMatch(/MP4/);
    expect((await refusal(savePresentation("a", { video: MP4(MAX_VIDEO_BYTES + 1), captions: VTT }))).message).toMatch(/15 Mo/);
    expect((await refusal(savePresentation("a", { video: MP4(), captions: Buffer.from("1\n00:00 --> 00:01\nSRT") }))).message).toMatch(/WebVTT/);
    expect((await refusal(savePresentation("a", { video: MP4(), captions: VTT, poster: Buffer.from("gif89a....................") }))).message).toMatch(/JPEG, PNG ou WebP/);
    expect((await refusal(savePresentation("a", { video: MP4(), captions: VTT, durationLabel: "x".repeat(31) }))).message).toMatch(/durée/);
    expect(store.files.size).toBe(0);
  });

  it("un dépôt complet configure la vidéo : adresses versionnées, taille, durée, transcription ; les fichiers sont servis avec leur type", async () => {
    const view = await savePresentation("admin-1", { video: MP4(2_500_000), captions: VTT, poster: JPEG, durationLabel: "1 min 20", transcript: "MAAQ range vos rendez-vous." });
    expect(view).toMatchObject({ sizeBytes: 2_500_000, sizeLabel: "2,4 Mo", durationLabel: "1 min 20", transcript: "MAAQ range vos rendez-vous." });
    expect(view.videoUrl).toBe(`/api/presentation/video?v=${view.version}`);
    expect(view.posterUrl).toBe(`/api/presentation/poster?v=${view.version}`);
    expect(await getPresentation()).toEqual(view);
    expect(await readMedia("video")).toMatchObject({ contentType: "video/mp4", version: view.version });
    expect((await readMedia("captions"))?.contentType).toBe("text/vtt; charset=utf-8");
    expect((await readMedia("poster"))?.contentType).toBe("image/jpeg");
    expect((await adminView()).missing).toEqual([]);
    expect([...store.files.keys()].sort()).toEqual([`presentation/${view.version}/captions.vtt`, `presentation/${view.version}/poster.jpg`, `presentation/${view.version}/video.mp4`, "presentation/manifest.json"].sort());
  });

  it("sans image, durée ni transcription : publiable, l'administrateur voit ce qui manque", async () => {
    const view = await savePresentation("admin-1", { video: MP4(), captions: VTT });
    expect(view.posterUrl).toBeNull();
    expect((await adminView()).missing).toEqual(["l'image d'aperçu", "la transcription du texte de la vidéo", "la durée affichée"]);
  });

  it("remplacer un seul élément garde les autres, change la version et efface les fichiers remplacés", async () => {
    const first = await savePresentation("admin-1", { video: MP4(), captions: VTT, poster: JPEG });
    const second = await savePresentation("admin-2", { poster: PNG, transcript: "Texte" });
    expect(second.version).not.toBe(first.version);
    expect(second.posterUrl).toContain(second.version);
    expect((await readMedia("poster"))?.contentType).toBe("image/png");
    expect(second.transcript).toBe("Texte");
    // la vidéo et les sous-titres n'ont pas bougé (fichiers de la première version) ; l'ancienne image a disparu
    expect(store.files.has(`presentation/${first.version}/video.mp4`)).toBe(true);
    expect(store.files.has(`presentation/${first.version}/captions.vtt`)).toBe(true);
    expect(store.files.has(`presentation/${first.version}/poster.jpg`)).toBe(false);
    const third = await savePresentation("admin-2", { video: MP4(1_000_000) });
    expect(third.sizeBytes).toBe(1_000_000);
    expect(store.files.has(`presentation/${first.version}/video.mp4`)).toBe(false);
    expect(store.files.has(`presentation/${first.version}/captions.vtt`)).toBe(true);
    expect((await savePresentation("admin-2", { durationLabel: "" })).durationLabel).toBeNull();
  });

  it("un échec du stockage laisse la présentation d'avant intacte et ne laisse aucun fichier orphelin", async () => {
    const first = await savePresentation("admin-1", { video: MP4(), captions: VTT });
    const before = [...store.files.keys()].sort();
    store.failOn = "captions.vtt";
    await expect(savePresentation("admin-1", { video: MP4(1_500_000), captions: VTT })).rejects.toThrow(/stockage indisponible/);
    store.failOn = null;
    forgetManifest();
    expect([...store.files.keys()].sort()).toEqual(before);
    expect((await getPresentation())?.version).toBe(first.version);
  });

  it("retirer la présentation : plus aucune vidéo configurée, tous les fichiers effacés", async () => {
    await savePresentation("admin-1", { video: MP4(), captions: VTT, poster: JPEG });
    await removePresentation();
    expect(await getPresentation()).toBeNull();
    expect(store.files.size).toBe(0);
    await removePresentation(); // sans effet quand il n'y a rien
  });

  it("un stockage illisible vaut « aucune vidéo » : l'application continue sans l'écran", async () => {
    setPresentationStore({ put: async () => {}, remove: async () => {}, get: async () => Promise.reject(new Error("hors service")) });
    forgetManifest();
    expect(await getPresentation()).toBeNull();
  });
});

describe("lecture partielle de la vidéo (Range, nécessaire sur iPhone)", () => {
  it("analyse les plages demandées", () => {
    expect(parseRange(null, 1000)).toBeNull();
    expect(parseRange("bytes=0-499", 1000)).toEqual({ start: 0, end: 499 });
    expect(parseRange("bytes=500-", 1000)).toEqual({ start: 500, end: 999 });
    expect(parseRange("bytes=-200", 1000)).toEqual({ start: 800, end: 999 });
    expect(parseRange("bytes=900-5000", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=0-0", 1000)).toEqual({ start: 0, end: 0 });
  });

  it("refuse une plage hors du fichier ou incohérente, ignore ce qui n'est pas une plage d'octets", () => {
    expect(parseRange("bytes=1000-", 1000)).toBe("invalid");
    expect(parseRange("bytes=600-500", 1000)).toBe("invalid");
    expect(parseRange("bytes=-0", 1000)).toBe("invalid");
    expect(parseRange("items=0-5", 1000)).toBeNull();
    expect(parseRange("bytes=0-5,10-20", 1000)).toBeNull();
  });
});

describe("contrôles de format et libellés", () => {
  it("reconnaît MP4, WebVTT et les images d'après leur contenu, pas leur nom", () => {
    expect(isMp4(MP4())).toBe(true);
    expect(isMp4(Buffer.from("RIFF....AVI LIST...."))).toBe(false);
    expect(isVtt(VTT)).toBe(true);
    expect(isVtt(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), VTT]))).toBe(true);
    expect(isVtt(Buffer.from("WEBVTTX"))).toBe(false);
    expect(imageType(JPEG)).toBe("image/jpeg");
    expect(imageType(PNG)).toBe("image/png");
    expect(imageType(Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WEBP", "latin1"), Buffer.alloc(8)]))).toBe("image/webp");
    expect(imageType(Buffer.from("<svg xmlns=...>............"))).toBeNull();
  });

  it("indique la taille en Mo, avec une décimale sous 10 Mo", () => {
    expect(sizeLabel(12 * 1_048_576)).toBe("12 Mo");
    expect(sizeLabel(2_500_000)).toBe("2,4 Mo");
    expect(sizeLabel(15 * 1_048_576)).toBe("15 Mo");
  });
});
