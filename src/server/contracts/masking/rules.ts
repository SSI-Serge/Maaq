import type { TokenType } from "./types";

/** Zone du texte à remplacer : par un jeton (`type` de jeton) ou par une valeur neutre (`replacement`, pour les transformations de US-136 RF3). */
export interface Span {
  start: number;
  end: number;
  type: TokenType | "AGE" | "ANCIENNETE" | "DEPARTEMENT";
  /** Valeur normalisée : deux occurrences de la même valeur reçoivent le même jeton. */
  key: string;
  replacement?: string;
  /** Plus petit = prioritaire quand deux zones se chevauchent. */
  priority: number;
  memberId?: string;
}

const LETTER = "A-Za-zÀ-ÖØ-öø-ÿ";
const CAP = "A-ZÀ-ÖØ-Ý";
const WORD = `[${CAP}][${LETTER}'’-]+`;

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
// Numéros français (06 12 34 56 78, +33 6 12 34 56 78) et internationaux ; pas les dates, les montants ni les heures.
const PHONE_FR = /(?<!\d)(?:(?:\+|00)33[\s.-]?\(?0?\)?|0)[1-9](?:[\s.-]?\d{2}){4}(?!\d)/g;
const PHONE_INTL = /(?<![\d+])\+\d{1,3}[\s.-]?\d(?:[\s.-]?\d{2,4}){2,4}(?!\d)/g;
const IBAN = /(?<![A-Za-z0-9])[A-Z]{2}\d{2}(?:[ \u00a0]?[A-Z0-9]{4}){2,7}(?:[ \u00a0]?[A-Z0-9]{1,3})?(?![A-Za-z0-9])/g;
const RIB = /(?<!\d)\d{5}[ \u00a0]?\d{5}[ \u00a0]?[A-Z0-9]{11}[ \u00a0]?\d{2}(?!\d)/g;
const NIR = /(?<!\d)[12][ \u00a0.]?\d{2}[ \u00a0.]?(?:0[1-9]|1[0-2]|[2-9]\d)[ \u00a0.]?(?:\d{2}|2[AB])[ \u00a0.]?\d{3}[ \u00a0.]?\d{3}(?:[ \u00a0.]?\d{2})?(?!\d)/g;
const PLATE_SIV = /(?<![A-Za-z0-9])[A-HJ-NP-TV-Z]{2}[-\s]?\d{3}[-\s]?[A-HJ-NP-TV-Z]{2}(?![A-Za-z0-9])/g;
const PLATE_FNI = /(?<=(?:immatriculation|plaque|immat\.?)\s*(?:n[°ºo]\s*)?:?\s*)\d{1,4}[-\s]?[A-Z]{1,3}[-\s]?\d{2,3}(?![A-Za-z0-9])/giu;
const VIN = /(?<![A-Za-z0-9])[A-HJ-NPR-Z0-9]{17}(?![A-Za-z0-9])/g;

const priority = { structured: 1, labelled: 2, address: 3, name: 4, household: 5, net: 6, manual: 0 } as const;

const compact = (value: string) => value.replace(/[\s\u00a0.-]/g, "").toUpperCase();

/** Clé de l'IBAN : reste de la division par 97 du nombre formé en déplaçant les quatre premiers caractères à la fin. */
export function ibanValid(raw: string): boolean {
  const iban = compact(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let rest = 0;
  for (const ch of digits) rest = (rest * 10 + Number(ch)) % 97;
  return rest === 1;
}

/** Clé du numéro de sécurité sociale (15 chiffres) : 97 − (les 13 premiers mod 97), la Corse comptant 2A = 19 et 2B = 18. */
export function nirValid(raw: string): boolean {
  const nir = compact(raw);
  if (nir.length === 13) return true; // sans la clé : on ne peut pas contrôler, la forme suffit
  if (nir.length !== 15) return false;
  const body = nir.slice(0, 13).replace("2A", "19").replace("2B", "18");
  if (!/^\d{13}$/.test(body)) return false;
  const key = 97 - Number(BigInt(body) % 97n);
  return key === Number(nir.slice(13));
}

function matches(text: string, re: RegExp): { start: number; end: number; value: string }[] {
  return [...text.matchAll(re)].map((m) => ({ start: m.index!, end: m.index! + m[0].length, value: m[0] }));
}

/** Couche 1, règles avec contrôle : identifiants à forme connue. */
export function structuredSpans(text: string): Span[] {
  const out: Span[] = [];
  const push = (type: Span["type"], re: RegExp, accept: (value: string) => boolean = () => true) => {
    for (const m of matches(text, re)) if (accept(m.value)) out.push({ start: m.start, end: m.end, type, key: compact(m.value), priority: priority.structured });
  };
  push("EMAIL", EMAIL);
  push("IBAN", IBAN, ibanValid);
  push("RIB", RIB);
  push("SECU", NIR, nirValid);
  push("TELEPHONE", PHONE_FR);
  push("TELEPHONE", PHONE_INTL);
  push("IMMATRICULATION", PLATE_SIV);
  push("IMMATRICULATION", PLATE_FNI);
  push("VIN", VIN, (v) => /\d{3}/.test(v) && /[A-Z]{3}/.test(v));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Valeurs qui suivent une étiquette (« N° de contrat : », « IBAN : », « Souscripteur : »…)
// ---------------------------------------------------------------------------------------------------------------------------

const ID_LABELS = [
  "contrat", "police", "adh[ée]rent", "sinistre", "pr[êe]t", "client", "dossier", "souscripteur", "soci[ée]taire", "carte", "compte", "certificat", "attestation", "bordereau", "avis d['’]?[ée]ch[ée]ance",
  "pdl", "pce", "point\\s+de\\s+(?:livraison|comptage)", "avis", "facture", "infraction", "contravention", "abonn[ée]", "installation",
];
const ID_AFTER_LABEL = new RegExp(
  `(?<label>(?:\\b(?:n[°ºo]|num[ée]ro|r[ée]f(?:[ée]rence)?\\.?)\\s*(?:de\\s+|d['’])?)?(?:${ID_LABELS.join("|")})\\s*(?:n[°ºo]|num[ée]ro)?\\s*[:：\\-]?\\s*)(?<value>\\d{1,4}(?:[ \\u00a0.]\\d{1,4}){2,8}|[A-Za-z0-9][A-Za-z0-9/.\\-]{3,30})`,
  "giu",
);
const BARE_NUMBER = /\b(?:n[°ºo]|num[ée]ro)\s*:?\s*(?<value>[A-Za-z0-9][A-Za-z0-9/.\-]{5,30})/giu;
const BIC_AFTER_LABEL = /\bBIC\s*(?:\/\s*SWIFT)?\s*:?\s*(?<value>[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?)\b/g;
const IBAN_AFTER_LABEL = /\b(?:IBAN|RIB)\s*:?\s*(?<value>[A-Z]{2}\d{2}(?:[ \u00a0]?[A-Za-z0-9]{2,4}){3,8}|[A-Za-z]{2,4}\d[A-Za-z0-9]+(?:[ \u00a0]\d[A-Za-z0-9]{1,12}){0,7})/g;
const ACCOUNT_AFTER_LABEL = /\b(?:identifiant|login|code\s+d['’]acc[èe]s|espace\s+client)\s*:?\s*(?<value>[A-Za-z0-9._@-]{4,40})/giu;
const EMPLOYER_AFTER_LABEL = new RegExp(`\\b(?:employeur|soci[ée]t[ée]\\s+employeuse|entreprise\\s+de\\s+l['’]assur[ée])\\s*:\\s*(?<value>[^\\n]{2,60})`, "giu");

function group(text: string, re: RegExp, name = "value"): { start: number; end: number; value: string }[] {
  const out: { start: number; end: number; value: string }[] = [];
  for (const m of text.matchAll(re)) {
    const value = m.groups?.[name];
    if (!value) continue;
    const start = m.index! + m[0].lastIndexOf(value);
    out.push({ start, end: start + value.length, value });
  }
  return out;
}

/** Couche 1, valeurs après étiquette : un numéro de contrat, d'adhérent, de sinistre ou de prêt contient au moins un chiffre. */
export function labelledSpans(text: string): Span[] {
  const out: Span[] = [];
  // Un numéro a au moins un chiffre et 5 caractères (4 s'il mêle lettres et chiffres) ; une année seule (« Avis d'échéance 2026 ») n'est pas un numéro.
  const keep = (value: string) => /\d/.test(value) && !/^(?:19|20)\d{2}$/.test(value) && (value.length >= 5 || (value.length >= 4 && /[A-Za-z]/.test(value)));
  for (const g of [...group(text, ID_AFTER_LABEL), ...group(text, BARE_NUMBER)]) {
    if (keep(g.value)) out.push({ start: g.start, end: g.end, type: "CONTRAT", key: compact(g.value), priority: priority.labelled });
  }
  for (const g of group(text, BIC_AFTER_LABEL)) out.push({ start: g.start, end: g.end, type: "BIC", key: compact(g.value), priority: priority.labelled });
  // Après « IBAN : », on masque même quand la clé est fausse (erreur de lecture) : mieux vaut trop que pas assez.
  for (const g of group(text, IBAN_AFTER_LABEL)) out.push({ start: g.start, end: g.end, type: "IBAN", key: compact(g.value), priority: priority.labelled });
  for (const g of group(text, ACCOUNT_AFTER_LABEL)) out.push({ start: g.start, end: g.end, type: "COMPTE", key: compact(g.value), priority: priority.labelled });
  for (const g of group(text, EMPLOYER_AFTER_LABEL)) out.push({ start: g.start, end: g.end, type: "EMPLOYEUR", key: compact(g.value), priority: priority.labelled });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Personnes (sans modèle : civilité ou étiquette) ; le modèle de langue (couche 3) complète
// ---------------------------------------------------------------------------------------------------------------------------

const CIVILITY = new RegExp(`\\b(?:M\\.|MM\\.|Mme|Mlle|Monsieur|Madame|Mademoiselle|Messieurs|Docteur|Dr|Ma[îi]tre|Me)\\s+(?<value>${WORD}(?:[ \\t\\u00a0]+${WORD}){0,3})`, "gu");
const PERSON_LABELS =
  "nom(?:\\s+et\\s+pr[ée]nom)?|pr[ée]nom|nom\\s+d['’]usage|nom\\s+de\\s+naissance|titulaire|souscripteur|assur[ée](?:\\s+principal)?|conducteur(?:\\s+principal|\\s+secondaire|\\s+d[ée]sign[ée])?|b[ée]n[ée]ficiaire|adh[ée]rent|co-?emprunteur|emprunteur|conjoint|repr[ée]sentant|interlocuteur|gestionnaire|agent|conseiller";
const PERSON_AFTER_LABEL = new RegExp(`\\b(?:${PERSON_LABELS})\\s*:\\s*(?<value>${WORD}(?:[ \\t\\u00a0]+${WORD}){0,3})`, "giu");
const NOT_A_NAME = new Set(["non", "oui", "aucun", "aucune", "neant", "néant", "sans", "madame", "monsieur", "mme", "mlle", "assurance", "assureur", "mutuelle", "banque", "france", "maaq", "n/a"]);

const capitalised = (value: string) => new RegExp(`^${WORD}(?:[ \\t\\u00a0]+${WORD}){0,3}$`, "u").test(value);

/** Zone repérée par le modèle de langue (couche 3) : positions dans le texte de la page, étiquette du modèle (PER, LOC, ORG). */
export interface DetectedEntity {
  start: number;
  end: number;
  label: string;
}

// Mots que le modèle prend parfois pour des noms : fonctions dans un contrat et assureurs, banques et courtiers courants (l'assureur est gardé, US-136 RF4).
const NER_KEEP = new Set([
  "conducteur", "souscripteur", "assure", "assuree", "beneficiaire", "titulaire", "adherent", "adherente", "locataire", "proprietaire", "emprunteur", "coemprunteur", "conjoint", "conjointe",
  "client", "cliente", "mandataire", "representant", "interlocuteur", "gestionnaire", "conseiller", "agent", "declarant", "tiers", "enfant", "enfants", "pere", "mere",
  "allianz", "axa", "maif", "macif", "maaf", "matmut", "gmf", "groupama", "generali", "mma", "gan", "april", "swisslife", "harmonie", "malakoff", "humanis", "mgen", "mgp", "aviva", "direct",
  "lemonade", "ornikar", "luko", "alan", "cardif", "afi", "esca", "credit", "agricole", "mutuel", "mutuelle", "lcl", "bnp", "paribas", "societe", "generale", "caisse", "epargne",
]);
const foldWord = (word: string) => word.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[-'’\s]/g, "").toLowerCase();

/**
 * Couche 3 : les noms de personnes repérés par le modèle de langue. Seules les personnes sont masquées ici : les lieux sont couverts par les règles d'adresse (la ville seule
 * n'identifie pas) et les employeurs par l'étiquette « Employeur : ». Un mot de fonction (« Conducteur ») ou un assureur connu n'est pas un nom.
 */
export function entitySpans(text: string, entities: DetectedEntity[]): Span[] {
  const out: Span[] = [];
  for (const entity of entities) {
    if (entity.label !== "PER") continue;
    const value = text.slice(entity.start, entity.end).replace(/\s+/g, " ").trim();
    const words = value.split(" ").filter((w) => /\p{L}/u.test(w));
    if (value.length < 3 || value.length > 60 || words.length === 0 || words.length > 5) continue;
    if (words.every((w) => NER_KEEP.has(foldWord(w)) || NOT_A_NAME.has(w.toLowerCase()))) continue;
    if (!words.every((w) => new RegExp(`^[${CAP}]`, "u").test(w))) continue;
    out.push({ start: entity.start, end: entity.end, type: "PERSONNE", key: words.map(foldWord).join(" "), priority: priority.name + 0.5 });
  }
  return out;
}

export function personSpans(text: string): Span[] {
  const out: Span[] = [];
  for (const g of [...group(text, CIVILITY), ...group(text, PERSON_AFTER_LABEL)]) {
    const words = g.value.split(/\s+/);
    // « Nom : Léo DUPONT » : tous les mots de la valeur ; on s'arrête avant un mot qui ne ressemble pas à un nom (mot vide, mot de liaison).
    const kept = words.filter((w) => !NOT_A_NAME.has(w.toLowerCase()));
    if (!kept.length || !capitalised(kept.join(" "))) continue;
    out.push({ start: g.start, end: g.start + g.value.length, type: "PERSONNE", key: kept.join(" ").toLowerCase(), priority: priority.name });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Adresses : ligne de voie masquée, code postal + ville ramenés au département
// ---------------------------------------------------------------------------------------------------------------------------

const STREET = new RegExp(
  `(?<![\\p{L}\\p{N}])\\d{1,4}(?:\\s?(?:bis|ter|quater|[A-D]))?[,\\s]+(?:rue|avenue|av\\.?|boulevard|bd|chemin|impasse|all[ée]e|place|route|quai|cours|passage|square|r[ée]sidence|lotissement|lieu-dit|hameau|villa|cit[ée]|cr[ée]marie|chaussée)\\b[^\\n,;]{2,70}`,
  "giu",
);
const ADDRESS_LABEL = /\b(?:adresse(?:\s+(?:du\s+risque|du\s+logement|postale|de\s+r[ée]sidence|d['’]habitation|de\s+facturation))?|domicile)\s*:\s*(?<value>[^\n]{4,90})/giu;
const POSTCODE_CITY = new RegExp(`(?<![\\d])(?<cp>(?:0[1-9]|[1-8]\\d|9[0-5]|97[1-6]|2[AB])\\d{3})\\s+(?<city>[${CAP}][${LETTER}'’ -]{1,40})`, "gu");

export function addressSpans(text: string): Span[] {
  const out: Span[] = [];
  for (const m of matches(text, STREET)) out.push({ start: m.start, end: m.end, type: "ADRESSE", key: compact(m.value).toLowerCase(), priority: priority.address });
  for (const g of group(text, ADDRESS_LABEL)) {
    // « Adresse : Lyon » est déjà une ville ; une ligne sans numéro de voie est masquée entière.
    out.push({ start: g.start, end: g.end, type: "ADRESSE", key: compact(g.value).toLowerCase(), priority: priority.address + 0.5 });
  }
  for (const m of text.matchAll(POSTCODE_CITY)) {
    const cp = m.groups!.cp;
    const dept = cp.startsWith("97") ? cp.slice(0, 3) : cp.slice(0, 2);
    out.push({ start: m.index!, end: m.index! + m[0].length, type: "DEPARTEMENT", key: dept, replacement: `département ${dept}`, priority: priority.address });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------
// Dates : naissance → âge ; permis → ancienneté
// ---------------------------------------------------------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  janvier: 1, fevrier: 2, février: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, aout: 8, août: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12, décembre: 12,
};
const DATE = `(?:\\d{1,2}[/.\\-]\\d{1,2}[/.\\-]\\d{2,4}|\\d{1,2}(?:er)?\\s+(?:${Object.keys(MONTHS).join("|")})\\s+\\d{4})`;
const BIRTH = new RegExp(`(?:n[ée](?:\\(e\\)|e)?\\s+(?:le|[A-Za-z1|]{1,2})|date\\s+de\\s+naissance|naissance)\\s*:?\\s*(?<value>${DATE})`, "giu");
const LICENCE = new RegExp(`(?:permis(?:\\s+de\\s+conduire)?(?:\\s+(?:obtenu|d[ée]livr[ée]))?(?:\\s+(?:le|en|[A-Za-z1|]{1,2}))?|date\\s+d['’]obtention\\s+du\\s+permis)\\s*:?\\s*(?<value>${DATE}|\\d{4})`, "giu");

function parseDate(raw: string): { y: number; m: number; d: number } | null {
  const numeric = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/.exec(raw);
  if (numeric) {
    const y = Number(numeric[3]);
    return { d: Number(numeric[1]), m: Number(numeric[2]), y: y < 100 ? (y > 30 ? 1900 + y : 2000 + y) : y };
  }
  const named = new RegExp(`^(\\d{1,2})(?:er)?\\s+(${Object.keys(MONTHS).join("|")})\\s+(\\d{4})$`, "i").exec(raw);
  if (named) return { d: Number(named[1]), m: MONTHS[named[2].toLowerCase()], y: Number(named[3]) };
  if (/^\d{4}$/.test(raw)) return { d: 1, m: 1, y: Number(raw) };
  return null;
}

export function yearsSince(date: { y: number; m: number; d: number }, now: Date): number {
  let years = now.getUTCFullYear() - date.y;
  if (now.getUTCMonth() + 1 < date.m || (now.getUTCMonth() + 1 === date.m && now.getUTCDate() < date.d)) years -= 1;
  return Math.max(0, years);
}

/**
 * Filet de la couche 1 : une longue suite de chiffres (9 et plus, avec des espaces, points ou tirets entre groupes) est un identifiant, même sans étiquette lisible (numéro de
 * client, de point de livraison, d'avis, d'abonné… mal lu ou posé dans un tableau). Les montants à décimales, les dates et ce que les autres règles reconnaissent gardent leur sens.
 */
const LONG_NUMBER = /(?<![\p{L}\p{N}[.,/])(?:\p{L}{1,4})?\d(?:[  .-]?\d){8,}(?![\p{L}\p{N}\]/]|[.,]\d)/gu;
export function longNumberSpans(text: string): Span[] {
  return matches(text, LONG_NUMBER)
    .filter((m) => m.value.replace(/\D/g, "").length >= 9)
    .map((m) => ({ start: m.start, end: m.end, type: "IDENTIFIANT" as const, key: compact(m.value), priority: priority.net }));
}

/** L'étiquette et la date sont remplacées ensemble : « né le 12/03/1985 » devient « âge : 41 ans ». */
export function dateSpans(text: string, now: Date): Span[] {
  const out: Span[] = [];
  for (const m of text.matchAll(BIRTH)) {
    const parsed = parseDate(m.groups!.value);
    if (parsed) out.push({ start: m.index!, end: m.index! + m[0].length, type: "AGE", key: m.groups!.value, replacement: `âge : ${yearsSince(parsed, now)} ans`, priority: priority.labelled });
  }
  for (const m of text.matchAll(LICENCE)) {
    const parsed = parseDate(m.groups!.value);
    if (parsed) out.push({ start: m.index!, end: m.index! + m[0].length, type: "ANCIENNETE", key: m.groups!.value, replacement: `permis depuis ${yearsSince(parsed, now)} ans`, priority: priority.labelled });
  }
  return out;
}

export { priority as PRIORITY };
