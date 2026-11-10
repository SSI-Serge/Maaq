import type { Kysely } from "kysely";
import type { DB } from "@/server/db/schema.generated";
import { nameKey } from "../catalog/seed";
import { estimateMinutes } from "../engine";
import type { EngineData } from "../menu/data";
import { minutesFromSteps, type ProposalStep } from "../menu-ia/proposal";
import { costOf, summarize, type PoolDish, type PriceFn, type Solution } from "./solver";

/**
 * Reprise du déroulé d'une semaine du menu du mois (US-178 RF9, décision du PO, CR-59) : si les cinq dîners de la séance d'une semaine correspondent à une semaine type (US-170) ou à une séance déjà faite par le
 * foyer (le même ensemble de plats dans un menu validé qui a un déroulé), on reprend son déroulé et sa durée, sans IA. Sinon la durée reste estimée et « Rédiger le déroulé » reste facultatif.
 * MAAQ fait correspondre la séance d'une semaine à l'un de ces modèles quand cela ne coûte pas plus cher que la proposition (ou reste dans le budget) et que la durée respecte le plafond.
 */

export interface Bundle {
  kind: "plan" | "session";
  /** Clés des cinq plats (nom normalisé), dans l'ordre du lundi au vendredi. */
  keys: string[];
  minutes: number;
  /** Faux pour une semaine type (durée du planning) ; vrai pour une séance du foyer. */
  estimated: boolean;
  theme?: string;
  planId?: string;
  planSteps?: string[];
  steps?: ProposalStep[];
}

/** Semaines types du moteur et séances déjà faites par le foyer (menus validés avec un déroulé écrit). */
export async function loadBundles(db: Kysely<DB>, accountId: string, data: EngineData): Promise<Bundle[]> {
  const out: Bundle[] = [];
  for (const p of data.plans) {
    if (p.days.length < 5) continue;
    const names = p.days.slice(0, 5).map((day, i) => data.dishes.find((d) => d.id === p.ids[i])?.name ?? day);
    out.push({ kind: "plan", keys: names.map((n) => nameKey(n)), minutes: p.total, estimated: false, theme: p.theme, planId: p.id, planSteps: p.steps });
  }
  const menus = await db
    .selectFrom("meal_menus")
    .select(["id", "session_minutes"])
    .where("account_id", "=", accountId)
    .where("batch_week_id", "is", null)
    .where((eb) => eb.exists(eb.selectFrom("meal_menu_session_steps as s").select("s.id").whereRef("s.menu_id", "=", "meal_menus.id")))
    .orderBy("week_start", "desc")
    .limit(30)
    .execute();
  for (const m of menus) {
    const entries = await db.selectFrom("meal_menu_entries").select(["id", "slot", "dish_name"]).where("menu_id", "=", m.id).where("kind", "=", "dinner").where("slot", "<=", 5).orderBy("slot").execute();
    if (entries.length < 5) continue;
    const rows = await db.selectFrom("meal_menu_session_steps").selectAll().where("menu_id", "=", m.id).orderBy("position").execute();
    if (rows.length < 2) continue;
    const nameOf = new Map(entries.map((e) => [String(e.id), e.dish_name]));
    const steps: ProposalStep[] = rows.map((r) => ({
      position: r.position,
      text: r.body,
      dish: r.entry_id === null ? null : (nameOf.get(String(r.entry_id)) ?? null),
      minutes: r.duration_minutes,
      overlaps: r.overlaps_position,
      storage: r.storage_mode,
      takeOutDay: r.take_out_day,
    }));
    const minutes = m.session_minutes ?? minutesFromSteps(steps, 0);
    if (!minutes) continue;
    out.push({ kind: "session", keys: entries.map((e) => nameKey(e.dish_name)), minutes, estimated: true, steps });
  }
  return out;
}

/** Le modèle repris pour une semaine (rien quand aucun ne convient). */
export type WeekReuse = Bundle | null;

type Weeks = Solution["weeks"];
const cloneWeeks = (weeks: Weeks): Weeks => weeks.map((w) => ({ dinners: [...w.dinners], express: [...w.express] }));

/**
 * Met les cinq plats d'un modèle dans la séance de la semaine i. Un plat du modèle placé ailleurs dans le mois laisse sa place à un plat qui s'en va de la séance ou, à défaut, à un plat du réservoir encore inutilisé
 * (un plat express ne peut être remplacé que par un plat qui peut l'être) ; un plat du modèle encore inutilisé entre simplement. Toutes les affectations sont essayées (bornées) : la première qui respecte le plafond de
 * séance des autres semaines est gardée. Rend null quand ce n'est pas possible : séance d'une autre semaine déjà reprise, place express impossible, plafond dépassé.
 */
function placeBundle(base: Weeks, i: number, dishes: PoolDish[], pool: PoolDish[], reused: Set<number>, cap: number | null): Weeks | null {
  const next = cloneWeeks(base);
  const target = next[i];
  const keys = new Set(dishes.map((d) => d.key));
  const displaced = target.dinners.slice(0, 5).filter((d): d is PoolDish => !!d && !keys.has(d.key));
  type Slot = { list: (PoolDish | null)[]; index: number; express: boolean; week: number };
  const vacated: Slot[] = [];
  const changed = new Set<number>([i]);
  for (const d of dishes) {
    if (target.dinners.slice(0, 5).some((x) => x?.key === d.key)) continue;
    let slot: Slot | null = null;
    for (let j = 0; j < next.length && !slot; j++) {
      const w = next[j];
      const k = w.dinners.findIndex((x, n) => x?.key === d.key && !(j === i && n < 5));
      if (k >= 0) slot = { list: w.dinners, index: k, express: false, week: j };
      else {
        const e = w.express.findIndex((x) => x?.key === d.key);
        if (e >= 0) slot = { list: w.express, index: e, express: true, week: j };
      }
    }
    if (slot) {
      // la séance d'une autre semaine déjà reprise ne se défait pas
      if (reused.has(slot.week) && slot.week !== i && !slot.express && slot.index < 5) return null;
      vacated.push(slot);
      changed.add(slot.week);
    }
  }
  target.dinners.splice(0, 5, ...dishes);
  const inUse = new Set(next.flatMap((w) => [...w.dinners, ...w.express]).filter((d): d is PoolDish => !!d).map((d) => d.key));
  const candidates = [...displaced, ...pool.filter((d) => !inUse.has(d.key) && !keys.has(d.key) && !displaced.some((x) => x.key === d.key))];
  const capOk = (): boolean => {
    if (cap === null) return true;
    for (const j of changed) {
      if (j === i) continue;
      const first = next[j].dinners.slice(0, 5).filter((d): d is PoolDish => !!d);
      if (estimateMinutes(first) > cap + 1e-9) return false;
    }
    return true;
  };
  if (!vacated.length) return capOk() ? next : null;
  const taken = new Set<string>();
  let nodes = 0;
  const fill = (n: number): boolean => {
    if (n === vacated.length) return capOk();
    for (const c of candidates) {
      if (taken.has(c.key) || (vacated[n].express && !c.express)) continue;
      if (++nodes > 4000) return false;
      taken.add(c.key);
      vacated[n].list[vacated[n].index] = c;
      if (fill(n + 1)) return true;
      taken.delete(c.key);
    }
    return false;
  };
  return fill(0) ? next : null;
}

/**
 * Fait correspondre la séance (cinq premiers dîners) de chaque semaine à un modèle quand c'est possible : les cinq plats sont dans le réservoir, la durée du modèle tient dans le plafond, et le total reste dans le
 * budget ou ne dépasse pas celui de la proposition (+ 0,50 €). Une séance qui est déjà un modèle le reprend sans rien changer (en premier, pour toutes les semaines), puis les autres semaines essaient de
 * s'aligner sur un modèle en échangeant des plats avec le reste du mois. Rend la solution mise à jour et, par semaine, le modèle repris.
 */
export function applyBundles(solution: Solution, pool: PoolDish[], bundles: Bundle[], price: PriceFn, o: { budget: number | null; sessionCap: number | null }): { solution: Solution; reuse: WeekReuse[] } {
  const byKey = new Map(pool.map((d) => [d.key, d]));
  let weeks = cloneWeeks(solution.weeks);
  const reuse: WeekReuse[] = weeks.map(() => null);
  const reused = new Set<number>();
  const usable = bundles.filter((b) => b.keys.length === 5 && new Set(b.keys).size === 5 && (o.sessionCap === null || b.minutes <= o.sessionCap) && b.keys.every((k) => byKey.has(k)));
  const total = (w: Weeks) => costOf(w.flatMap((x) => [...x.dinners, ...x.express]).filter((d): d is PoolDish => !!d), price).total;
  const taken = new Set<Bundle>();

  const pass = (sameOnly: boolean) => {
    weeks.forEach((_, i) => {
      if (reuse[i]) return;
      const current = total(weeks);
      const firstKeys = new Set(weeks[i].dinners.slice(0, 5).map((d) => d?.key));
      const complete = weeks[i].dinners.slice(0, 5).every((d) => !!d);
      let best: { bundle: Bundle; weeks: Weeks; total: number; same: boolean } | null = null;
      for (const b of usable) {
        if (taken.has(b)) continue;
        const same = complete && b.keys.every((k) => firstKeys.has(k));
        if (sameOnly && !same) continue;
        const dishes = b.keys.map((k) => byKey.get(k)!);
        const next = same ? cloneWeeks(weeks) : placeBundle(weeks, i, dishes, pool, reused, o.sessionCap);
        if (!next) continue;
        if (same) next[i].dinners.splice(0, 5, ...dishes);
        const t = total(next);
        if (!same && !((o.budget !== null && t <= o.budget) || t <= current + 0.5)) continue;
        // à égalité de coût une semaine type passe avant une séance du foyer
        const better = !best || (same && !best.same) || (same === best.same && (t < best.total - 0.005 || (Math.abs(t - best.total) <= 0.005 && b.kind === "plan" && best.bundle.kind !== "plan")));
        if (better) best = { bundle: b, weeks: next, total: t, same };
      }
      if (best) {
        weeks = best.weeks;
        reuse[i] = best.bundle;
        reused.add(i);
        taken.add(best.bundle);
      }
    });
  };
  pass(true);
  pass(false);
  return { solution: summarize(weeks, price), reuse };
}
