import { env } from "@/server/env";
import { DevPlaces } from "./dev";
import { GooglePlaces } from "./google";
import { SireneDirectory } from "./sirene";
import { NoDirectory, type DirectoryQuery, type ExternalPlace, type PlacesDirectory } from "./types";

declare global {
  // Une seule instance malgré le rechargement à chaud du serveur de développement.
  var __maaqPlaces: PlacesDirectory | undefined;
}

/** Google d'abord ; sans résultat (ou en panne), le registre Sirene. */
export class GoogleThenSirene implements PlacesDirectory {
  readonly source = "google" as const;
  constructor(
    private readonly google: PlacesDirectory,
    private readonly sirene: PlacesDirectory,
  ) {}

  async search(query: DirectoryQuery): Promise<ExternalPlace[]> {
    try {
      const found = await this.google.search(query);
      if (found.length) return found;
    } catch (error) {
      console.error("[places] Google Places indisponible, repli Sirene :", error);
    }
    return this.sirene.search(query);
  }
}

/** Annuaire externe selon PLACES_MODE. */
export function placesDirectory(): PlacesDirectory {
  if (globalThis.__maaqPlaces) return globalThis.__maaqPlaces;
  const settings = env();
  globalThis.__maaqPlaces =
    settings.PLACES_MODE === "google"
      ? new GoogleThenSirene(new GooglePlaces({ apiKey: settings.GOOGLE_PLACES_API_KEY! }), new SireneDirectory())
      : settings.PLACES_MODE === "sirene"
        ? new SireneDirectory()
        : settings.PLACES_MODE === "dev"
          ? new DevPlaces()
          : new NoDirectory();
  return globalThis.__maaqPlaces;
}

/** Remplace l'annuaire (tests). */
export function usePlacesDirectory(directory: PlacesDirectory | undefined): void {
  globalThis.__maaqPlaces = directory;
}

export type * from "./types";
