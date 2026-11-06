import { norm } from "./text";
import type { Dish, LinkedPlan, MatchStatus, Plan, PlanMatch } from "./types";

export interface Thresholds {
  /** À partir de ce score, la correspondance est sûre. */
  sure: number;
  /** À partir de ce score, elle est « à confirmer » ; en dessous, le plat est absent du catalogue. */
  confirm: number;
}
/** Seuils de départ (US-171 RF1) : réglages de la console. */
export const DEFAULT_THRESHOLDS: Thresholds = { sure: 0.8, confirm: 0.4 };

const STOPN = new Set(["avec", "pour", "dans", "sans", "aux", "les", "des", "une", "fraiche", "fraiches"]);

function nameTokens(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of norm(text).match(/[a-z]+/g) ?? []) {
    if (w.length >= 3 && !STOPN.has(w)) out.add(w.endsWith("s") ? w.slice(0, -1) : w);
  }
  return out;
}

/** Compare un nom de plat aux plats du catalogue. Un mot rare (« haricots ») pèse plus qu'un mot courant (« sauce »). */
export class Matcher {
  private readonly toks = new Map<string, Set<string>>();
  private readonly df = new Map<string, number>();

  constructor(
    private readonly catalog: Pick<Dish, "id" | "name">[],
    private readonly thresholds: Thresholds = DEFAULT_THRESHOLDS,
  ) {
    for (const d of catalog) {
      const t = nameTokens(d.name);
      this.toks.set(d.id, t);
      for (const w of t) this.df.set(w, (this.df.get(w) ?? 0) + 1);
    }
  }

  private weight(word: string): number {
    return Math.log((this.catalog.length + 1) / ((this.df.get(word) ?? 0) + 1)) + 0.5;
  }

  score(name: string, dishId: string): number {
    const a = nameTokens(name);
    const b = this.toks.get(dishId) ?? new Set<string>();
    const common = [...a].filter((w) => b.has(w));
    if (common.length < 2 && !(a.size === 1 && b.size === 1)) return 0;
    const wi = common.reduce((s, w) => s + this.weight(w), 0);
    const wa = [...a].reduce((s, w) => s + this.weight(w), 0);
    const wb = [...b].reduce((s, w) => s + this.weight(w), 0);
    return Number(Math.sqrt((wi / wa) * (wi / wb)).toFixed(2));
  }

  /** Les k plats les plus proches : score décroissant, puis identifiant décroissant (ordre de courses.py). */
  top(name: string, k = 3): { score: number; id: string }[] {
    return this.catalog
      .map((d) => ({ score: this.score(name, d.id), id: d.id }))
      .sort((x, y) => (y.score !== x.score ? y.score - x.score : x.id < y.id ? 1 : x.id > y.id ? -1 : 0))
      .slice(0, k);
  }

  status(score: number): MatchStatus {
    return score >= this.thresholds.sure ? "ok" : score >= this.thresholds.confirm ? "confirmer" : "absent";
  }
}

/** Pour chaque jour d'une semaine type : plat sûr (ou null), statut, score, meilleur candidat (US-171). */
export function linkPlans(plans: Plan[], dishes: Dish[], thresholds: Thresholds = DEFAULT_THRESHOLDS): LinkedPlan[] {
  const catalog = dishes.filter((d) => !d.mine);
  const known = new Set(catalog.map((d) => d.id));
  const matcher = new Matcher(catalog, thresholds);
  return plans.map((plan) => {
    const match: PlanMatch[] = plan.days.map((name, i) => {
      const exact = plan.ids[i] && known.has(plan.ids[i]) ? plan.ids[i] : null;
      if (exact) return [exact, "ok", 1, exact];
      const best = catalog.length ? matcher.top(name, 1)[0] : { score: 0, id: null as string | null };
      const status = matcher.status(best.score);
      return [status === "ok" ? best.id : null, status, best.score, best.score > 0 ? best.id : null];
    });
    return { ...plan, match };
  });
}
