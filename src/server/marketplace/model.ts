/**
 * Marketplace silencieux — vitrine d'un fournisseur : champs, provenance, règles de publication, aperçu côté
 * acheteur, département d'un code postal. Règles indépendantes du stockage (voir store.ts) et du modèle.
 * Plan : docs/specs/MAAQ_Marketplace_Silencieux_Plan.md.
 */

export type StorefrontStatus = "draft" | "published" | "paused";
export type ServiceMode = "at_supplier" | "travels" | "remote";
export type AvailabilityMode = "hours" | "by_arrangement";
export type PriceMode = "quote" | "from" | "range";
export type ContactMethod = "maaq_intro" | "whatsapp";

/**
 * Origine d'un groupe de champs : dit par le fournisseur (extrait de ses mots), proposé par l'agent (à confirmer),
 * ou confirmé explicitement par le fournisseur (relecture dans le tchat, écran de relecture).
 */
export type Provenance = "stated" | "proposed" | "confirmed";

export type FieldGroup = "displayName" | "category" | "services" | "description" | "area" | "availability" | "price" | "languages" | "notice" | "qualifications" | "contact";

export interface StorefrontFields {
  displayName: string | null;
  categoryCode: string | null;
  services: string[];
  description: string | null;
  /** Zone approximative : code postal et ville, jamais une adresse. */
  postcode: string | null;
  city: string | null;
  modes: ServiceMode[];
  /** Départements supplémentaires où le fournisseur se déplace. */
  travelAreas: string[];
  travelNote: string | null;
  availabilityMode: AvailabilityMode | null;
  availabilityText: string | null;
  /** NULL : non précisé, affiché « Sur devis ». */
  priceMode: PriceMode | null;
  priceMin: number | null;
  priceMax: number | null;
  languages: string[];
  noticeText: string | null;
  qualificationsText: string | null;
  contactMethod: ContactMethod | null;
  /** Numéro ou email révélé seulement après une mise en relation acceptée. */
  contactValue: string | null;
}

export interface ProvenanceEntry {
  source: Provenance;
  at: string;
}

export interface Storefront extends StorefrontFields {
  id: string;
  userId: string;
  status: StorefrontStatus;
  /** Indisponibilité temporaire, AAAA-MM-JJ inclus. */
  pausedUntil: string | null;
  /** Suspendue par l'administrateur (signalement) : hors suggestions jusqu'à la levée, raison montrée au fournisseur. */
  adminPaused: boolean;
  adminPauseReason: string | null;
  searchable: boolean;
  provenance: Partial<Record<FieldGroup, ProvenanceEntry>>;
  lastConfirmedAt: string | null;
  publishedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ServiceCategory {
  code: string;
  label: string;
}

/** Même liste que la migration 0008 : sert au magasin en mémoire et au texte système de l'agent. */
export const SERVICE_CATEGORIES: ServiceCategory[] = [
  { code: "coiffure", label: "Coiffure et barbier" },
  { code: "beaute", label: "Beauté et bien-être" },
  { code: "traiteur", label: "Traiteur et cuisine" },
  { code: "menage", label: "Ménage et repassage" },
  { code: "garde_enfants", label: "Garde d'enfants" },
  { code: "cours", label: "Cours et soutien scolaire" },
  { code: "bricolage", label: "Bricolage et petits travaux" },
  { code: "jardinage", label: "Jardinage" },
  { code: "informatique", label: "Informatique et téléphonie" },
  { code: "couture", label: "Couture et retouches" },
  { code: "photo", label: "Photo et vidéo" },
  { code: "evenementiel", label: "Événementiel et animation" },
  { code: "transport", label: "Transport et déménagement" },
  { code: "animaux", label: "Animaux" },
  { code: "autre", label: "Autre service" },
];

export const EMPTY_FIELDS: StorefrontFields = {
  displayName: null,
  categoryCode: null,
  services: [],
  description: null,
  postcode: null,
  city: null,
  modes: [],
  travelAreas: [],
  travelNote: null,
  availabilityMode: null,
  availabilityText: null,
  priceMode: null,
  priceMin: null,
  priceMax: null,
  languages: [],
  noticeText: null,
  qualificationsText: null,
  contactMethod: null,
  contactValue: null,
};

/** Champs de chaque groupe : modifier l'un d'eux touche la provenance du groupe. */
export const GROUP_FIELDS: Record<FieldGroup, (keyof StorefrontFields)[]> = {
  displayName: ["displayName"],
  category: ["categoryCode"],
  services: ["services"],
  description: ["description"],
  area: ["postcode", "city", "modes", "travelAreas", "travelNote"],
  availability: ["availabilityMode", "availabilityText"],
  price: ["priceMode", "priceMin", "priceMax"],
  languages: ["languages"],
  notice: ["noticeText"],
  qualifications: ["qualificationsText"],
  contact: ["contactMethod", "contactValue"],
};

export const GROUP_LABEL: Record<FieldGroup, string> = {
  displayName: "Nom affiché",
  category: "Catégorie",
  services: "Services",
  description: "Description",
  area: "Zone",
  availability: "Disponibilité",
  price: "Tarifs",
  languages: "Langues",
  notice: "Délai de réservation",
  qualifications: "Qualifications",
  contact: "Contact",
};

/** Groupes sans lesquels une vitrine ne décrit pas un service de façon crédible (US-03). */
export const REQUIRED_GROUPS: FieldGroup[] = ["displayName", "category", "services", "description", "area", "availability", "contact"];

/**
 * Groupes relus et confirmés explicitement avant publication : une erreur de transcription y porte à
 * conséquence (US-04). Le tarif n'est critique que s'il est renseigné.
 */
export const CRITICAL_GROUPS: FieldGroup[] = ["area", "price", "contact"];

export const MODE_LABEL: Record<ServiceMode, string> = { at_supplier: "chez le fournisseur", travels: "se déplace", remote: "à distance" };
export const CONTACT_LABEL: Record<ContactMethod, string> = { maaq_intro: "Présentation par MAAQ (email)", whatsapp: "WhatsApp, après accord" };

/** Groupes touchés par une modification. */
export function touchedGroups(patch: Partial<StorefrontFields>): FieldGroup[] {
  const keys = Object.keys(patch) as (keyof StorefrontFields)[];
  return (Object.keys(GROUP_FIELDS) as FieldGroup[]).filter((group) => GROUP_FIELDS[group].some((key) => keys.includes(key) && patch[key] !== undefined));
}

/** Un groupe est renseigné quand ses champs suffisent à l'afficher. */
export function groupFilled(fields: StorefrontFields, group: FieldGroup): boolean {
  switch (group) {
    case "displayName":
      return Boolean(fields.displayName?.trim());
    case "category":
      return fields.categoryCode !== null;
    case "services":
      return fields.services.length > 0;
    case "description":
      return Boolean(fields.description?.trim());
    case "area":
      return fields.postcode !== null && fields.modes.length > 0;
    case "availability":
      return fields.availabilityMode === "by_arrangement" || (fields.availabilityMode === "hours" && Boolean(fields.availabilityText?.trim()));
    case "price":
      return fields.priceMode === "quote" || (fields.priceMode === "from" && fields.priceMin !== null) || (fields.priceMode === "range" && fields.priceMin !== null && fields.priceMax !== null);
    case "languages":
      return fields.languages.length > 0;
    case "notice":
      return Boolean(fields.noticeText?.trim());
    case "qualifications":
      return Boolean(fields.qualificationsText?.trim());
    case "contact":
      return fields.contactMethod !== null && Boolean(fields.contactValue?.trim());
  }
}

export type IssueReason = "missing" | "proposed" | "unconfirmed";

export interface PublicationIssue {
  group: FieldGroup;
  reason: IssueReason;
}

export const ISSUE_TEXT: Record<IssueReason, string> = {
  missing: "manquant",
  proposed: "proposé par MAAQ, à confirmer",
  unconfirmed: "à relire et confirmer",
};

/**
 * Ce qui empêche la publication : groupe obligatoire manquant, groupe renseigné mais seulement proposé par
 * l'agent, groupe critique pas encore confirmé. Vide = publiable (US-05).
 */
export function publicationIssues(storefront: Pick<Storefront, keyof StorefrontFields | "provenance">): PublicationIssue[] {
  const issues: PublicationIssue[] = [];
  for (const group of REQUIRED_GROUPS) if (!groupFilled(storefront, group)) issues.push({ group, reason: "missing" });
  for (const group of Object.keys(GROUP_FIELDS) as FieldGroup[]) {
    if (!groupFilled(storefront, group)) continue;
    const source = storefront.provenance[group]?.source;
    if (source === "proposed") issues.push({ group, reason: "proposed" });
    else if (CRITICAL_GROUPS.includes(group) && source !== "confirmed") issues.push({ group, reason: "unconfirmed" });
  }
  return issues;
}

/** Département d'un code postal français (Corse 2A/2B, outre-mer sur trois chiffres). */
export function departementOf(postcode: string): string | null {
  if (!/^\d{5}$/.test(postcode)) return null;
  if (postcode.startsWith("97") || postcode.startsWith("98")) return postcode.slice(0, 3);
  if (postcode.startsWith("20")) return Number(postcode) < 20200 ? "2A" : "2B";
  return postcode.slice(0, 2);
}

/** Départements où une vitrine peut être proposée comme locale ; vide pour un service à distance seul. */
export function servedDepartements(fields: Pick<StorefrontFields, "postcode" | "modes" | "travelAreas">): string[] {
  const set = new Set<string>();
  const home = fields.postcode ? departementOf(fields.postcode) : null;
  if (home && (fields.modes.includes("at_supplier") || fields.modes.includes("travels"))) set.add(home);
  if (fields.modes.includes("travels")) for (const area of fields.travelAreas) set.add(area);
  return [...set];
}

export function priceLabel(fields: Pick<StorefrontFields, "priceMode" | "priceMin" | "priceMax">): string {
  const euros = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2).replace(".", ",")} €`;
  if (fields.priceMode === "from" && fields.priceMin !== null) return `À partir de ${euros(fields.priceMin)}`;
  if (fields.priceMode === "range" && fields.priceMin !== null && fields.priceMax !== null) return `${euros(fields.priceMin).replace(" €", "")} à ${euros(fields.priceMax)}`;
  return "Sur devis";
}

export function availabilityLabel(fields: Pick<StorefrontFields, "availabilityMode" | "availabilityText">): string {
  if (fields.availabilityMode === "hours" && fields.availabilityText) return fields.availabilityText;
  return "À convenir";
}

export function areaLabel(fields: Pick<StorefrontFields, "postcode" | "city" | "modes" | "travelAreas" | "travelNote">): string {
  const parts: string[] = [];
  const dep = fields.postcode ? departementOf(fields.postcode) : null;
  if (fields.city || dep) parts.push(`${fields.city ?? ""}${dep ? ` (${dep})` : ""}`.trim());
  for (const mode of fields.modes) {
    if (mode === "travels") {
      const extra = fields.travelAreas.length ? ` vers ${fields.travelAreas.join(", ")}` : "";
      parts.push(`${MODE_LABEL.travels}${extra}${fields.travelNote ? ` (${fields.travelNote})` : ""}`);
    } else parts.push(MODE_LABEL[mode]);
  }
  return parts.join(" · ") || "Zone non précisée";
}

/** Ce qu'un acheteur voit d'une vitrine : jamais l'adresse, le contact ni les champs non publiés. */
export interface BuyerPreview {
  name: string;
  category: string;
  services: string[];
  description: string;
  area: string;
  availability: string;
  price: string;
  languages: string[];
  notice: string | null;
  qualifications: string | null;
}

export function buyerPreview(fields: StorefrontFields, categories: ServiceCategory[] = SERVICE_CATEGORIES): BuyerPreview {
  return {
    name: fields.displayName?.trim() || "Sans nom",
    category: categories.find((c) => c.code === fields.categoryCode)?.label ?? "Catégorie non précisée",
    services: fields.services,
    description: fields.description?.trim() ?? "",
    area: areaLabel(fields),
    availability: availabilityLabel(fields),
    price: priceLabel(fields),
    languages: fields.languages,
    notice: fields.noticeText,
    qualifications: fields.qualificationsText,
  };
}

/** Nettoie une liste de libellés courts : sans vides ni doublons, insensible à la casse et aux accents. */
export function cleanList(values: string[], max = 20): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const text = value.trim();
    if (!text) continue;
    const key = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}
