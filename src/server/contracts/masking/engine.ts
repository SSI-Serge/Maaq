import { classifyPage, REMOVED_PAGE_LINE } from "./health";
import { householdSpans, manualSpans, personIdentity } from "./household";
import { addressSpans, dateSpans, entitySpans, labelledSpans, personSpans, structuredSpans, type DetectedEntity, type Span } from "./rules";
import { createTokenSpace, type MaskedDocument, type MaskedPage, type MaskOptions, type TokenSpace, type TokenType } from "./types";

export { createTokenSpace } from "./types";
export type { HouseholdFacts, MaskedDocument, MaskOptions, TokenSpace } from "./types";
export type { DetectedEntity } from "./rules";

/** Garde les zones sans chevauchement : la plus prioritaire d'abord, puis la plus longue. Une zone englobée par une autre est absorbée. */
export function resolve(spans: Span[]): Span[] {
  const sorted = [...spans].sort((a, b) => a.priority - b.priority || b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept: Span[] = [];
  for (const span of sorted) if (!kept.some((k) => span.start < k.end && k.start < span.end)) kept.push(span);
  return kept.sort((a, b) => a.start - b.start);
}

function tokenFor(space: TokenSpace, type: TokenType, key: string): string {
  const raw = `${type}:${key}`;
  const id = space.hash ? space.hash(raw) : raw;
  const known = space.assigned.get(id);
  if (known) return known;
  const n = (space.counters[type] = (space.counters[type] ?? 0) + 1);
  const token = `[${type}_${n}]`;
  space.assigned.set(id, token);
  return token;
}

/** Deux zones de personne séparées par des espaces seulement (« Camille DURAND ») forment une seule personne, identifiée par son prénom quand c'est un membre du foyer. */
function mergeNames(text: string, spans: Span[], options: MaskOptions): Span[] {
  const out: Span[] = [];
  for (const span of spans) {
    const previous = out[out.length - 1];
    if (previous && previous.type === "PERSONNE" && span.type === "PERSONNE" && /^[ \t\u00a0-]*$/.test(text.slice(previous.end, span.start))) {
      const joined = text.slice(previous.start, span.end);
      out[out.length - 1] = { ...previous, end: span.end, ...personIdentity(joined, options.household) };
    } else out.push(span);
  }
  return out.map((s) => (s.type === "PERSONNE" && !s.memberId && !s.key.startsWith("surname:") ? { ...s, ...personIdentity(text.slice(s.start, s.end), options.household) } : s));
}

/** Tous les repérages sur un texte, des plus sûrs (identifiants à forme connue) aux plus larges (liste du foyer, mots ajoutés à la main). */
function detect(text: string, options: MaskOptions, entities: DetectedEntity[]): Span[] {
  return [
    ...structuredSpans(text),
    ...labelledSpans(text),
    ...dateSpans(text, options.now),
    ...addressSpans(text),
    ...personSpans(text),
    ...entitySpans(text, entities),
    ...householdSpans(text, options.household),
    ...manualSpans(text, options.extraWords ?? []),
  ];
}

const RESIDUAL_LABEL: Partial<Record<Span["type"], string>> = {
  EMAIL: "email", TELEPHONE: "téléphone", IBAN: "IBAN", RIB: "RIB", SECU: "numéro de sécurité sociale", IMMATRICULATION: "immatriculation", VIN: "numéro de série", PERSONNE: "nom connu", ADRESSE: "adresse",
};

/**
 * Dernier contrôle sur le texte déjà masqué : si un motif personnel reste visible (email, téléphone, IBAN, nom du foyer, longue suite de chiffres), le document est « À vérifier »
 * et l'utilisateur le corrige dans l'aperçu (US-136 RF6). Retourne les types trouvés, jamais les valeurs.
 */
export function residualIssues(masked: string, options: MaskOptions): string[] {
  const found = new Set<string>();
  for (const span of [...structuredSpans(masked), ...householdSpans(masked, options.household)]) {
    const label = RESIDUAL_LABEL[span.type];
    if (label) found.add(label);
  }
  if (/(?<![\d[])\d{9,}(?![\d\]])/.test(masked.replace(/(?<=\d)[ .\u00a0](?=\d)/g, ""))) found.add("longue suite de chiffres");
  return [...found].sort();
}

/**
 * Masque les pages d'un document : jetons typés et stables ([PERSONNE_1], [ADRESSE_1]…), transformations (âge, ancienneté, département), pages de santé retirées.
 * Rien n'est conservé de ce qui a été masqué (US-136 RT3) : le résultat porte le texte masqué, des compteurs par type et les références aux membres du foyer.
 */
export function maskDocument(pages: string[], options: MaskOptions): MaskedDocument {
  const space = options.space ?? createTokenSpace();
  const counts: MaskedDocument["counts"] = {};
  const references: MaskedDocument["references"] = {};
  const out: MaskedPage[] = [];
  let removed = 0;
  let doubt = 0;
  for (const [index, original] of pages.entries()) {
    const state = classifyPage(original);
    if (state === "removed") {
      removed += 1;
      out.push({ text: REMOVED_PAGE_LINE, state });
      continue;
    }
    if (state === "doubt") doubt += 1;
    let text = "";
    let cursor = 0;
    for (const span of mergeNames(original, resolve(detect(original, options, options.entities?.[index] ?? [])), options)) {
      text += original.slice(cursor, span.start);
      cursor = span.end;
      counts[span.type] = (counts[span.type] ?? 0) + 1;
      if (span.replacement !== undefined) {
        text += span.replacement;
        continue;
      }
      const token = tokenFor(space, span.type as TokenType, span.key);
      if (span.memberId) references[token] = { kind: "member", id: span.memberId };
      text += token;
    }
    out.push({ text: text + original.slice(cursor), state });
  }
  const joined = out.map((p) => p.text).join("\n\n");
  const residual = residualIssues(out.filter((p) => p.state !== "removed").map((p) => p.text).join("\n\n"), options);
  return {
    pages: out,
    text: joined,
    counts,
    references,
    residual,
    removedHealthPages: removed,
    doubtHealthPages: doubt,
    state: doubt > 0 ? "blocked" : residual.length > 0 ? "to_verify" : "ok",
  };
}
