import type { Kysely } from "kysely";
import { logAdminAction } from "@/server/admin/audit";
import type { DB } from "@/server/db/schema.generated";
import { Matcher, norm, fmtMin } from "../../engine";
import { courseError } from "../../household/settings";
import { PLANNINGS_SPEC, PLANNINGS_TEMPLATE_HEADERS, PLANNING_DAY_COLUMNS } from "../../imports/specs";
import { toCsv } from "../../imports/table";
import { importRefusal, readImport } from "../import";
import { ROW_LIMIT, type ConsoleObject } from "../types";
import { csv, whole } from "../util";

/**
 * Plannings de batch cooking (US-170) et correspondances avec le catalogue (US-171). Une semaine type donne un plat par jour, du lundi au vendredi. Chaque plat de planning est
 * rapproché d'un plat du catalogue : sûr (80 % et plus, ou plat confirmé), à confirmer (40 à 80 %, le plat proche sert en attendant) ou absent (bloque la semaine).
 */

const DAY_NAMES = ["", "Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi"];
const STATUS_TEXT: Record<string, string> = { sure: "Sûr", to_confirm: "À confirmer", absent: "Absent · bloque la semaine" };

async function weekDays(db: Kysely<DB>) {
  return db
    .selectFrom("v_meal_batch_week_days as d")
    .innerJoin("meal_batch_weeks as w", "w.id", "d.week_id")
    .leftJoin("meal_dishes as s", "s.id", "d.suggested_dish_id")
    .leftJoin("meal_dishes as c", "c.id", "d.dish_id")
    .select(["d.week_id", "d.weekday", "d.planning_dish_name", "d.dish_id", "d.suggested_dish_id", "d.match_pct", "d.match_status", "d.blocks_week", "d.needs_catalog_addition", "w.code as week", "s.code as suggested_code", "s.name as suggested_name", "c.code as confirmed_code"])
    .orderBy("w.code")
    .orderBy("d.weekday")
    .execute();
}

export const plannings: ConsoleObject = {
  async load(c) {
    const { db } = c.ctx;
    const [weeks, days, cuisines] = await Promise.all([
      db.selectFrom("v_meal_batch_weeks").selectAll().orderBy("code").execute(),
      weekDays(db),
      db.selectFrom("meal_cuisines").select(["id", "name"]).execute(),
    ]);
    const cuisine = new Map(cuisines.map((k) => [k.id, k.name]));
    return {
      object: "plannings",
      title: "Plannings de batch cooking",
      intro: "Semaines types du lundi au vendredi, avec le déroulé de la séance du dimanche. Une semaine qui contient un plat « absent » n'est pas proposée.",
      info: `${weeks.filter((w) => w.is_usable).length} semaines utilisables sur ${weeks.length}`,
      columns: [
        { key: "code", label: "Id" },
        { key: "cuisine", label: "Cuisine" },
        { key: "theme", label: "Thème" },
        { key: "duration", label: "Durée" },
        { key: "linked", label: "Plats reliés" },
        { key: "usable", label: "Utilisable" },
      ],
      rows: weeks.map((w) => {
        const mine = days.filter((d) => String(d.week_id) === String(w.week_id));
        const state = !w.is_usable ? "Bloquée" : mine.some((d) => d.match_status === "to_confirm") ? "À confirmer" : "Oui";
        return {
          id: String(w.week_id),
          tone: state === "Oui" ? ("ok" as const) : state === "Bloquée" ? ("warn" as const) : ("info" as const),
          cells: { code: w.code ?? "", cuisine: cuisine.get(w.cuisine_id ?? 0) ?? "", theme: w.theme ?? "—", duration: fmtMin(w.session_minutes ?? 0), linked: `${w.linked_count} / ${w.day_count}`, usable: state },
          actions: [],
        };
      }),
      filters: [],
      search: false,
      total: weeks.length,
      footer: "Import : CSV (séparateur , ou ;) ou xlsx. Au premier import, les semaines actuelles sont conservées puis complétées. Sans « Tout remplacer », les lignes sont ajoutées ou mises à jour par identifiant.",
      tools: { downloads: [{ key: "template", label: "Télécharger le modèle" }, { key: "export", label: "Exporter" }, { key: "hors-batch", label: "Télécharger « plats hors batch »" }], import: { replaceAll: true } },
    };
  },

  async download(c, key) {
    const { db } = c.ctx;
    if (key === "template") {
      return { file: PLANNINGS_SPEC.templateFile, content: toCsv(PLANNINGS_TEMPLATE_HEADERS, [["AS5", "Afro", "Sauce tomate & volaille", "Ailes de poulet", "Haricots rouges", "Lasagnes", "Pâtes express", "Gratin de poireaux", "A12|A3||F20|F12", "Tailler les légumes | Lancer la sauce tomate | Enfourner", 120, 85]]) };
    }
    if (key === "hors-batch") {
      const { dishes } = await import("./dishes");
      return dishes.download!(c, "hors-batch", { q: "", filters: {} });
    }
    const [weeks, days, cuisines, dishes] = await Promise.all([
      db.selectFrom("meal_batch_weeks").selectAll().orderBy("code").execute(),
      weekDays(db),
      db.selectFrom("meal_cuisines").select(["id", "name"]).execute(),
      db.selectFrom("meal_dishes").select(["id", "code"]).execute(),
    ]);
    const code = new Map(dishes.map((d) => [String(d.id), d.code]));
    const cuisine = new Map(cuisines.map((k) => [k.id, k.name]));
    return {
      file: "plannings_batch.csv",
      content: csv(
        PLANNINGS_TEMPLATE_HEADERS,
        weeks.map((w) => {
          const mine = days.filter((d) => String(d.week_id) === String(w.id));
          return [w.code, cuisine.get(w.cuisine_id), w.theme ?? "", ...[1, 2, 3, 4, 5].map((n) => mine.find((d) => d.weekday === n)?.planning_dish_name ?? ""), mine.map((d) => (d.dish_id ? code.get(String(d.dish_id)) : "")).join("|"), w.session_text.split("\n").join(" | "), w.session_minutes, w.shared_ingredients_pct ?? ""];
        }),
      ),
    };
  },

  async import(c, file, options) {
    const { db, now } = c.ctx;
    const outcome = await readImport(PLANNINGS_SPEC, file, undefined);
    const [cuisines, dishes] = await Promise.all([db.selectFrom("meal_cuisines").select(["id", "name"]).execute(), db.selectFrom("meal_dishes").select(["id", "code", "name", "retired_at"]).execute()]);
    const cuisineId = new Map(cuisines.map((k) => [norm(k.name), k.id]));
    const byCode = new Map(dishes.map((d) => [d.code, d]));
    const catalog = dishes.filter((d) => !d.retired_at);
    const matcher = new Matcher(catalog.map((d) => ({ id: d.code, name: d.name })));
    const issues: { line: number; column: string; message: string }[] = [];
    const plans = outcome.rows.map((r) => {
      const v = r.values;
      const cid = cuisineId.get(norm(String(v.cuisine)));
      if (!cid) issues.push({ line: r.line, column: "cuisine", message: `cuisine « ${v.cuisine} » inconnue.` });
      const ids = (v.ids as string[] | null) ?? ["", "", "", "", ""];
      ids.forEach((id) => {
        if (id && !byCode.has(id)) issues.push({ line: r.line, column: "ids", message: `identifiant de plat « ${id} » inconnu dans le catalogue.` });
      });
      return { line: r.line, v, cid: cid ?? 0, ids };
    });
    if (issues.length) importRefusal(issues);
    const control = plans.flatMap((p) =>
      PLANNING_DAY_COLUMNS.map((day, i) => {
        const name = String(p.v[day]);
        const exact = p.ids[i] ? byCode.get(p.ids[i]) : undefined;
        const best = matcher.top(name, 1)[0];
        const pct = exact ? 100 : Math.round((best?.score ?? 0) * 100);
        return `${p.v.id_semaine} · ${DAY_NAMES[i + 1]} · ${name} → ${exact ? `${exact.code} (confirmé)` : best && best.score > 0 ? `${best.id} ${pct} %` : "aucun plat proche"} (${exact || pct >= 80 ? "sûr" : pct >= 40 ? "à confirmer" : "absent"})`;
      }),
    );
    if (options.dryRun) return { count: plans.length, lines: [`Fichier vérifié : ${plans.length} semaine${plans.length > 1 ? "s" : ""}. Rien n'a été importé.`, ...control.slice(0, 80)] };

    await db.transaction().execute(async (trx) => {
      const kept = new Set<string>();
      for (const p of plans) {
        const code = String(p.v.id_semaine);
        kept.add(code);
        const fields = {
          cuisine_id: p.cid,
          theme: (p.v.theme as string | null) || null,
          session_text: ((p.v.etapes as string[] | null) ?? []).join("\n") || "Séance à renseigner",
          session_minutes: Math.min(Math.max(Number(p.v.temps_total_min), 1), 1000),
          shared_ingredients_pct: (p.v.mutualisation_pct as number | null) ?? null,
          updated_at: now,
        };
        const existing = await trx.selectFrom("meal_batch_weeks").select("id").where("code", "=", code).executeTakeFirst();
        let weekId: string;
        const previous = new Map<string, string | null>();
        if (existing) {
          weekId = String(existing.id);
          await trx.updateTable("meal_batch_weeks").set(fields).where("id", "=", existing.id).execute();
          // une correspondance déjà confirmée à la main est gardée quand le nom du plat ne change pas (RF5)
          for (const old of await trx.selectFrom("meal_batch_week_days").select(["planning_dish_name", "dish_id"]).where("week_id", "=", existing.id).execute()) previous.set(norm(old.planning_dish_name), old.dish_id === null ? null : String(old.dish_id));
          await trx.deleteFrom("meal_batch_week_days").where("week_id", "=", existing.id).execute();
        } else {
          const created = await trx.insertInto("meal_batch_weeks").values({ code, ...fields }).returning("id").executeTakeFirstOrThrow();
          weekId = String(created.id);
        }
        for (const [i, day] of PLANNING_DAY_COLUMNS.entries()) {
          const name = String(p.v[day]).slice(0, 160);
          const exact = p.ids[i] ? byCode.get(p.ids[i]) : undefined;
          const confirmed = exact ? String(exact.id) : (previous.get(norm(name)) ?? null);
          const best = matcher.top(name, 1)[0];
          const suggested = confirmed ?? (best && best.score > 0 ? String(byCode.get(best.id)!.id) : null);
          await trx
            .insertInto("meal_batch_week_days")
            .values({ week_id: weekId, weekday: i + 1, planning_dish_name: name, dish_id: confirmed, suggested_dish_id: suggested, match_pct: confirmed ? 100 : Math.round((best?.score ?? 0) * 100) })
            .execute();
        }
      }
      if (options.replaceAll) {
        const old = await trx.selectFrom("meal_batch_weeks").select(["id", "code"]).execute();
        const stale = old.filter((w) => !kept.has(w.code)).map((w) => w.id);
        if (stale.length) await trx.deleteFrom("meal_batch_weeks").where("id", "in", stale).execute();
      }
    });
    await logAdminAction(db, { adminId: c.adminId, action: "meal_planning_changed", entityType: "meal_planning", entityId: "import", details: { weeks: plans.length, replaceAll: options.replaceAll }, now });
    return { count: plans.length, lines: [] };
  },
};

export const matches: ConsoleObject = {
  async load(c) {
    const { db } = c.ctx;
    const [days, dishes] = await Promise.all([weekDays(db), db.selectFrom("meal_dishes").select(["id", "code", "name"]).where("retired_at", "is", null).orderBy("code").execute()]);
    const open = days.filter((d) => d.match_status !== "sure");
    return {
      object: "correspondances",
      title: "Correspondances planning ↔ catalogue",
      intro: "Sûr : 80 % ou plus (ou identifiant renseigné). À confirmer : de 40 à 80 %, le plat proche est utilisé en attendant. Absent : moins de 40 %, la semaine est bloquée.",
      info: `${open.length} plat${open.length > 1 ? "s" : ""} de planning à traiter`,
      columns: [
        { key: "week", label: "Semaine" },
        { key: "day", label: "Jour" },
        { key: "name", label: "Plat du planning" },
        { key: "suggested", label: "Plat suggéré" },
        { key: "pct", label: "%", align: "right" },
        { key: "status", label: "Statut" },
      ],
      rows: open.slice(0, ROW_LIMIT).map((d) => ({
        id: `${d.week_id}:${d.weekday}`,
        tone: d.match_status === "absent" ? ("warn" as const) : ("info" as const),
        cells: { week: d.week, day: DAY_NAMES[d.weekday ?? 0] ?? "", name: d.planning_dish_name, suggested: d.suggested_code ? `${d.suggested_code} ${d.suggested_name}` : "—", pct: d.match_pct, status: (STATUS_TEXT[d.match_status ?? ""] ?? "") + (d.needs_catalog_addition ? " · à ajouter au catalogue" : "") },
        actions: [
          ...(d.suggested_dish_id ? [{ key: "confirm", label: "Confirmer" }] : []),
          { key: "choose", label: "Choisir…", fields: [{ key: "dish", label: "Plat du catalogue", type: "select" as const, options: dishes.map((x) => ({ value: String(x.id), label: `${x.code} ${x.name}` })) }] },
          ...(d.needs_catalog_addition ? [] : [{ key: "add", label: "À ajouter au catalogue" }]),
        ],
      })),
      filters: [],
      search: false,
      total: open.length,
      footer: "Une correspondance confirmée est enregistrée par identifiant de plat, et non plus par le nom.",
      tools: {
        downloads: [{ key: "export", label: "Télécharger les plats non sûrs" }],
        lookup: { label: "Calculer le pourcentage de correspondance", placeholder: "Nom du plat" },
        import: { replaceAll: false, check: true, checkOnly: true },
      },
    };
  },

  async act(c, action, id, values) {
    const { db, now } = c.ctx;
    const [weekId, weekday] = id.split(":");
    const day = await db.selectFrom("meal_batch_week_days").select(["week_id", "weekday", "suggested_dish_id"]).where("week_id", "=", weekId).where("weekday", "=", Number(weekday)).executeTakeFirst();
    if (!day) throw courseError("not_found", "Ce plat de planning n'existe plus.", 404);
    let set: Record<string, unknown>;
    if (action === "confirm") {
      if (!day.suggested_dish_id) throw courseError("no_suggestion", "Aucun plat suggéré : choisissez-en un.", 422);
      set = { dish_id: day.suggested_dish_id, match_pct: 100, needs_catalog_addition: false };
    } else if (action === "choose") {
      const dish = whole(values, "dish", "le plat", 1, 1_000_000_000);
      const exists = await db.selectFrom("meal_dishes").select("id").where("id", "=", String(dish)).where("retired_at", "is", null).executeTakeFirst();
      if (!exists) throw courseError("not_found", "Ce plat du catalogue n'existe plus.", 404);
      set = { dish_id: String(dish), suggested_dish_id: String(dish), match_pct: 100, needs_catalog_addition: false };
    } else if (action === "add") {
      set = { needs_catalog_addition: true };
    } else {
      throw courseError("unknown_action", "Action inconnue.", 422);
    }
    await db.updateTable("meal_batch_week_days").set({ ...set, updated_at: now } as never).where("week_id", "=", weekId).where("weekday", "=", Number(weekday)).execute();
    await logAdminAction(db, { adminId: c.adminId, action: "meal_planning_changed", entityType: "meal_planning", entityId: id, details: { action }, now });
  },

  async download(c) {
    const days = (await weekDays(c.ctx.db)).filter((d) => d.match_status !== "sure");
    return {
      file: "plats_planning_sans_catalogue.csv",
      content: csv(["semaine", "jour", "plat_du_planning", "plat_suggere", "pourcentage", "statut", "bloque_la_semaine"], days.map((d) => [d.week, DAY_NAMES[d.weekday ?? 0], d.planning_dish_name, d.suggested_code ? `${d.suggested_code} ${d.suggested_name}` : "", d.match_pct, d.match_status, d.blocks_week ? "oui" : "non"])),
    };
  },

  async lookup(c, value) {
    if (!value) throw courseError("missing_field", "Indiquez un nom de plat.", 422);
    const dishes = await c.ctx.db.selectFrom("meal_dishes").select(["code", "name"]).where("retired_at", "is", null).execute();
    const top = new Matcher(dishes.map((d) => ({ id: d.code, name: d.name }))).top(value, 3);
    const name = new Map(dishes.map((d) => [d.code, d.name]));
    return top.map((t) => `${t.id} ${name.get(t.id)} : ${Math.round(t.score * 100)} %`);
  },

  async import(c, file, options) {
    if (!options.dryRun) throw courseError("dry_run_only", "Ce contrôle n'importe rien : utilisez l'import des plannings.", 422);
    return plannings.import!(c, file, options);
  },
};
