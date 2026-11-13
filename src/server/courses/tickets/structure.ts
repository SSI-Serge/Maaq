import { readFileSync } from "node:fs";
import path from "node:path";
import { createModel, type AssistantModel, type TextBlock } from "@/server/assistant/model";
import { env } from "@/server/env";
import { norm, pricePerMeasure, toMeasure, type MeasureUnit } from "../engine";

/**
 * Mise en forme du texte d'un ticket (US-161 RF2) : un appel du modèle, sans outil, sur le seul texte masqué, qui répond par un objet JSON. Le résultat est vérifié ici ligne par
 * ligne (rayon dans la liste, montants et quantités plausibles) avant d'être montré : l'utilisateur corrige ensuite chaque ligne et confirme (RF4).
 */

export interface TicketLineDraft {
  product: string;
  reference: string | null;
  /** Prix total de la ligne en euros (quantité déjà multipliée) ; négatif pour une remise. */
  total: number;
  qty: number;
  aisle: string;
  /** Produit pesé : poids ou volume en kilos ou en litres (les grammes et centilitres sont convertis), prix au kilo ou au litre lu ou calculé (CR-39). */
  measured: number | null;
  measureUnit: MeasureUnit | null;
  pricePerMeasure: number | null;
}

export interface TicketDraft {
  readable: boolean;
  store: string;
  city: string | null;
  /** « AAAA-MM-JJ » ; la date du jour si l'originale est illisible (RF3). */
  date: string;
  dateGuessed: boolean;
  /** Heure d'achat « HH:MM:SS » (secondes à 00 si non imprimées) ; null si illisible : l'utilisateur la saisit avant de confirmer (CR-41). */
  time: string | null;
  lines: TicketLineDraft[];
}

export interface TicketStructurer {
  structure(input: { text: string; aisles: string[] }): Promise<unknown>;
}

const OTHER = "Autres";
const MAX_LINES = 100;

const instructions = () => readFileSync(path.join(process.env.COURSES_AGENT_DIR ?? path.join(process.cwd(), "agent-courses"), "ticket.md"), "utf8");

declare global {
  var __maaqTicketStructurer: TicketStructurer | null | undefined;
  var __maaqTicketModel: AssistantModel | undefined;
}

/** Le structureur du mode courant : le modèle quand l'assistant est ouvert (`ASSISTANT_MODE=live`), sinon aucun. */
export function ticketStructurer(): TicketStructurer | null {
  if (globalThis.__maaqTicketStructurer !== undefined) return globalThis.__maaqTicketStructurer;
  const settings = env();
  if (settings.ASSISTANT_MODE !== "live") return null;
  return {
    async structure({ text, aisles }) {
      globalThis.__maaqTicketModel ??= createModel({ provider: settings.ASSISTANT_PROVIDER, apiKey: settings.ANTHROPIC_API_KEY!, model: settings.ASSISTANT_MODEL, effort: "low", timeoutMs: 90_000, maxTokens: 4_000 });
      const answer = await globalThis.__maaqTicketModel.send({
        kind: "ticket",
        system: instructions(),
        tools: [],
        messages: [{ role: "user", content: `Rayons disponibles : ${aisles.join(" | ")}\n\n<ticket>\n${text}\n</ticket>` }],
      });
      return answer.content.filter((b): b is TextBlock => b.type === "text").map((b) => b.text).join("\n");
    },
  };
}

/** Pour les tests : remplace le structureur (null = aucun) ; sans argument, revient à la configuration. */
export function setTicketStructurer(structurer: TicketStructurer | null | undefined): void {
  globalThis.__maaqTicketStructurer = structurer;
}

function extractJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
}

const money = (value: unknown): number | null => {
  const n = typeof value === "number" ? value : Number(String(value ?? "").replace(/\s/g, "").replace("€", "").replace(",", "."));
  return Number.isFinite(n) && Math.abs(n) <= 10_000 && n !== 0 ? Math.round(n * 100) / 100 : null;
};

/** « 17:08:23 », « 17:08 », « 17h08 »… → « HH:MM:SS » (secondes à 00 si absentes) ; null si ce n'est pas une heure. */
export function normalizeTime(value: unknown): string | null {
  const match = /^\s*(\d{1,2})\s*[:hH]\s*(\d{2})(?:\s*[:mM]\s*(\d{2}))?\s*(?:s)?\s*$/.exec(String(value ?? ""));
  if (!match) return null;
  const [h, m, s] = [Number(match[1]), Number(match[2]), Number(match[3] ?? 0)];
  if (h > 23 || m > 59 || s > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const clean = (value: unknown, max: number): string => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** Vérifie et remet en forme la réponse du modèle ; une ligne douteuse est écartée plutôt que devinée. */
export function normalizeDraft(raw: unknown, aisles: string[], today: string): TicketDraft {
  const data = extractJson(raw) as Record<string, unknown> | null;
  const empty: TicketDraft = { readable: false, store: "", city: null, date: today, dateGuessed: true, time: null, lines: [] };
  if (!data || typeof data !== "object") return empty;
  const aisleByKey = new Map(aisles.map((a) => [norm(a), a]));
  const lines: TicketLineDraft[] = [];
  for (const l of Array.isArray(data.lines) ? (data.lines as Record<string, unknown>[]) : []) {
    const product = clean(l?.product, 120);
    const total = money(l?.total);
    if (!product || total === null) continue;
    const qtyRaw = Number(String(l.qty ?? 1).replace(",", "."));
    const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 && qtyRaw <= 999 ? Math.round(qtyRaw * 1000) / 1000 : 1;
    const weight = Number(String(l.weight ?? "").replace(",", "."));
    const measure = l.weight !== undefined && l.weight !== null && Number.isFinite(weight) ? toMeasure(weight, clean(l.weight_unit, 4)) : null;
    const read = Number(String(l.price_per_unit ?? "").replace(/\s/g, "").replace("€", "").replace(",", "."));
    lines.push({
      product,
      reference: clean(l.reference, 160) || null,
      total,
      qty: measure ? 1 : qty,
      aisle: aisleByKey.get(norm(clean(l.aisle, 60))) ?? aisleByKey.get(norm(OTHER)) ?? aisles[0] ?? OTHER,
      measured: measure?.amount ?? null,
      measureUnit: measure?.unit ?? null,
      pricePerMeasure: measure ? pricePerMeasure(Number.isFinite(read) && read > 0 ? read : null, total, measure.amount) : null,
    });
    if (lines.length >= MAX_LINES) break;
  }
  const dateText = clean(data.date, 10);
  const valid = /^\d{4}-\d{2}-\d{2}$/.test(dateText) && !Number.isNaN(Date.parse(`${dateText}T12:00:00Z`)) && dateText <= today;
  const store = clean(data.store, 80);
  const readable = data.readable !== false && lines.length > 0;
  return { readable, store, city: clean(data.city, 80) || null, date: valid ? dateText : today, dateGuessed: !valid, time: normalizeTime(data.time), lines: readable ? lines : [] };
}
