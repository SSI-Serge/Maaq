import type { DirectoryQuery, ExternalPlace, PlacesDirectory } from "./types";

/**
 * Sirene, via l'API Recherche d'entreprises (recherche-entreprises.api.gouv.fr, gratuite, sans clé) : les
 * établissements inscrits au registre, par code d'activité (NAF) et code postal. Pas d'avis, pas de téléphone,
 * des entrées parfois dormantes : un repli qui dit « quelqu'un est inscrit près de chez vous », rien de plus.
 */

export const SIRENE_ENDPOINT = "https://recherche-entreprises.api.gouv.fr/search";

/** Codes NAF par catégorie de service ; une catégorie absente n'interroge pas Sirene. */
export const NAF_BY_CATEGORY: Record<string, string[]> = {
  coiffure: ["96.02A"],
  beaute: ["96.02B", "96.04Z"],
  traiteur: ["56.21Z", "56.10C"],
  menage: ["97.00Z", "81.21Z"],
  garde_enfants: ["88.91A"],
  cours: ["85.59B", "85.52Z"],
  bricolage: ["43.32A", "43.39Z", "43.22A", "43.21A"],
  jardinage: ["81.30Z"],
  informatique: ["95.11Z", "62.02A"],
  couture: ["95.29Z", "14.13Z"],
  photo: ["74.20Z"],
  evenementiel: ["90.02Z", "93.29Z"],
  transport: ["49.42Z", "49.41B"],
  animaux: ["96.09Z", "75.00Z"],
};

interface SireneRow {
  siren?: string;
  nom_complet?: string;
  nom_raison_sociale?: string;
  siege?: { libelle_commune?: string; code_postal?: string };
  etat_administratif?: string;
}

export function sireneUrl(naf: string, postcode: string, limit: number, endpoint = SIRENE_ENDPOINT): string {
  const params = new URLSearchParams({ activite_principale: naf, code_postal: postcode, etat_administratif: "A", per_page: String(Math.min(Math.max(limit, 1), 25)), page: "1" });
  return `${endpoint}?${params.toString()}`;
}

export function toPlace(row: SireneRow): ExternalPlace | null {
  const name = row.nom_complet ?? row.nom_raison_sociale;
  if (!row.siren || !name) return null;
  if (row.etat_administratif && row.etat_administratif !== "A") return null;
  return { id: `sirene:${row.siren}`, name, rating: null, reviewCount: null, locality: row.siege?.libelle_commune ?? null, url: `https://annuaire-entreprises.data.gouv.fr/entreprise/${row.siren}`, source: "sirene" };
}

export class SireneDirectory implements PlacesDirectory {
  readonly source = "sirene" as const;
  constructor(private readonly options: { fetch?: typeof fetch; endpoint?: string } = {}) {}

  async search(query: DirectoryQuery): Promise<ExternalPlace[]> {
    const codes = NAF_BY_CATEGORY[query.categoryCode] ?? [];
    const out: ExternalPlace[] = [];
    const seen = new Set<string>();
    for (const naf of codes) {
      if (out.length >= query.limit) break;
      const response = await (this.options.fetch ?? fetch)(sireneUrl(naf, query.postcode, query.limit, this.options.endpoint));
      if (!response.ok) throw new Error(`Sirene : ${response.status}`);
      const data = (await response.json()) as { results?: SireneRow[] };
      for (const row of data.results ?? []) {
        const place = toPlace(row);
        if (!place || seen.has(place.id)) continue;
        seen.add(place.id);
        out.push(place);
        if (out.length >= query.limit) break;
      }
    }
    return out;
  }
}
