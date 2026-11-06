import { readSheet } from "read-excel-file/node";

/** Une feuille lue : lignes de texte, la première étant l'en-tête. `lines[i]` est le numéro de ligne affiché à l'administrateur (1 = en-tête). */
export interface Table {
  rows: string[][];
  lines: number[];
}

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 20000;

export class ImportFileError extends Error {
  constructor(readonly code: "too_big" | "empty" | "unreadable" | "unsupported", message: string) {
    super(message);
  }
}

/** Sépare un texte CSV en cellules : guillemets, séparateur `,` ou `;` (le plus fréquent sur la ligne d'en-tête), retours à la ligne dans les guillemets. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = firstLine.split(";").length > firstLine.split(",").length ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === delimiter) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}

/** Lit un fichier d'import (CSV ou xlsx, première feuille) en tableau de texte. */
export async function readTable(file: { name: string; content: Buffer }): Promise<Table> {
  if (file.content.length > MAX_BYTES) throw new ImportFileError("too_big", "Fichier trop volumineux (5 Mo au plus).");
  const name = file.name.toLowerCase();
  let raw: string[][];
  if (name.endsWith(".csv") || name.endsWith(".txt")) {
    raw = parseCsv(file.content.toString("utf8"));
  } else if (name.endsWith(".xlsx")) {
    try {
      const sheet = await readSheet(file.content);
      raw = sheet.map((r) => r.map(cellText));
    } catch {
      throw new ImportFileError("unreadable", "Fichier xlsx illisible.");
    }
  } else {
    throw new ImportFileError("unsupported", "Format non pris en charge : utilisez un fichier .csv ou .xlsx.");
  }
  const rows: string[][] = [];
  const lines: number[] = [];
  raw.forEach((r, i) => {
    if (i === 0 || r.some((c) => c.trim() !== "")) {
      rows.push(r);
      lines.push(i + 1);
    }
  });
  if (rows.length === 0 || rows[0].every((c) => c.trim() === "")) throw new ImportFileError("empty", "Fichier vide.");
  if (rows.length > MAX_ROWS) throw new ImportFileError("too_big", `Trop de lignes (${MAX_ROWS} au plus).`);
  return { rows, lines };
}

/** CSV pour un modèle ou un export : séparateur `;`, BOM pour qu'Excel affiche bien les accents. */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const esc = (v: string | number | null | undefined) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${[headers, ...rows].map((r) => r.map(esc).join(";")).join("\r\n")}\r\n`;
}
