import { env } from "@/server/env";
import type { PlacePoint } from "./address";

/**
 * Service de calcul de trajet (US-107 RT1). Le service ne reçoit que deux couples de coordonnées et l'heure de départ : jamais de prénom, de titre ni de motif.
 * Trois modes (`TRAVEL_MODE`) : « off » (aucun calcul : le suivi du trajet est fermé), « fake » (durées inventées d'après la distance, pour essayer les écrans et les notifications
 * sans compte : essais et zone de test seulement) et « live » (TomTom, société néerlandaise retenue par le DPO le 26/10/2026 ; clé dans Secret Manager).
 */
export interface RouteQuery {
  from: PlacePoint;
  to: PlacePoint;
  /** Heure de départ prévue : TomTom en tient compte pour le trafic prévu. */
  departAt: Date;
  /** Avec le trafic à cette heure, ou sans trafic (estimation faite à l'activation du suivi, RF5). */
  traffic: boolean;
}

export interface TravelProvider {
  readonly name: string;
  /** Durée du trajet en voiture, en minutes entières (au moins 1). Lève `TravelServiceError` quand le service ne répond pas. */
  route(query: RouteQuery): Promise<number>;
}

export class TravelServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TravelServiceError";
  }
}

export function distanceKm(a: PlacePoint, b: PlacePoint): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

/**
 * Faux service : 40 km/h en ligne droite (trajet de 3 minutes au moins), plus 25 % avec le trafic aux heures de pointe (7 h à 9 h et 17 h à 19 h, heure de Paris), 10 % sinon.
 * Les essais peuvent imposer une durée, la faire varier par appel ou simuler une panne.
 */
export class FakeTravelProvider implements TravelProvider {
  readonly name = "fake";
  readonly calls: RouteQuery[] = [];
  failing = false;
  constructor(private readonly fixed?: number | ((query: RouteQuery) => number)) {}

  async route(query: RouteQuery): Promise<number> {
    this.calls.push(query);
    if (this.failing) throw new TravelServiceError("service de trajet indisponible (essai)");
    if (typeof this.fixed === "number") return this.fixed;
    if (typeof this.fixed === "function") return Math.max(1, Math.round(this.fixed(query)));
    const base = Math.max(3, (distanceKm(query.from, query.to) / 40) * 60);
    const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hour12: false, timeZone: "Europe/Paris" }).format(query.departAt)) % 24;
    const rush = (hour >= 7 && hour < 9) || (hour >= 17 && hour < 19);
    return Math.max(1, Math.round(query.traffic ? base * (rush ? 1.25 : 1.1) : base));
  }
}

/**
 * TomTom Routing API (calculateRoute, en voiture). **Pas encore essayé contre le vrai service** : à vérifier avec la clé (réponse attendue : routes[0].summary.travelTimeInSeconds).
 * La clé fait partie de l'adresse demandée : cette adresse n'est jamais journalisée.
 */
export class TomTomTravelProvider implements TravelProvider {
  readonly name = "tomtom";
  constructor(private readonly apiKey: string, private readonly options: { fetch?: typeof fetch; baseUrl?: string; timeoutMs?: number } = {}) {}

  async route(query: RouteQuery): Promise<number> {
    const { from, to } = query;
    const params = new URLSearchParams({
      key: this.apiKey, travelMode: "car", routeType: "fastest", traffic: String(query.traffic), computeTravelTimeFor: "all",
      departAt: query.departAt.toISOString().replace(/\.\d{3}Z$/, "Z"),
    });
    const url = `${this.options.baseUrl ?? "https://api.tomtom.com"}/routing/1/calculateRoute/${from.lat},${from.lon}:${to.lat},${to.lon}/json?${params}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 8_000);
    try {
      const res = await (this.options.fetch ?? fetch)(url, { signal: controller.signal, headers: { accept: "application/json" } });
      if (!res.ok) throw new TravelServiceError(`le service de trajet a répondu ${res.status}`);
      const json = (await res.json()) as { routes?: { summary?: { travelTimeInSeconds?: unknown; noTrafficTravelTimeInSeconds?: unknown } }[] };
      const summary = json.routes?.[0]?.summary;
      const seconds = query.traffic ? summary?.travelTimeInSeconds : (summary?.noTrafficTravelTimeInSeconds ?? summary?.travelTimeInSeconds);
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) throw new TravelServiceError("réponse inattendue du service de trajet");
      return Math.max(1, Math.ceil(seconds / 60));
    } catch (error) {
      if (error instanceof TravelServiceError) throw error;
      throw new TravelServiceError("le service de trajet est injoignable");
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Le service du mode choisi, ou `null` quand le suivi du trajet est fermé (`TRAVEL_MODE=off`). */
export function travelProvider(): TravelProvider | null {
  const settings = env();
  if (settings.TRAVEL_MODE === "fake") return new FakeTravelProvider();
  if (settings.TRAVEL_MODE === "live") return new TomTomTravelProvider(settings.TOMTOM_API_KEY!);
  return null;
}
