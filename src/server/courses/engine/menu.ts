import { allowed, inSeason } from "./dishes";
import { DEFAULT_THRESHOLDS, linkPlans, type Thresholds } from "./matcher";
import { DAYS, intersect, norm, pyRound, tokens } from "./text";
import type { BatchInfo, Dish, LinkedPlan, MenuEntry, MenuState, Plan, Profile, SeasonRange } from "./types";

export interface MenuRequest {
  dishes: Dish[];
  plans: Plan[];
  profile: Profile;
  /** Identifiants des 1 ou 2 plats plaisir choisis. */
  picks: string[];
  /** Cuisines de la semaine ; vide = celles des réglages. */
  cuisines?: string[];
  days?: number;
  /** Objectifs de la demande ; à défaut, ceux des réglages. */
  objectives?: string;
  /** Viande demandée (étiquette : poulet, poisson…). */
  meat?: string | null;
  /** Lundi de la semaine préparée, « AAAA-MM-JJ ». */
  week: string;
  /** Plats servis récemment : nom et lundi de la semaine (historique des menus validés). */
  history: { week: string; dishName: string }[];
  /** Jour de la préparation (pour la répétition et la saison). */
  today: Date;
  seasons?: SeasonRange[];
  thresholds?: Thresholds;
  /** Durée maximale d'un plat express, en minutes (US-156 RF4). */
  expressMaxMinutes?: number;
  expressCount?: number;
}

/** Durée estimée d'une séance quand aucune semaine type ne convient : le plat le plus long, plus 40 % des autres (US-156 RF6). */
export function estimateMinutes(dishes: Pick<Dish, "minutes">[]): number {
  const m = dishes.map((d) => d.minutes).sort((a, b) => b - a);
  return m.length ? m[0] + 0.4 * m.slice(1).reduce((s, x) => s + x, 0) : 0;
}

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Lundi qui suit `today` (le lundi suivant, jamais aujourd'hui). */
export function nextMonday(today: Date): string {
  const d = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const weekday = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() + 7 - weekday);
  return isoDate(d);
}

/**
 * Propose le menu de la semaine (US-156) : 7 dîners d'abord appuyés sur une semaine type de batch (US-170), sinon composés par ingrédients,
 * 4 plats express, jusqu'à 4 remplacements par plat. Reprend la logique de cmd_menu de courses.py ; écart voulu : les plats express
 * sont limités à `expressMaxMinutes` (15 par défaut, US-156 RF4).
 */
export function proposeMenu(req: MenuRequest): MenuState {
  const { dishes, profile } = req;
  const days = req.days ?? 7;
  const seasons = req.seasons;
  const byId = new Map(dishes.map((d) => [d.id, d]));
  const picks = req.picks.map((id) => byId.get(id)).filter((d): d is Dish => !!d);
  if (!picks.length) throw new Error("picks_not_found");
  const pickIds = new Set(picks.map((d) => d.id));
  const objs = norm(req.objectives ?? profile.objectives);
  const month = req.today.getMonth() + 1;
  const cutoff = isoDate(new Date(req.today.getFullYear(), req.today.getMonth(), req.today.getDate() - 7 * profile.repetitionWeeks));
  const recent = new Set(req.history.filter((h) => h.week >= cutoff).map((h) => norm(h.dishName)));
  const picksNotMine = picks.filter((d) => !d.mine);
  const univ = new Set(picksNotMine.map((d) => d.cuisine));
  if (!univ.size) univ.add("Français");
  const base = tokens(picks.map((d) => d.ing).join(" "));
  const ok = dishes.filter((d) => (allowed(d, profile, req.meat) && !recent.has(norm(d.name))) || pickIds.has(d.id));
  const cap = profile.batchMaxMinutes || 120;

  const score = (d: Dish, ref?: Set<string>): number => {
    const t = tokens(d.ing);
    let s = intersect(t, ref && ref.size ? ref : base).size / Math.max(t.size, 1);
    if (objs.includes("mes") && d.mine) s += 0.4;
    if (objs.includes("saison")) {
      const x = inSeason(d.ing, month, seasons);
      s += 0.1 * x.inSeason - 0.4 * x.outOfSeason;
    }
    if (objs.includes("temps")) s -= d.minutes / 300;
    return s;
  };
  const byScore = (list: Dish[], ref?: Set<string>): Dish[] => {
    const scored = list.map((d) => ({ d, s: score(d, ref) }));
    return scored.sort((a, b) => b.s - a.s).map((x) => x.d);
  };

  // 1. semaine type qui contient les plats choisis ou partage leurs ingrédients
  const asked = (req.cuisines && req.cuisines.length ? req.cuisines : profile.preferredCuisines).map(norm);
  const cuis = new Set<string>(asked.length ? [...asked, ...picksNotMine.map((d) => norm(d.cuisine))] : []);
  const inCuisines = (d: Dish) => !cuis.size || cuis.has(norm(d.cuisine)) || !!d.mine;

  let best: { sc: number; total: number; plan: LinkedPlan; pds: Dish[] } | null = null;
  let blocked = 0;
  for (const plan of linkPlans(req.plans, dishes, req.thresholds ?? DEFAULT_THRESHOLDS)) {
    if (cuis.size && !cuis.has(norm(plan.cuisine))) continue;
    if (objs.includes("temps") && plan.total > cap) continue;
    if (plan.match.some((m) => m[1] === "absent")) {
      blocked += 1;
      continue;
    }
    const pds = plan.match.map((m) => byId.get((m[0] ?? m[3]) as string)).filter((d): d is Dish => !!d);
    if (pds.length !== plan.match.length || new Set(pds.map((d) => d.id)).size < 5) continue;
    if (!pds.every((d) => allowed(d, profile, req.meat)) || pds.some((d) => recent.has(norm(d.name)) && !pickIds.has(d.id))) continue;
    const sure = new Set(plan.match.filter((m) => m[0]).map((m) => m[0] as string));
    const inPlan = [...pickIds].filter((id) => sure.has(id)).length;
    const nConfirm = plan.match.filter((m) => m[1] === "confirmer").length;
    const overlap = pds.reduce((s, d) => s + intersect(tokens(d.ing), base).size / Math.max(tokens(d.ing).size, 1), 0) / 5;
    const sc = 10 * inPlan + overlap - 0.5 * nConfirm;
    // à score égal, la séance la plus courte (comparaison (score, -durée) de courses.py)
    const better = !best || sc > best.sc || (sc === best.sc && plan.total < best.total);
    if ((inPlan || overlap >= 0.2) && better) best = { sc, total: plan.total, plan, pds };
  }

  let menu: Dish[];
  let batch: BatchInfo;
  let inBatch = new Set<string>();
  const confirmNames = new Map<string, string>();
  if (best) {
    const { plan, pds } = best;
    plan.match.forEach((m, j) => {
      if (m[1] === "confirmer" && m[3]) confirmNames.set(m[3], plan.days[j]);
    });
    const pdsIds = new Set(pds.map((d) => d.id));
    const rest = picks.filter((d) => !pdsIds.has(d.id));
    const restIds = new Set(rest.map((d) => d.id));
    const pdsCuisines = new Set(pds.map((d) => d.cuisine));
    const pool = ok.filter((d) => (univ.has(d.cuisine) || pdsCuisines.has(d.cuisine) || d.mine) && !pdsIds.has(d.id) && !restIds.has(d.id));
    menu = [...pds, ...rest, ...byScore(pool)].slice(0, Math.max(days, 1)).slice(0, days);
    inBatch = pdsIds;
    batch = { source: "planning", id: plan.id, theme: plan.theme, cuisine: plan.cuisine, total: plan.total, pct: plan.pct, steps: plan.steps, cap, confirm: confirmNames.size };
  } else {
    // 2. aucune semaine type adaptée : calcul par ingrédients, durée de séance estimée
    const pool = ok.filter((d) => (univ.has(d.cuisine) || d.mine) && !pickIds.has(d.id));
    menu = [...picks, ...byScore(pool).slice(0, Math.max(days - picks.length, 0))].slice(0, days);
    let est = estimateMinutes(menu.slice(0, 5));
    if (objs.includes("temps")) {
      for (let i = 0; i < 10; i += 1) {
        if (est <= cap) break;
        const longer = menu.slice(0, 5).filter((d) => !pickIds.has(d.id)).sort((a, b) => b.minutes - a.minutes);
        if (!longer.length) break;
        const alts = pool.filter((d) => !menu.includes(d) && d.minutes < longer[0].minutes);
        if (!alts.length) break;
        let top = alts[0];
        for (const d of alts) if (score(d) > score(top)) top = d;
        menu[menu.indexOf(longer[0])] = top;
        est = estimateMinutes(menu.slice(0, 5));
      }
    }
    batch = { source: "estimation", total: pyRound(est), cap, steps: [] };
  }

  const expressMax = req.expressMaxMinutes ?? 15;
  const expressCount = req.expressCount ?? 4;
  const inMenu = new Set(menu.map((d) => d.id));
  const quickPool = ok
    .filter((d) => !inMenu.has(d.id) && inCuisines(d) && d.minutes <= expressMax)
    .map((d) => ({ d, n: tokens(d.ing).size }))
    .sort((a, b) => a.d.minutes - b.d.minutes || a.n - b.n)
    .map((x) => x.d);
  const quick = quickPool.slice(0, expressCount);
  const quickIds = new Set(quick.map((d) => d.id));

  const sources = profile.replacementSource.map(norm).filter((x) => x);
  const src = sources.length ? sources : ["mes plats", ...[...univ].map(norm)];
  const alternatives = (d: Dish): string[] => {
    const c = ok.filter((x) => !inMenu.has(x.id) && x.id !== d.id && !quickIds.has(x.id) && inCuisines(x));
    const preferred = c.filter((x) => src.includes(norm(x.cuisine)) || (x.mine && src.includes("mes plats")));
    return byScore(preferred.length ? preferred : c, tokens(d.ing)).slice(0, 4).map((x) => x.id);
  };

  const entries: MenuEntry[] = menu.map((d, i) => ({
    day: DAYS[i % 7],
    id: d.id,
    alts: alternatives(d),
    batch: inBatch.has(d.id),
    confirm: inBatch.has(d.id) ? (confirmNames.get(d.id) ?? "") : "",
  }));
  return { week: req.week, batch, menu: entries, express: quick.map((d) => d.id), expressShort: quick.length < expressCount, blockedPlans: blocked };
}
