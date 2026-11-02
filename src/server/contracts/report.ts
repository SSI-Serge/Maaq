import { residualIssues, type HouseholdFacts } from "./masking/engine";
import type { TokenType } from "./masking/types";

/**
 * Rapport d'analyse d'un contrat (US-132). L'agent produit du HTML ; ce module le nettoie (RT1), remplace les jetons du texte masqué par des références ou une forme neutre
 * (RT3, comme les références de D39), refuse un rapport qui contient encore un motif personnel, et le remet en forme à l'affichage. Fonctions pures.
 */

// ---------------------------------------------------------------------------------------------------------------------------
// Nettoyage du HTML : liste blanche de balises, aucun attribut, aucun script, aucun lien, aucun formulaire
// ---------------------------------------------------------------------------------------------------------------------------

const ALLOWED = new Set(["h1", "h2", "h3", "h4", "p", "ul", "ol", "li", "strong", "em", "b", "i", "br", "table", "thead", "tbody", "tr", "th", "td", "blockquote", "hr"]);
const VOID = new Set(["br", "hr"]);
// Ces balises sont retirées avec leur contenu.
const DROP_WITH_CONTENT = /<(script|style|iframe|object|embed|form|textarea|select|svg|math|head|title|noscript|template|button|video|audio)\b[\s\S]*?<\/\1\s*>/gi;
const ENTITY = /&(?:amp|lt|gt|quot|apos|nbsp|#\d{1,6}|#x[0-9a-f]{1,6});/gi;

const escapeText = (text: string) =>
  text
    .replace(/&(?!(?:amp|lt|gt|quot|apos|nbsp|#\d{1,6}|#x[0-9a-f]{1,6});)/gi, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/**
 * Ne garde que les balises de texte, sans aucun attribut (donc ni `href`, ni `src`, ni `style`, ni gestionnaire d'événement), ferme les balises restées ouvertes et
 * échappe tout le reste. Un lien devient son texte : rien n'est chargé ni cliquable dans le rapport.
 */
export function sanitizeReportHtml(html: string): string {
  const source = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "").replace(DROP_WITH_CONTENT, "");
  const out: string[] = [];
  const stack: string[] = [];
  // Une balise commence par « < » suivi d'une lettre, de « / » et d'une lettre, ou de « ! » ou « ? » ; un « < » isolé (« 1 < 2 ») est du texte.
  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)(?:\s[^<>]*)?\/?>|<\/?[a-zA-Z][^<>]*>?|<[!?][^<>]*>?/g;
  let cursor = 0;
  for (const match of source.matchAll(re)) {
    out.push(escapeText(source.slice(cursor, match.index)));
    cursor = match.index! + match[0].length;
    const name = match[1]?.toLowerCase();
    if (!name || !ALLOWED.has(name)) continue;
    if (match[0].startsWith("</")) {
      const at = stack.lastIndexOf(name);
      if (at < 0) continue;
      while (stack.length > at) out.push(`</${stack.pop()}>`);
    } else if (VOID.has(name)) out.push(`<${name}>`);
    else {
      stack.push(name);
      out.push(`<${name}>`);
    }
  }
  out.push(escapeText(source.slice(cursor)));
  while (stack.length) out.push(`</${stack.pop()}>`);
  return out.join("");
}

/** Texte brut d'un HTML nettoyé (pour les contrôles). */
export const textOf = (html: string) => html.replace(/<[^>]+>/g, " ").replace(ENTITY, " ").replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------------------------------------------------------------------
// Jetons du texte masqué → références ou forme neutre
// ---------------------------------------------------------------------------------------------------------------------------

const TOKEN = /\[([A-Z]+)_(\d+)\]/g;

/** Forme neutre d'un jeton qui ne correspond à aucune donnée connue de MAAQ (US-132 RT3) : aucune valeur n'est conservée. */
const NEUTRAL: Record<TokenType, string> = {
  PERSONNE: "le souscripteur",
  ADRESSE: "l'adresse du logement",
  EMAIL: "l'adresse email",
  TELEPHONE: "le numéro de téléphone",
  CONTRAT: "le contrat",
  IBAN: "le compte bancaire",
  BIC: "la banque",
  RIB: "le compte bancaire",
  IMMATRICULATION: "le véhicule",
  VIN: "le véhicule",
  SECU: "le numéro de sécurité sociale",
  EMPLOYEUR: "l'employeur",
  COMPTE: "l'identifiant de compte",
  IDENTIFIANT: "un identifiant",
  DONNEE: "une donnée masquée",
};

const MEMBER_REF = /\[\[membre:([A-Za-z0-9_-]{1,64})\]\]/g;

/**
 * Prépare le rapport pour le stockage : nettoyé, les jetons des membres du foyer deviennent « [[membre:id]] » (résolus à l'affichage), les autres une forme neutre.
 * `references` vient du masquage du document (jeton → membre).
 */
export function finalizeReport(html: string, references: Record<string, { kind: "member"; id: string }>): string {
  const clean = sanitizeReportHtml(html);
  return clean.replace(TOKEN, (token, type: string) => {
    const ref = references[token];
    if (ref) return `[[membre:${ref.id}]]`;
    return NEUTRAL[type as TokenType] ?? "une donnée masquée";
  });
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Affichage : « [[membre:id]] » devient le prénom du membre (valeur vivante) ; un membre effacé ou inconnu devient « un membre de la famille ». */
export function displayReport(stored: string, firstNames: ReadonlyMap<string, string>): string {
  return stored.replace(MEMBER_REF, (_, id: string) => escapeHtml(firstNames.get(id) ?? "un membre de la famille"));
}

/** Types de motifs personnels restant dans le rapport, jamais leurs valeurs ; un rapport qui en contient est refusé et l'analyse passe en échec (US-132 RT3). */
export function reportIssues(html: string, household: HouseholdFacts, now: Date): string[] {
  const text = textOf(html).replace(/\[\[membre:[^\]]*\]\]/g, " ");
  return residualIssues(text, { household, now });
}

/** Mention finale obligatoire (US-132 RF2), ajoutée par le code et non par le modèle. */
export const REPORT_DISCLAIMER = "Analyse automatique à partir de vos documents : vérifiez les informations importantes auprès de votre assureur.";

export const withDisclaimer = (html: string) => `${html}<p><em>${REPORT_DISCLAIMER}</em></p>`;
