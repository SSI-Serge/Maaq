/**
 * Annuaire externe du marketplace silencieux (phase 2c) : quand l'offre des membres est mince, des établissements
 * hors MAAQ, clairement séparés des vitrines. Google Places API (New) est la source avec avis ; Sirene, le registre
 * public, un repli sans avis. Seuls une catégorie et une zone sortent de MAAQ, jamais le texte de la demande.
 */

export type DirectorySource = "google" | "sirene" | "dev";

export interface ExternalPlace {
  id: string;
  name: string;
  /** Note sur 5 et nombre d'avis, tels que la source les donne ; null quand elle n'en a pas (Sirene). */
  rating: number | null;
  reviewCount: number | null;
  /** Commune ou adresse courte, jamais plus précis que ce que la source publie. */
  locality: string | null;
  url: string | null;
  source: DirectorySource;
}

export interface DirectoryQuery {
  categoryCode: string;
  categoryLabel: string;
  postcode: string;
  limit: number;
}

export interface PlacesDirectory {
  readonly source: DirectorySource | "none";
  search(query: DirectoryQuery): Promise<ExternalPlace[]>;
}

export class NoDirectory implements PlacesDirectory {
  readonly source = "none" as const;
  async search(): Promise<ExternalPlace[]> {
    return [];
  }
}

/** Libellé de la source pour l'acheteur. */
export const SOURCE_LABEL: Record<DirectorySource, string> = { google: "trouvés sur Google Maps", sirene: "inscrits au registre des entreprises (Sirene), sans avis", dev: "annuaire de démonstration" };
