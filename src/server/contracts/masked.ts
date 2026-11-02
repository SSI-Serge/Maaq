import { open, seal } from "@/server/assistant/fields";
import { Rejection } from "@/server/http";
import type { MaskedDocument, PageState } from "./masking/types";

/**
 * Le texte masqué d'un document, tel qu'il est gardé chiffré avec lui (US-136 RT3, US-137) et supprimé avec lui. Il ne contient que des jetons : le texte d'origine n'est conservé
 * nulle part. Les masques posés à la main gardent, le temps de la vie du document, ce que chaque occurrence disait, pour pouvoir être annulés à l'identique (US-137 RF3).
 */

/** Version des règles de masquage, gardée avec le document (US-136 RT4). */
export const MASKING_RULES_VERSION = "rules-1";

export interface MaskedBlob {
  v: 1;
  pages: { text: string; state: PageState }[];
  counts: MaskedDocument["counts"];
  references: MaskedDocument["references"];
  removedHealthPages: number;
  doubtHealthPages: number;
  /** Masque posé à la main : son jeton et, dans l'ordre du texte, ce que disait chaque occurrence. */
  manual: { token: string; originals: string[] }[];
  /** Jetons déjà attribués dans le contrat (empreintes à clé, jamais une valeur), pour que le même nom garde le même jeton d'un document à l'autre. */
  tokens: Record<string, string>;
}

export const sealBlob = (blob: MaskedBlob): Buffer => seal(JSON.stringify(blob));
export const openBlob = (payload: Buffer): MaskedBlob => JSON.parse(open(payload)) as MaskedBlob;

const BRACKETS = /(\[[^\]\n]{1,80}\])/;
const MANUAL_TOKEN = /^\[DONNEE_(\d+)\]$/;
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** « Masquer aussi ce mot » : toutes les occurrences du mot (ou de l'expression), sans tenir compte de la casse, deviennent un jeton [DONNEE_n]. Les jetons existants ne sont jamais touchés. */
export function addManualMask(blob: MaskedBlob, wordInput: string): { blob: MaskedBlob; occurrences: number; token: string } {
  const word = wordInput.replace(/\s+/g, " ").trim();
  if (word.length < 2 || word.length > 60 || /[[\]\n]/.test(word)) throw new Rejection("invalid_body", "Choisissez un mot ou une courte expression du texte.", 422);
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(word).replace(/ /g, "\\s+")}(?![\\p{L}\\p{N}])`, "giu");
  const used = [...blob.pages.flatMap((p) => [...p.text.matchAll(/\[DONNEE_(\d+)\]/g)].map((m) => Number(m[1]))), ...blob.manual.map((m) => Number(MANUAL_TOKEN.exec(m.token)?.[1] ?? 0))];
  const token = `[DONNEE_${Math.max(0, ...used) + 1}]`;
  const originals: string[] = [];
  const pages = blob.pages.map((page) => {
    if (page.state === "removed") return page;
    const text = page.text
      .split(BRACKETS)
      .map((part, index) =>
        index % 2 === 1
          ? part
          : part.replace(re, (found) => {
              originals.push(found);
              return token;
            }),
      )
      .join("");
    return { ...page, text };
  });
  if (originals.length === 0) throw new Rejection("not_found", "Ce mot n'apparaît pas dans le texte.", 404);
  return {
    blob: { ...blob, pages, manual: [...blob.manual, { token, originals }], counts: { ...blob.counts, DONNEE: (blob.counts.DONNEE ?? 0) + originals.length } },
    occurrences: originals.length,
    token,
  };
}

/** Annule un masque posé à la main : chaque occurrence retrouve exactement ce qu'elle disait. */
export function removeManualMask(blob: MaskedBlob, token: string): MaskedBlob {
  const entry = blob.manual.find((m) => m.token === token);
  if (!entry) throw new Rejection("not_found", "Ce masque n'existe pas ou n'existe plus.", 404);
  let next = 0;
  const pages = blob.pages.map((page) => ({ ...page, text: page.text.split(token).reduce((acc, part, i) => (i === 0 ? part : `${acc}${entry.originals[next++] ?? ""}${part}`), "") }));
  const { DONNEE, ...others } = blob.counts;
  const remaining = Math.max(0, (DONNEE ?? 0) - entry.originals.length);
  const counts: MaskedBlob["counts"] = remaining ? { ...others, DONNEE: remaining } : others;
  return { ...blob, pages, counts, manual: blob.manual.filter((m) => m.token !== token) };
}

const MASK_TYPE: Record<string, string> = {
  PERSONNE: "person", ADRESSE: "address", EMAIL: "email", TELEPHONE: "phone", CONTRAT: "contract_number", IBAN: "bank_account", BIC: "bank_account", RIB: "bank_account",
  IMMATRICULATION: "vehicle", VIN: "vehicle", SECU: "social_security", EMPLOYEUR: "employer", COMPTE: "account_identifier", IDENTIFIANT: "account_identifier", DONNEE: "manual",
};

/** Compteurs par type de masque, au vocabulaire de la base (US-136 RT4) ; ce qui n'est pas un jeton (âge, ancienneté, département) compte comme « autre ». */
export function dbMaskCounts(counts: MaskedBlob["counts"]): { mask_type: string; mask_count: number }[] {
  const out = new Map<string, number>();
  for (const [type, n] of Object.entries(counts)) out.set(MASK_TYPE[type] ?? "other", (out.get(MASK_TYPE[type] ?? "other") ?? 0) + (n ?? 0));
  return [...out].filter(([, n]) => n > 0).map(([mask_type, mask_count]) => ({ mask_type, mask_count }));
}
