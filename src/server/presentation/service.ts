import { randomBytes } from "node:crypto";
import { Rejection } from "@/server/http";
import { describeError } from "@/server/safe-log";
import { MANIFEST_KEY, presentationStore } from "./store";

/**
 * Vidéo de présentation de MAAQ (US-140). L'administrateur dépose la vidéo, ses sous-titres, l'image d'aperçu, la durée affichée et la transcription depuis la console
 * (RF9) ; une petite description (`manifest.json`) est écrite à côté des fichiers et dit qu'une vidéo est « configurée ». Rien en base, aucune livraison.
 * Le serveur de MAAQ sert lui-même les fichiers : aucun tiers, aucun cookie, aucun lien signé, aucun suivi de lecture (RT1).
 */

export const MAX_VIDEO_BYTES = 15 * 1_048_576;
export const MAX_CAPTIONS_BYTES = 200 * 1024;
export const MAX_POSTER_BYTES = 1_048_576;
export const MAX_TRANSCRIPT_CHARS = 8000;
export const MAX_DURATION_LABEL = 30;

export type MediaKind = "video" | "captions" | "poster";

export interface Manifest {
  version: string;
  video: { key: string; size: number };
  captions: { key: string };
  poster: { key: string; type: "image/jpeg" | "image/png" | "image/webp" } | null;
  durationLabel: string | null;
  transcript: string | null;
  updatedAt: string;
  updatedBy: string | null;
}

/** Ce que voit un profil connecté : adresses des fichiers (versionnées), taille, durée, transcription. */
export interface PresentationView {
  version: string;
  videoUrl: string;
  captionsUrl: string;
  posterUrl: string | null;
  sizeBytes: number;
  /** « 12 Mo » */
  sizeLabel: string;
  durationLabel: string | null;
  transcript: string | null;
  updatedAt: string;
}

export const sizeLabel = (bytes: number) => `${(bytes / 1_048_576).toLocaleString("fr-FR", { maximumFractionDigits: bytes < 10 * 1_048_576 ? 1 : 0 })} Mo`;

// ---------------------------------------------------------------------------------------------------------------------------
// Lecture de la description (gardée 30 secondes : l'entrée est lue à chaque ouverture de session)
// ---------------------------------------------------------------------------------------------------------------------------

let cache: { at: number; manifest: Manifest | null } | null = null;
const CACHE_MS = 30_000;

export function forgetManifest(): void {
  cache = null;
}

export async function readManifest(): Promise<Manifest | null> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.manifest;
  let manifest: Manifest | null = null;
  try {
    manifest = JSON.parse((await presentationStore().get(MANIFEST_KEY)).toString("utf8")) as Manifest;
    if (!manifest?.video?.key || !manifest.captions?.key) manifest = null;
  } catch {
    manifest = null; // pas de description (ou stockage indisponible) : aucune vidéo configurée, l'application continue sans
  }
  cache = { at: Date.now(), manifest };
  return manifest;
}

/** Une vidéo est-elle configurée ? Sans vidéo, l'écran n'est jamais proposé (US-140). */
export async function presentationConfigured(): Promise<boolean> {
  return (await readManifest()) !== null;
}

export function viewOf(manifest: Manifest): PresentationView {
  const v = encodeURIComponent(manifest.version);
  return {
    version: manifest.version,
    videoUrl: `/api/presentation/video?v=${v}`,
    captionsUrl: `/api/presentation/captions?v=${v}`,
    posterUrl: manifest.poster ? `/api/presentation/poster?v=${v}` : null,
    sizeBytes: manifest.video.size,
    sizeLabel: sizeLabel(manifest.video.size),
    durationLabel: manifest.durationLabel,
    transcript: manifest.transcript,
    updatedAt: manifest.updatedAt,
  };
}

export async function getPresentation(): Promise<PresentationView | null> {
  const manifest = await readManifest();
  return manifest ? viewOf(manifest) : null;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Fichiers servis
// ---------------------------------------------------------------------------------------------------------------------------

export async function readMedia(kind: MediaKind): Promise<{ bytes: Buffer; contentType: string; version: string } | null> {
  const manifest = await readManifest();
  if (!manifest) return null;
  const entry = kind === "video" ? manifest.video : kind === "captions" ? manifest.captions : manifest.poster;
  if (!entry) return null;
  const contentType = kind === "video" ? "video/mp4" : kind === "captions" ? "text/vtt; charset=utf-8" : (manifest.poster as NonNullable<Manifest["poster"]>).type;
  try {
    return { bytes: await presentationStore().get(entry.key), contentType, version: manifest.version };
  } catch (error) {
    console.error(`[presentation] fichier illisible (${kind}) : ${describeError(error)}`);
    return null;
  }
}

/** Plage demandée par le lecteur de la vidéo (« bytes=0-1023 »), nécessaire sur iPhone ; null si absente ou illisible, « invalid » si hors du fichier. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | "invalid" | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start: number;
  let end: number;
  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start >= size || start > end ? "invalid" : { start, end };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Dépôt par l'administrateur (RF9)
// ---------------------------------------------------------------------------------------------------------------------------

/** MP4 : le mot « ftyp » aux octets 4 à 7. */
export const isMp4 = (bytes: Buffer) => bytes.length > 12 && bytes.subarray(4, 8).toString("latin1") === "ftyp";

/** WebVTT : commence par « WEBVTT » (une marque d'ordre des octets est admise). */
export const isVtt = (bytes: Buffer) => /^﻿?WEBVTT(?:[ \t\r\n]|$)/.test(bytes.subarray(0, 32).toString("utf8"));

export function imageType(bytes: Buffer): "image/jpeg" | "image/png" | "image/webp" | null {
  if (bytes.length > 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length > 12 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length > 12 && bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  return null;
}

export interface Deposit {
  video?: Buffer;
  captions?: Buffer;
  poster?: Buffer;
  /** Absent : inchangée ; chaîne vide : effacée. */
  durationLabel?: string;
  transcript?: string;
}

const refuse = (message: string) => new Rejection("invalid_file", message, 422);

/**
 * Dépose ou remplace les éléments de la présentation. Un premier dépôt demande la vidéo ET ses sous-titres (RF3) ; ensuite chaque élément se remplace seul. Les fichiers sont
 * contrôlés (type réel, taille), écrits dans un nouveau dossier de version, puis la description bascule : un lecteur n'a jamais une vidéo à moitié remplacée.
 */
export async function savePresentation(adminId: string, deposit: Deposit): Promise<PresentationView> {
  const current = await readManifest();
  if (deposit.video) {
    if (deposit.video.length > MAX_VIDEO_BYTES) throw refuse("La vidéo dépasse 15 Mo.");
    if (!isMp4(deposit.video)) throw refuse("La vidéo doit être un fichier MP4.");
  }
  if (deposit.captions) {
    if (deposit.captions.length > MAX_CAPTIONS_BYTES) throw refuse("Les sous-titres dépassent 200 Ko.");
    if (!isVtt(deposit.captions)) throw refuse("Les sous-titres doivent être un fichier WebVTT (.vtt) qui commence par WEBVTT.");
  }
  const posterType = deposit.poster ? imageType(deposit.poster) : null;
  if (deposit.poster) {
    if (deposit.poster.length > MAX_POSTER_BYTES) throw refuse("L'image d'aperçu dépasse 1 Mo.");
    if (!posterType) throw refuse("L'image d'aperçu doit être au format JPEG, PNG ou WebP.");
  }
  if (!current && !(deposit.video && deposit.captions)) throw refuse("Une première vidéo demande aussi ses sous-titres français (WebVTT).");
  const durationLabel = deposit.durationLabel === undefined ? (current?.durationLabel ?? null) : deposit.durationLabel.trim() || null;
  if (durationLabel && durationLabel.length > MAX_DURATION_LABEL) throw refuse(`La durée affichée est limitée à ${MAX_DURATION_LABEL} caractères.`);
  const transcript = deposit.transcript === undefined ? (current?.transcript ?? null) : deposit.transcript.trim() || null;
  if (transcript && transcript.length > MAX_TRANSCRIPT_CHARS) throw refuse(`La transcription est limitée à ${MAX_TRANSCRIPT_CHARS} caractères.`);

  const store = presentationStore();
  const version = `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`;
  const written: string[] = [];
  const put = async (name: string, bytes: Buffer) => {
    const key = `presentation/${version}/${name}`;
    await store.put(key, bytes);
    written.push(key);
    return key;
  };
  try {
    // Un élément non redéposé garde son fichier d'avant (même clé) ; la vidéo est toujours relue pour sa taille.
    const video = deposit.video ? { key: await put("video.mp4", deposit.video), size: deposit.video.length } : current!.video;
    const captions = deposit.captions ? { key: await put("captions.vtt", deposit.captions) } : current!.captions;
    const poster = deposit.poster ? { key: await put(`poster.${posterType === "image/jpeg" ? "jpg" : posterType === "image/png" ? "png" : "webp"}`, deposit.poster), type: posterType! } : (current?.poster ?? null);
    const manifest: Manifest = { version, video, captions, poster, durationLabel, transcript, updatedAt: new Date().toISOString(), updatedBy: adminId };
    await store.put(MANIFEST_KEY, Buffer.from(JSON.stringify(manifest), "utf8"));
    forgetManifest();
    // Les fichiers remplacés ne servent plus : effacés après la bascule, sans bloquer si l'effacement échoue.
    if (current) {
      const kept = new Set([video.key, captions.key, poster?.key]);
      for (const old of [current.video.key, current.captions.key, current.poster?.key]) if (old && !kept.has(old)) await store.remove(old).catch(() => undefined);
    }
    return viewOf(manifest);
  } catch (error) {
    for (const key of written) await store.remove(key).catch(() => undefined);
    throw error;
  }
}

/** Retire la présentation : l'écran n'est plus proposé et « Revoir la présentation » disparaît. */
export async function removePresentation(): Promise<void> {
  const current = await readManifest();
  const store = presentationStore();
  await store.remove(MANIFEST_KEY).catch(() => undefined);
  forgetManifest();
  if (current) for (const key of [current.video.key, current.captions.key, current.poster?.key]) if (key) await store.remove(key).catch(() => undefined);
}

/** Pour l'administrateur : ce qui est configuré, avec ce qui manque encore (RF3 : sous-titres ; aperçu et transcription recommandés). */
export async function adminView(): Promise<{ view: PresentationView | null; updatedBy: string | null; missing: string[] }> {
  const manifest = await readManifest();
  if (!manifest) return { view: null, updatedBy: null, missing: [] };
  const missing: string[] = [];
  if (!manifest.poster) missing.push("l'image d'aperçu");
  if (!manifest.transcript) missing.push("la transcription du texte de la vidéo");
  if (!manifest.durationLabel) missing.push("la durée affichée");
  return { view: viewOf(manifest), updatedBy: manifest.updatedBy, missing };
}
