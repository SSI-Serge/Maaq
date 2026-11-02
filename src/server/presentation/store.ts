import { env } from "@/server/env";
import { GcsStore, LocalStore, type ObjectStore } from "@/server/contracts/storage";

/**
 * Stockage de la vidéo de présentation (US-140 RT1) : un bucket Cloud Storage en Union européenne distinct de celui des contrats (celui-ci supprime tout à 45 jours), ou le dossier
 * de données local en développement. Contenu public pour les profils connectés, sans donnée personnelle : il n'est pas chiffré. Seul le serveur de MAAQ le lit et le sert.
 */
export const PRESENTATION_PREFIX = "presentation/";
export const MANIFEST_KEY = "presentation/manifest.json";
const SAFE = /^presentation\/(?:manifest\.json|[0-9a-z]{6,24}\/(?:video\.mp4|captions\.vtt|poster\.(?:jpg|png|webp)))$/;

declare global {
  var __maaqPresentationStore: ObjectStore | undefined;
}

export function presentationStore(): ObjectStore {
  const bucket = env().PRESENTATION_BUCKET;
  globalThis.__maaqPresentationStore ??= bucket ? new GcsStore(bucket, SAFE) : new LocalStore(SAFE, "presentation-media", PRESENTATION_PREFIX);
  return globalThis.__maaqPresentationStore;
}

/** Pour les tests : remplace le stockage ; sans argument, revient à la configuration. */
export function setPresentationStore(store: ObjectStore | undefined): void {
  globalThis.__maaqPresentationStore = store;
}
