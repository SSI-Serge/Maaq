import type { Platform } from "./auth";

/**
 * « Ouvrir dans Plans/Maps » : l'adresse d'un lieu ou d'un itinéraire pour l'application de cartes du téléphone. iPhone : Plans (Apple) ; Android et ordinateur : Google Maps (sur Android,
 * le lien ouvre l'application quand elle est installée). Le lien n'est suivi que sur un geste de l'utilisateur : MAAQ n'envoie rien à ces services, et ne reçoit rien d'eux. `destination`
 * est un nom de lieu ou une adresse, tel qu'affiché à l'écran (jamais des coordonnées : MAAQ n'en garde pas pour ces résultats).
 */
export function mapsUrl(destination: string, platform: Pick<Platform, "os">): string {
  const q = encodeURIComponent(destination.trim());
  // L'itinéraire part de la position de l'appareil : l'application de cartes la connaît, pas MAAQ.
  return platform.os === "iphone" ? `https://maps.apple.com/?daddr=${q}&dirflg=d` : `https://www.google.com/maps/dir/?api=1&destination=${q}`;
}
