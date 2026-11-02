/**
 * Masquage des documents de contrat avant l'analyse (US-136, C-12 à C-16). Fonctions pures : le texte vient de l'extraction (PDF) ou de l'OCR, le résultat est le texte
 * masqué que l'agent recevra, jamais l'image. Il s'agit d'une pseudonymisation : le texte masqué reste une donnée personnelle (RT6).
 */

/** Types de jetons : « [PERSONNE_1] », « [ADRESSE_1] », « [CONTRAT_1] »… */
export type TokenType =
  | "PERSONNE"
  | "ADRESSE"
  | "EMAIL"
  | "TELEPHONE"
  | "CONTRAT"
  | "IBAN"
  | "BIC"
  | "RIB"
  | "IMMATRICULATION"
  | "VIN"
  | "SECU"
  | "EMPLOYEUR"
  | "COMPTE"
  | "IDENTIFIANT"
  | "DONNEE";

/** Ce que MAAQ sait déjà du foyer (profils, membres, véhicule, adresse) : couche 2 du masquage (RT2), recherche en liste fermée. */
export interface HouseholdFacts {
  people: { id: string; firstName: string; lastName?: string | null; /** « AAAA-MM-JJ » ou « AAAA-MM » */ birth?: string | null }[];
  emails?: string[];
  phones?: string[];
  addressLines?: string[];
  plates?: string[];
}

/** Jetons d'un contrat : un même nom garde le même jeton dans tous les documents du contrat. Aucune valeur n'est conservée (RT3). */
export interface TokenSpace {
  /** Clé interne (type et valeur normalisée, passés par `hash` s'il existe) → jeton. Jamais exposé. */
  assigned: Map<string, string>;
  counters: Partial<Record<TokenType, number>>;
  /** Empreinte à clé de l'application : permet de garder les jetons déjà attribués dans les documents du contrat sans jamais conserver une valeur (US-136 RT3). */
  hash?: (id: string) => string;
}

export const createTokenSpace = (hash?: (id: string) => string): TokenSpace => ({ assigned: new Map(), counters: {}, hash });

export type PageState = "ok" | "removed" | "doubt";

export interface MaskedPage {
  text: string;
  state: PageState;
}

/** État du document après masquage (US-136 RF7) : « ok » (prêt pour l'aperçu), « to_verify » (« À vérifier »), « blocked » (page santé douteuse). */
export type MaskState = "ok" | "to_verify" | "blocked";

export interface MaskedDocument {
  pages: MaskedPage[];
  /** Texte masqué, pages réunies (les pages retirées y figurent comme une ligne neutre). */
  text: string;
  /** Nombre de masques par type, sans valeur (RT4). */
  counts: Partial<Record<TokenType | "AGE" | "ANCIENNETE" | "DEPARTEMENT", number>>;
  /** Jetons qui correspondent à un membre du foyer : remplacés par la valeur à l'affichage (US-132 RT3). */
  references: Record<string, { kind: "member"; id: string }>;
  /** Motifs personnels restant visibles après masquage (types seulement, jamais de valeur). */
  residual: string[];
  removedHealthPages: number;
  doubtHealthPages: number;
  state: MaskState;
}

export interface MaskOptions {
  household: HouseholdFacts;
  now: Date;
  space?: TokenSpace;
  /** « Masquer aussi ce mot » (US-137 RF3) : toutes les occurrences, dans ce document seulement. */
  extraWords?: string[];
  /** Noms repérés par le modèle de langue (couche 3), page par page. Absents : seules les règles et la liste du foyer travaillent. */
  entities?: { start: number; end: number; label: string }[][];
}
