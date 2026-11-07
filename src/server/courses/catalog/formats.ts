import { norm } from "../engine";
import { parseCsv, toCsv } from "../imports/table";
import { REFERENCES_TEMPLATE_HEADERS } from "../imports/specs";

/**
 * Ajoute le format du conditionnement (colonne « Format » du classeur) à l'export des références d'une base : le fichier rendu garde toutes les autres valeurs de la base
 * (prix, dates, statuts, additifs, composition) et ne change que la colonne « format ». Réimporté par la console, il met les références à jour sans rien supprimer.
 */
export function addFormats(
  exported: string,
  catalog: { product: string; store: string; ref: string; format?: string }[],
): { csv: string; withFormat: number; rows: number; unmatched: number } {
  const key = (product: string, store: string, ref: string) => [product, store, ref].map((x) => norm(x).replace(/\s+/g, " ").trim()).join("|");
  const formats = new Map(catalog.filter((r) => r.format?.trim()).map((r) => [key(r.product, r.store, r.ref), r.format!.trim().slice(0, 80)]));
  const table = parseCsv(exported.replace(/^﻿/, ""));
  const head = table[0].map((h) => norm(h).trim());
  const col = (name: string) => head.indexOf(name);
  const [cp, cs, cr, cf] = [col("produit"), col("enseigne"), col("reference"), col("format")];
  if ([cp, cs, cr, cf].some((i) => i < 0)) throw new Error("L'export des références n'a pas les colonnes attendues.");
  let withFormat = 0;
  let unmatched = 0;
  const rows = table.slice(1).filter((r) => r.some((c) => c.trim() !== ""));
  for (const r of rows) {
    const value = formats.get(key(r[cp], r[cs], r[cr]));
    if (value) {
      r[cf] = value;
      withFormat += 1;
    } else if (!r[cf]) {
      unmatched += 1;
    }
  }
  return { csv: toCsv(REFERENCES_TEMPLATE_HEADERS, rows), withFormat, rows: rows.length, unmatched };
}
