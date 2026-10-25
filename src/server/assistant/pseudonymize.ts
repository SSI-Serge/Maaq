/**
 * Pseudonymisation des échanges avec le modèle (D31, D37). Référence de comportement : agent/banc_essai/pseudonymisation.py.
 *
 * - les prénoms des membres sont remplacés par « Parent N » / « Enfant N » avant l'envoi au modèle ;
 * - les adresses email et les numéros de téléphone sont masqués ;
 * - les alias reçus du modèle (réponse affichée ET paramètres des outils) sont retraduits en prénoms.
 *
 * Les messages restent en clair chez MAAQ : l'alias n'est appliqué qu'au moment de l'envoi. Il s'agit d'une pseudonymisation :
 * noms de famille, praticiens, écoles et lieux restent dans les textes envoyés.
 */

export type MemberRole = "parent" | "child";

export interface PseudoMember {
  id: string;
  firstName: string;
  role: MemberRole;
  aliasIndex: number;
  /** AAAA-MM-JJ */
  birthDate: string | null;
  /** Membre retiré : plus reconnu par l'assistant, mais son alias et son prénom restent traduits dans les textes existants (US-93 RF6). */
  archived?: boolean;
  /** Membre effacé définitivement : son prénom n'existe plus (D34). */
  erased?: boolean;
}

const ROLE_LABEL: Record<MemberRole, string> = { parent: "Parent", child: "Enfant" };

const EMAIL = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.\p{L}{2,}/gu;
// Numéros français (06 12 34 56 78, 0612345678, +33 6 12 34 56 78, 06.12.34.56.78) et internationaux ; pas les dates ni les heures.
const PHONE_FR = /(?<!\d)(?:(?:\+|00)33[\s.-]?\(?0?\)?|0)[1-9](?:[\s.-]?\d{2}){4}(?!\d)/g;
const PHONE_INTL = /(?<![\d+])\+\d{1,3}[\s.-]?\d(?:[\s.-]?\d{2,4}){2,4}(?!\d)/g;
const ALIAS = /(?<![\p{L}\p{N}_])(Parent|Enfant) (\d+)(?!\d)/gu;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Minuscule sans accent ; garde la longueur d'origine pour que les positions se recopient d'un texte à l'autre.
function foldChar(c: string): string {
  const folded = c.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  return folded.length === c.length ? folded : c;
}
export function fold(text: string): string {
  return [...text.normalize("NFC")].map(foldChar).join("");
}

export function ageBand(birthDate: string | null, now: Date): string {
  if (!birthDate) return "inconnu";
  const born = new Date(`${birthDate}T00:00:00Z`);
  let age = now.getUTCFullYear() - born.getUTCFullYear();
  if (now.getUTCMonth() < born.getUTCMonth() || (now.getUTCMonth() === born.getUTCMonth() && now.getUTCDate() < born.getUTCDate())) age -= 1;
  if (age < 3) return "0-2";
  if (age < 6) return "3-5";
  if (age < 11) return "6-10";
  if (age < 15) return "11-14";
  if (age < 18) return "15-17";
  return "18+";
}

export function maskContacts(text: string): string {
  return text.replace(EMAIL, "[email]").replace(PHONE_FR, "[téléphone]").replace(PHONE_INTL, "[téléphone]");
}

export class Pseudonymizer {
  readonly members: PseudoMember[];
  readonly warnings: string[] = [];
  private readonly byAlias = new Map<string, PseudoMember>();
  private readonly byKey = new Map<string, PseudoMember>();
  private readonly nameRe: RegExp | null;

  constructor(members: PseudoMember[]) {
    this.members = members;
    for (const m of members) this.byAlias.set(Pseudonymizer.aliasOf(m), m);
    // Les membres actifs d'abord : un prénom repris par un nouveau membre désigne le nouveau, pas l'ancien (US-93 RF8).
    for (const m of [...members].sort((a, b) => Number(Boolean(a.archived)) - Number(Boolean(b.archived)))) {
      const key = m.erased ? "" : fold(m.firstName).trim();
      if (!key) continue;
      if (!this.byKey.has(key)) this.byKey.set(key, m);
      else if (!m.archived) this.warnings.push(`prénom ambigu : « ${m.firstName} »`);
    }
    const keys = [...this.byKey.keys()].sort((a, b) => b.length - a.length); // le plus long d'abord
    // Le trait d'union compte comme une lettre : « Jean-Pierre » ne se coupe pas, « Marie-Claire » n'est pas « Marie ».
    this.nameRe = keys.length ? new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${keys.map(escapeRe).join("|")})(?![\\p{L}\\p{N}_-])`, "gu") : null;
  }

  static aliasOf(member: Pick<PseudoMember, "role" | "aliasIndex">): string {
    return `${ROLE_LABEL[member.role]} ${member.aliasIndex}`;
  }

  /** Texte envoyé au modèle : contacts masqués, prénoms remplacés par les alias. */
  toModel(text: string): string {
    let t = maskContacts(text.normalize("NFC"));
    if (!this.nameRe) return t;
    const folded = fold(t);
    let out = "";
    let last = 0;
    for (const match of folded.matchAll(this.nameRe)) {
      out += t.slice(last, match.index) + Pseudonymizer.aliasOf(this.byKey.get(match[0])!);
      last = match.index + match[0].length;
    }
    t = out + t.slice(last);
    return t;
  }

  /** Alias retraduits en prénoms ; un alias inconnu est laissé tel quel. */
  fromModel(text: string): string {
    return text.replace(ALIAS, (all, role: string, n: string) => this.byAlias.get(`${role} ${n}`)?.firstName ?? all);
  }

  /** Même retraduction pour toutes les chaînes d'une valeur JSON (paramètres d'un outil). */
  fromModelDeep<T>(value: T): T {
    if (typeof value === "string") return this.fromModel(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.fromModelDeep(v)) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.fromModelDeep(v)])) as T;
    return value;
  }

  /** Les membres que l'assistant connaît : ni retirés ni effacés. */
  get active(): PseudoMember[] {
    return this.members.filter((m) => !m.archived);
  }

  /** Résout la référence d'un membre reçue d'un outil : seul un alias est accepté, et seulement celui d'un membre actif. */
  resolve(ref: unknown): PseudoMember | null {
    const member = this.byAlias.get(String(ref).trim());
    return member && !member.archived ? member : null;
  }

  aliasFor(memberId: string): string {
    const m = this.members.find((x) => x.id === memberId);
    return m ? Pseudonymizer.aliasOf(m) : "une personne";
  }

  /** Alias inconnus de ce foyer présents dans un texte (le modèle en a inventé un). */
  unknownAliases(text: string): string[] {
    return [...text.matchAll(ALIAS)].filter((m) => !this.byAlias.has(`${m[1]} ${m[2]}`)).map((m) => m[0]);
  }

  /** Ce qui reste d'identifiant dans un texte destiné au modèle : contrôle des fuites. */
  leaks(text: string): string[] {
    const found: string[] = [];
    if (new RegExp(EMAIL.source, "u").test(text)) found.push("email");
    if (new RegExp(PHONE_FR.source).test(text) || new RegExp(PHONE_INTL.source).test(text)) found.push("téléphone");
    if (this.nameRe && new RegExp(this.nameRe.source, "u").test(fold(text))) found.push("prénom");
    return found;
  }
}
