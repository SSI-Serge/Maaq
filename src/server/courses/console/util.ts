import { courseError } from "../household/settings";
import type { ConsoleQuery, FormField } from "./types";

export function readQuery(params: URLSearchParams): ConsoleQuery {
  const filters: Record<string, string> = {};
  for (const [k, v] of params) if (k.startsWith("f_") && v) filters[k.slice(2)] = v;
  return { q: (params.get("q") ?? "").trim().slice(0, 80), filters };
}

/** Une valeur de formulaire, vérifiée selon son champ ; message clair si elle manque. */
export function text(values: Record<string, string>, key: string, label: string, max = 120): string {
  const v = (values[key] ?? "").trim().replace(/\s+/g, " ");
  if (!v) throw courseError("missing_field", `Il manque : ${label}.`, 422);
  if (v.length > max) throw courseError("too_long", `${label} : ${max} caractères au plus.`, 422);
  return v;
}

export function whole(values: Record<string, string>, key: string, label: string, min: number, max: number): number {
  const n = Number((values[key] ?? "").replace(",", "."));
  if (!Number.isInteger(n) || n < min || n > max) throw courseError("invalid_number", `${label} : un nombre entier de ${min} à ${max}.`, 422);
  return n;
}

export const field = (f: FormField): FormField => f;

export function oneOf<T extends string>(values: Record<string, string>, key: string, allowed: readonly T[], label: string): T {
  const v = values[key] as T;
  if (!allowed.includes(v)) throw courseError("invalid_choice", `${label} : choix non valide.`, 422);
  return v;
}

export function csv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `\uFEFF${[headers, ...rows].map((r) => r.map(cell).join(";")).join("\r\n")}\r\n`;
}

/** Semaine ISO d'un lundi : « 2026-S45 ». */
export function isoWeek(value: Date | string): string {
  const d = typeof value === "string" ? new Date(`${value.slice(0, 10)}T12:00:00Z`) : new Date(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate(), 12));
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4, 12));
  const week = 1 + Math.round(((d.getTime() - first.getTime()) / 86400000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-S${String(week).padStart(2, "0")}`;
}

export const euro = (value: number | string | null) => (value === null ? "N/A" : `${Number(value).toFixed(2).replace(".", ",")} €`);
export const dateFr = (value: Date | string | null) => {
  if (!value) return "";
  const s = typeof value === "string" ? value.slice(0, 10) : `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
  const [y, m, d] = s.split("-");
  return `${d}/${m}/${y}`;
};

/** « AAAA-MM-JJ » d'une date lue de la base (jour local, pas de décalage de fuseau). */
export const isoDate = (value: Date | string): string => (typeof value === "string" ? value.slice(0, 10) : `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`);
