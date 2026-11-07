import { logAdminAction } from "@/server/admin/audit";
import { nameKey, placeKey } from "../../catalog/seed";
import { norm } from "../../engine";
import { courseError, displayPlace } from "../../household/settings";
import { REFERENCES_SPEC, REFERENCES_TEMPLATE_HEADERS, type ReferenceStatusLabel } from "../../imports/specs";
import { toCsv } from "../../imports/table";
import { readImport, importRefusal } from "../import";
import { ROW_LIMIT, type ConsoleContext, type ConsoleObject, type ConsoleQuery } from "../types";
import { csv, dateFr, euro, text } from "../util";

/**
 * Références par enseigne (US-166, US-174) : pour chaque produit, ses références par enseigne avec leur prix et la date du prix. Une référence au statut « aucun conforme trouvé »
 * ou qui contient un additif des critères n'est jamais proposée aux foyers. Un prix de plus de 12 mois n'est plus affiché aux foyers.
 */

const STATUS: Record<ReferenceStatusLabel, "compliant" | "not_applicable" | "to_check" | "none_found"> = {
  conforme: "compliant",
  "sans objet": "not_applicable",
  "a verifier": "to_check",
  "aucun conforme trouve": "none_found",
};
const STATUS_TEXT = { compliant: "Conforme", not_applicable: "Sans objet", to_check: "À vérifier", none_found: "Aucun conforme trouvé" } as const;

async function list(c: ConsoleContext, query: ConsoleQuery) {
  const { db } = c.ctx;
  let q = db
    .selectFrom("v_grocery_product_references as r")
    .innerJoin("grocery_products as p", "p.id", "r.product_id")
    .innerJoin("grocery_aisles as a", "a.id", "p.aisle_id")
    .select(["r.reference_id", "p.name as product", "a.name as aisle", "p.aisle_id", "r.store_chain", "r.reference_name", "r.unit_price", "r.price_date", "r.is_compliant", "r.excluded_because", "r.compliance_status", "r.composition_text"])
    .orderBy("p.name")
    .orderBy("r.store_chain");
  if (query.q) q = q.where((eb) => eb.or([eb("p.name", "ilike", `%${query.q}%`), eb("r.reference_name", "ilike", `%${query.q}%`)]));
  if (query.filters.rayon) q = q.where("p.aisle_id", "=", Number(query.filters.rayon));
  if (query.filters.enseigne) q = q.where("r.store_chain", "=", query.filters.enseigne);
  const conf = query.filters.conformite;
  if (conf === "oui") q = q.where("r.is_compliant", "=", true);
  else if (conf === "non") q = q.where("r.is_compliant", "=", false);
  else if (conf === "verifier") q = q.where("r.compliance_status", "=", "to_check");
  else if (conf === "sans_prix") q = q.where("r.unit_price", "is", null);
  return q.execute();
}

export const references: ConsoleObject = {
  async load(c, query) {
    const { db } = c.ctx;
    const [rows, aisles, stores] = await Promise.all([list(c, query), db.selectFrom("grocery_aisles").select(["id", "name"]).orderBy("sort_order").execute(), db.selectFrom("grocery_product_references").select("store_chain").distinct().orderBy("store_chain").execute()]);
    return {
      object: "references",
      title: "Références par enseigne",
      intro: "Chaque prix porte sa date. Chez les foyers : « < 6 mois », « < 12 mois », et plus d'affichage au-delà de 12 mois.",
      info: null,
      columns: [
        { key: "product", label: "Produit" },
        { key: "aisle", label: "Rayon" },
        { key: "store", label: "Enseigne" },
        { key: "ref", label: "Référence" },
        { key: "price", label: "Prix", align: "right" },
        { key: "date", label: "Date du prix" },
        { key: "compliant", label: "Conforme" },
      ],
      rows: rows.slice(0, ROW_LIMIT).map((r) => ({
        id: String(r.reference_id),
        tone: r.is_compliant ? undefined : ("warn" as const),
        cells: {
          product: r.product,
          aisle: r.aisle,
          store: displayPlace(r.store_chain ?? ""),
          ref: r.reference_name ?? "",
          price: euro(r.unit_price),
          date: dateFr(r.price_date as Date | string | null) || "—",
          compliant: r.is_compliant ? (r.compliance_status === "to_check" ? "À vérifier" : r.compliance_status === "not_applicable" ? "Sans objet" : "Oui") : r.excluded_because?.length ? r.excluded_because.join(", ") : "Aucun conforme trouvé",
        },
        actions: [
          {
            key: "edit",
            label: "Modifier",
            fields: [
              { key: "ref", label: "Référence", type: "text" as const, value: r.reference_name, required: true },
              { key: "price", label: "Prix unitaire (€, vide = N/A)", type: "text" as const, value: r.unit_price === null ? "" : String(r.unit_price) },
              { key: "date", label: "Date du prix (AAAA-MM-JJ, vide si pas de prix)", type: "text" as const, value: r.price_date ? new Date(r.price_date as Date | string).toISOString().slice(0, 10) : "" },
              { key: "status", label: "Statut", type: "select" as const, value: r.compliance_status, options: (Object.keys(STATUS_TEXT) as (keyof typeof STATUS_TEXT)[]).map((k) => ({ value: k, label: STATUS_TEXT[k] })) },
            ],
          },
        ],
      })),
      filters: [
        { key: "rayon", label: "Rayon", value: query.filters.rayon ?? "", options: [{ value: "", label: "Rayon : tous" }, ...aisles.map((a) => ({ value: String(a.id), label: a.name }))] },
        { key: "enseigne", label: "Enseigne", value: query.filters.enseigne ?? "", options: [{ value: "", label: "Enseigne : toutes" }, ...stores.map((s) => ({ value: s.store_chain, label: displayPlace(s.store_chain) }))] },
        { key: "conformite", label: "Conformité", value: query.filters.conformite ?? "", options: [{ value: "", label: "Conformité : toutes" }, { value: "oui", label: "Proposées" }, { value: "non", label: "Exclues" }, { value: "verifier", label: "À vérifier" }, { value: "sans_prix", label: "Sans prix" }] },
      ],
      search: true,
      total: rows.length,
      footer: "Import : CSV (séparateur , ou ;) ou xlsx. Tout le fichier est vérifié avant l'écriture. Sans « Tout remplacer », les lignes sont ajoutées ou mises à jour (produit + enseigne + référence).",
      tools: { downloads: [{ key: "template", label: "Télécharger le modèle" }, { key: "export", label: "Exporter" }], import: { replaceAll: true, check: true } },
    };
  },

  async act(c, action, id, values) {
    const { db, now } = c.ctx;
    if (action !== "edit") throw courseError("unknown_action", "Action inconnue.", 422);
    const reference = text(values, "ref", "la référence", 160);
    const rawPrice = (values.price ?? "").trim().replace(",", ".");
    const price = rawPrice === "" ? null : Number(rawPrice);
    if (price !== null && (!Number.isFinite(price) || price <= 0 || price > 10000)) throw courseError("invalid_price", "Le prix doit être supérieur à 0 (ou vide pour N/A).", 422);
    const date = (values.date ?? "").trim();
    if (price !== null && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw courseError("invalid_date", "Indiquez la date du prix (AAAA-MM-JJ).", 422);
    const status = values.status as keyof typeof STATUS_TEXT;
    if (!(status in STATUS_TEXT)) throw courseError("invalid_choice", "Statut non valide.", 422);
    await db
      .updateTable("grocery_product_references")
      .set({ reference_name: reference, unit_price: price === null ? null : price.toFixed(2), price_date: price === null ? null : (date as never), compliance_status: status, updated_at: now })
      .where("id", "=", id)
      .execute();
    await logAdminAction(db, { adminId: c.adminId, action: "grocery_catalog_changed", entityType: "grocery_reference", entityId: id, details: { action }, now });
  },

  async download(c, key, query) {
    if (key === "template") {
      return { file: REFERENCES_SPEC.templateFile, content: toCsv(REFERENCES_TEMPLATE_HEADERS, [["Pâtes à lasagne", "Féculents", "Lidl", "Barilla 500 g", "1,35", "2026-10-12", "Conforme", "", "Pâtes de blé dur"]]) };
    }
    const rows = await list(c, { ...query, q: query.q });
    return {
      file: "references.csv",
      content: csv(
        REFERENCES_TEMPLATE_HEADERS,
        rows.map((r) => [r.product, r.aisle, displayPlace(r.store_chain ?? ""), r.reference_name, r.unit_price === null ? "" : String(r.unit_price).replace(".", ","), r.price_date ? new Date(r.price_date as Date | string).toISOString().slice(0, 10) : "", STATUS_TEXT[r.compliance_status as keyof typeof STATUS_TEXT], "", r.composition_text ?? ""]),
      ),
    };
  },

  async import(c, file, options) {
    const { db, now } = c.ctx;
    const aisleRows = await db.selectFrom("grocery_aisles").select(["id", "name"]).execute();
    const aisleId = new Map(aisleRows.map((a) => [norm(a.name), a.id]));
    const outcome = await readImport(REFERENCES_SPEC, file, undefined);
    const issues: { line: number; column: string; message: string }[] = [];
    const items = outcome.rows.map((r) => {
      const rayon = String(r.values.rayon ?? "");
      const id = aisleId.get(norm(rayon));
      if (rayon && !id) issues.push({ line: r.line, column: "rayon", message: `rayon « ${rayon} » inconnu.` });
      return { line: r.line, v: r.values, aisle: id ?? null };
    });
    // un produit qui n'existe pas encore doit avoir un rayon connu
    const existing = new Map((await db.selectFrom("grocery_products").select(["id", "name_key"]).execute()).map((p) => [p.name_key, p.id]));
    for (const it of items) if (!existing.has(nameKey(String(it.v.produit))) && !it.aisle) issues.push({ line: it.line, column: "rayon", message: "rayon obligatoire pour un produit nouveau." });
    if (issues.length) importRefusal(issues);
    if (options.dryRun) return { count: items.length, lines: [`Fichier vérifié : ${items.length} ligne${items.length > 1 ? "s" : ""} valide${items.length > 1 ? "s" : ""}. Rien n'a été importé.`] };

    await db.transaction().execute(async (trx) => {
      const keys = new Set<string>();
      for (const it of items) {
        const name = String(it.v.produit);
        const key = nameKey(name).slice(0, 120);
        let productId = existing.get(key);
        if (!productId) {
          const created = await trx.insertInto("grocery_products").values({ name: name.slice(0, 120), name_key: key, aisle_id: it.aisle! }).returning("id").executeTakeFirstOrThrow();
          productId = created.id;
          existing.set(key, productId);
        } else if (it.aisle) {
          await trx.updateTable("grocery_products").set({ aisle_id: it.aisle, updated_at: now }).where("id", "=", productId).execute();
        }
        const store = placeKey(String(it.v.enseigne)).slice(0, 80);
        const ref = String(it.v.reference).slice(0, 160);
        const price = it.v.prix as number | null;
        const values = {
          unit_price: price === null ? null : price.toFixed(2),
          price_date: price === null ? null : (it.v.date_prix as string as never),
          compliance_status: STATUS[norm(String(it.v.statut ?? "Conforme")) as ReferenceStatusLabel],
          additives: (it.v.additifs as string[] | null) ?? [],
          composition_text: (it.v.composition as string | null) || null,
          updated_at: now,
        };
        await trx
          .insertInto("grocery_product_references")
          .values({ product_id: productId, store_chain: store, reference_name: ref, ...values })
          .onConflict((oc) => oc.columns(["product_id", "store_chain", "reference_name"]).doUpdateSet(values))
          .execute();
        keys.add(`${productId}|${store}|${ref}`);
      }
      if (options.replaceAll) {
        const all = await trx.selectFrom("grocery_product_references").select(["id", "product_id", "store_chain", "reference_name"]).execute();
        const stale = all.filter((r) => !keys.has(`${r.product_id}|${r.store_chain}|${r.reference_name}`)).map((r) => r.id);
        if (stale.length) await trx.deleteFrom("grocery_product_references").where("id", "in", stale).execute();
      }
    });
    await logAdminAction(db, { adminId: c.adminId, action: "grocery_catalog_changed", entityType: "grocery_reference", entityId: "import", details: { lines: items.length, replaceAll: options.replaceAll }, now });
    return { count: items.length, lines: [] };
  },
};
