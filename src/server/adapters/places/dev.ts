import type { DirectoryQuery, ExternalPlace, PlacesDirectory } from "./types";

/** Annuaire de démonstration (PLACES_MODE=dev) : des établissements fictifs, nommés comme tels. */
export class DevPlaces implements PlacesDirectory {
  readonly source = "dev" as const;
  /** Requêtes reçues (tests) : seule une catégorie et un code postal doivent y figurer. */
  readonly queries: DirectoryQuery[] = [];

  async search(query: DirectoryQuery): Promise<ExternalPlace[]> {
    this.queries.push(query);
    const places: ExternalPlace[] = [
      { id: "dev-1", name: `Démo ${query.categoryLabel} du centre`, rating: 4.6, reviewCount: 128, locality: `Commune ${query.postcode}`, url: null, source: "dev" },
      { id: "dev-2", name: `Démo ${query.categoryLabel} de quartier`, rating: 4.1, reviewCount: 37, locality: `Commune ${query.postcode}`, url: null, source: "dev" },
    ];
    return places.slice(0, query.limit);
  }
}

/** Annuaire en mémoire pour les tests : résultats fixés, requêtes enregistrées. */
export class MemoryDirectory implements PlacesDirectory {
  readonly queries: DirectoryQuery[] = [];
  constructor(
    readonly source: "google" | "sirene" | "dev",
    private readonly results: ExternalPlace[],
  ) {}

  async search(query: DirectoryQuery): Promise<ExternalPlace[]> {
    this.queries.push(query);
    return this.results.slice(0, query.limit);
  }
}
