import { seal } from "./fields";

/**
 * Suggestions d'adresses (US-107 RT2) : la recherche d'adresses de l'État (Géoplateforme, ex-API Adresse), hébergée en France, gratuite, sans clé, adresses françaises seulement.
 * Seul le texte tapé dans le champ « Adresse » lui est envoyé, jamais un titre, un prénom ni un identifiant. Le texte n'est pas journalisé.
 * Les coordonnées d'une suggestion choisie sont conservées chiffrées avec le RDV (jamais pour un RDV médical, jamais une adresse de domicile enregistrée par MAAQ).
 */
export interface AddressSuggestion {
  label: string;
  lat: number;
  lon: number;
}

export interface PlacePoint {
  lat: number;
  lon: number;
}

export class AddressServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AddressServiceError";
  }
}

export const ADDRESS_ENDPOINT = "https://data.geopf.fr/geocodage/search";
export const MIN_QUERY = 3;
const MAX_QUERY = 120;
const LIMIT = 5;

interface Feature {
  geometry?: { coordinates?: unknown };
  properties?: { label?: unknown };
}

/** Jusqu'à 5 adresses proposées pour le texte tapé ; une liste vide sous 3 caractères. Lève `AddressServiceError` quand le service ne répond pas. */
export async function suggestAddresses(query: string, options: { fetch?: typeof fetch; timeoutMs?: number } = {}): Promise<AddressSuggestion[]> {
  const text = query.trim().slice(0, MAX_QUERY);
  if (text.length < MIN_QUERY) return [];
  const url = `${ADDRESS_ENDPOINT}?${new URLSearchParams({ q: text, limit: String(LIMIT), autocomplete: "1" })}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 4_000);
  try {
    const res = await (options.fetch ?? fetch)(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new AddressServiceError(`le service d'adresses a répondu ${res.status}`);
    const json = (await res.json()) as { features?: Feature[] };
    const found: AddressSuggestion[] = [];
    for (const f of json.features ?? []) {
      const [lon, lat] = Array.isArray(f.geometry?.coordinates) ? (f.geometry.coordinates as unknown[]) : [];
      const label = f.properties?.label;
      if (typeof label === "string" && label && typeof lat === "number" && typeof lon === "number" && inRange(lat, lon)) found.push({ label, lat, lon });
    }
    return found.slice(0, LIMIT);
  } catch (error) {
    if (error instanceof AddressServiceError) throw error;
    throw new AddressServiceError("le service d'adresses est injoignable");
  } finally {
    clearTimeout(timer);
  }
}

const inRange = (lat: number, lon: number) => Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;

/** Un point reçu du client : deux nombres plausibles, sinon `null`. */
export function parsePoint(value: unknown): PlacePoint | null {
  if (!value || typeof value !== "object") return null;
  const { lat, lon } = value as Record<string, unknown>;
  return typeof lat === "number" && typeof lon === "number" && inRange(lat, lon) ? { lat, lon } : null;
}

/** Coordonnées chiffrées pour la base (`location_point`), arrondies au dixième de mètre environ. */
export function sealPoint(point: PlacePoint): Buffer {
  const round = (n: number) => Math.round(n * 1e6) / 1e6;
  return seal(JSON.stringify({ lat: round(point.lat), lon: round(point.lon) }));
}
