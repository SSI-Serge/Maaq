import type { DirectoryQuery, ExternalPlace, PlacesDirectory } from "./types";

/**
 * Google Places API (New), Text Search. Depuis mars 2025, chaque SKU a son propre quota gratuit mensuel
 * (Text Search : 5 000 appels) ; les champs demandés déterminent le SKU facturé, d'où un masque minimal :
 * nom, commune, note, nombre d'avis, lien. Aucun texte d'avis. Rien n'est conservé au-delà de la réponse,
 * conformément aux conditions (seul l'identifiant pourrait l'être).
 */

export const PLACES_ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
export const PLACES_FIELD_MASK = "places.id,places.displayName,places.formattedAddress,places.addressComponents,places.rating,places.userRatingCount,places.googleMapsUri,places.businessStatus";

export interface GooglePlacesOptions {
  apiKey: string;
  fetch?: typeof fetch;
  endpoint?: string;
}

interface PlaceRow {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  addressComponents?: { longText?: string; types?: string[] }[];
  rating?: number;
  userRatingCount?: number;
  googleMapsUri?: string;
  businessStatus?: string;
}

/** Corps de la requête : catégorie et code postal seulement. */
export function textSearchBody(query: DirectoryQuery) {
  return { textQuery: `${query.categoryLabel} ${query.postcode}`, languageCode: "fr", regionCode: "FR", pageSize: Math.min(Math.max(query.limit, 1), 10) };
}

export function toPlace(row: PlaceRow): ExternalPlace | null {
  if (!row.id || !row.displayName?.text) return null;
  if (row.businessStatus && row.businessStatus !== "OPERATIONAL") return null;
  const locality = row.addressComponents?.find((c) => c.types?.includes("locality"))?.longText ?? row.formattedAddress?.split(",").at(-2)?.trim() ?? null;
  return {
    id: row.id,
    name: row.displayName.text,
    rating: typeof row.rating === "number" ? row.rating : null,
    reviewCount: typeof row.userRatingCount === "number" ? row.userRatingCount : null,
    locality,
    url: row.googleMapsUri ?? null,
    source: "google",
  };
}

export class GooglePlaces implements PlacesDirectory {
  readonly source = "google" as const;
  private readonly fetchFn: typeof fetch;
  private readonly endpoint: string;

  constructor(private readonly options: GooglePlacesOptions) {
    this.fetchFn = options.fetch ?? fetch;
    this.endpoint = options.endpoint ?? PLACES_ENDPOINT;
  }

  async search(query: DirectoryQuery): Promise<ExternalPlace[]> {
    const response = await this.fetchFn(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": this.options.apiKey, "X-Goog-FieldMask": PLACES_FIELD_MASK },
      body: JSON.stringify(textSearchBody(query)),
    });
    if (!response.ok) throw new Error(`Google Places : ${response.status}`);
    const data = (await response.json()) as { places?: PlaceRow[] };
    return (data.places ?? []).map(toPlace).filter((p): p is ExternalPlace => p !== null).slice(0, query.limit);
  }
}
