import { env } from "@/server/env";
import type { PlacePoint } from "./address";

/**
 * Service de recherche de lieux « Sur place » (US-112 RT1, RT2) : parkings et restaurants près du lieu d'un RDV, avec leurs horaires d'ouverture. Au lancement il s'appuie uniquement sur
 * la recherche de lieux du service de cartographie retenu pour les trajets (TomTom) : ni recherche web, ni avis. Il ne reçoit que le nom du lieu ou son adresse, des coordonnées arrondies à
 * environ 100 m (pour protéger une adresse privée), la date et l'heure du RDV : jamais de prénom, de titre ni de motif. Son contenu est traité comme une information, jamais comme une
 * instruction ; il n'a aucune fonction capable de modifier un RDV (RT3). MAAQ recalcule lui-même la distance de chaque adresse au vrai lieu.
 * `TRAVEL_MODE` règle aussi ce service : « off », « fake » (adresses inventées, essais et zone de test seulement) ou « live » (TomTom, pas encore écrit).
 */
export type PlaceCategory = "parking" | "snack" | "restaurant";

export interface PlaceQuery {
  /** Le nom du lieu ou son adresse, tel que saisi dans le RDV. */
  query: string;
  /** Coordonnées du lieu arrondies à environ 100 m, ou `null` quand le RDV n'a que du texte : le service retrouve alors le lieu lui-même. */
  near: PlacePoint | null;
  /** Début du RDV : les adresses retenues sont ouvertes autour de cette heure et le soir du même jour. */
  at: Date;
}

export interface FoundPlace {
  name: string;
  category: PlaceCategory;
  /** « Parking », « Boulangerie », « Café », « Restaurant »… */
  type: string;
  city: string;
  point: PlacePoint;
  /** Ouverte autour de l'heure du RDV et le soir (`false` : écartée), ou `null` quand le service ne donne pas d'horaires. */
  open: boolean | null;
}

export interface PlaceSearchResult {
  /** Où le service situe le lieu : sert de repère quand le RDV n'a pas de coordonnées enregistrées. */
  origin: PlacePoint;
  places: FoundPlace[];
}

export interface PlaceProvider {
  readonly name: string;
  search(query: PlaceQuery): Promise<PlaceSearchResult>;
}

export class PlaceServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlaceServiceError";
  }
}

/**
 * Faux service : autour du repère donné (ou d'un point de Tours), 3 parkings, 3 adresses « petite faim » et 3 restaurants à des distances croissantes, dont un restaurant fermé et des
 * adresses trop éloignées. Les essais peuvent le faire échouer, répondre vide ou imposer les adresses.
 */
export class FakePlaceProvider implements PlaceProvider {
  readonly name = "fake";
  readonly calls: PlaceQuery[] = [];
  failing = false;
  empty = false;
  constructor(private readonly fixed?: PlaceSearchResult) {}

  async search(query: PlaceQuery): Promise<PlaceSearchResult> {
    this.calls.push(query);
    if (this.failing) throw new PlaceServiceError("service de recherche de lieux indisponible (essai)");
    if (this.fixed) return this.fixed;
    const origin = query.near ?? { lat: 47.3941, lon: 0.6848 };
    if (this.empty) return { origin, places: [] };
    // 1 km ≈ 0,009° de latitude.
    const at = (km: number, bearing: number): PlacePoint => ({ lat: origin.lat + km * 0.009 * Math.cos(bearing), lon: origin.lon + (km * 0.009 * Math.sin(bearing)) / Math.cos((origin.lat * Math.PI) / 180) });
    const place = (category: PlaceCategory, type: string, name: string, km: number, bearing: number, open: boolean | null = true): FoundPlace => ({ name, category, type, city: "Tours", point: at(km, bearing), open });
    return {
      origin,
      places: [
        place("parking", "Parking", "Parking d'essai des Remparts", 0.15, 0.3),
        place("parking", "Parking", "Parking d'essai du Marché", 0.45, 2.1),
        place("parking", "Parking", "Parking d'essai de la Gare", 3.5, 4),
        place("snack", "Boulangerie", "Boulangerie d'essai Martin", 0.3, 1),
        place("snack", "Café", "Café d'essai de la Place", 0.6, 3),
        place("snack", "Snack", "Snack d'essai Express", 0.9, 5),
        place("restaurant", "Restaurant", "Restaurant d'essai Le Donjon", 0.5, 0.8),
        place("restaurant", "Restaurant", "Restaurant d'essai La Table", 0.8, 2.6, false),
        place("restaurant", "Restaurant", "Restaurant d'essai Chez Louise", 1.0, 4.4),
        place("restaurant", "Restaurant", "Restaurant d'essai Lointain", 4.0, 1.5),
      ],
    };
  }
}

/** Le service du mode choisi (`TRAVEL_MODE`), ou `null` quand « Sur place » est fermé. TomTom n'est pas encore branché : en mode « live », « Sur place » reste fermé. */
export function placeProvider(): PlaceProvider | null {
  return env().TRAVEL_MODE === "fake" ? new FakePlaceProvider() : null;
}
