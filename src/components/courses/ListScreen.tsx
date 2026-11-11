"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import family from "@/components/family/family.module.css";
import { Button, ButtonLink, Loading, Notice, RetryNotice } from "@/components/ui";
import { AGE_LABEL, comparatif, computeScenarios, formatQuantity, isReplaced, norm, scenarioLines, selectedChoice, type DishMode, type ListItem, type ListSelection, type Scenario, type ScenarioLine } from "@/server/courses/engine";
import { fromDto } from "@/server/courses/list/dto";
import type { AddedLine, ListPrepared, ValidateLine } from "@/server/courses/list/service";
import { BatchSession, RecipeList } from "./MenuRecipes";
import { DeleteWeek, WeekSelector, groupFromLocation, weekFromLocation } from "./WeekTools";
import styles from "./courses.module.css";

const BACK = { href: "/courses", label: "Courses et repas" };

export const euro = (value: number) => `${value.toFixed(2).replace(".", ",")} €`;
/** « 1,49 €/kg » : prix au kilo ou au litre. */
export const euroPer = (value: number, unit: "kg" | "l" | "unit") => `${euro(value)}${unit === "unit" ? "" : unit === "kg" ? "/kg" : "/L"}`;
/** « 9 nov. » : le lundi de la semaine d'origine d'un rappel. */
const shortDay = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
const priceText = (value: number | null) => (value === null ? "N/A" : euro(value));

/** « Liste de courses » (US-157, US-158) : préparation après la validation du menu, comparatif des prix, trois scénarios d'achat, validation. */
export function CoursesListScreen() {
  // semaine affichée (CR-54) : celle de l'adresse (?week=), sinon celle que choisit le serveur (en cours, puis suivante)
  const [week, setWeek] = useState<string | null>(weekFromLocation);
  // liste du mois (CR-56) : les semaines regroupées, ou aucune
  const [group, setGroup] = useState<string[] | null>(groupFromLocation);
  const query = useApiQuery<{ list: ListPrepared }>(group ? `/api/courses/list?group=${group.join(",")}` : `/api/courses/list${week ? `?week=${week}` : ""}`);
  const forbidden = query.error?.body?.code === "forbidden";
  return (
    <AppShell title="Liste de courses" eyebrow="Courses et repas" back={BACK}>
      {query.loading && !query.data && <Loading slow={query.slow} />}
      {forbidden && <Notice tone="info">La liste de courses n&apos;est pas disponible pour ce profil.</Notice>}
      {query.error && !forbidden && <RetryNotice message={query.error.message} onRetry={query.reload} />}
      {query.data && <ListFlow key={`${query.data.list.week ?? "none"}|${query.data.list.group?.weeks.join(",") ?? ""}`} list={query.data.list} reload={query.reload} onWeek={(w) => { setGroup(null); setWeek(w); }} onGroup={setGroup} />}
    </AppShell>
  );
}

/** Le sélecteur de semaine apparaît quand les deux semaines ont un menu (CR-54) ; la semaine en cours est celle de départ. */
function Weeks({ list, onWeek }: { list: ListPrepared; onWeek: (week: string) => void }) {
  // les semaines qui ont un menu (ou une liste), plus celle qui est affichée (CR-56)
  const shown = list.weeks.filter((w) => w.hasMenu || w.hasList || w.week === list.week);
  return list.access === "couple" && shown.length > 1 ? <WeekSelector weeks={shown} week={list.week} onChange={onWeek} /> : null;
}

/** « Regrouper en une liste » (CR-56) : quand au moins deux semaines ont un menu validé, on choisit les semaines à regrouper (cases à cocher, semaines datées). */
function GroupPicker({ list, onGroup }: { list: ListPrepared; onGroup: (weeks: string[]) => void }) {
  const withMenu = list.weeks.filter((w) => w.hasMenu);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>(() => withMenu.slice(0, 2).map((w) => w.week));
  if (list.access !== "couple" || withMenu.length < 2) return null;
  if (!open) {
    return (
      <div className={styles.tools}>
        <Button variant="ghost" onClick={() => setOpen(true)}>
          Regrouper en une liste
        </Button>
      </div>
    );
  }
  return (
    <section className={styles.dayCard} aria-label="Regrouper en une liste">
      <div className={styles.dayHead}>
        <span className={styles.dayName}>Liste du mois</span>
        <button type="button" className={styles.link} onClick={() => setOpen(false)}>
          Fermer
        </button>
      </div>
      <p className={family.hint}>Les besoins de chaque produit sont additionnés sur les semaines choisies, arrondis au paquet supérieur sur le total. Les produits frais des semaines suivantes sont à acheter plus tard.</p>
      {withMenu.map((w) => (
        <label key={w.week} className={styles.choice}>
          <input type="checkbox" checked={picked.includes(w.week)} onChange={(e) => setPicked(e.target.checked ? [...picked, w.week] : picked.filter((x) => x !== w.week))} />
          <span>Semaine {w.range}{w.hasList ? " · liste validée" : ""}</span>
        </label>
      ))}
      <Button disabled={picked.length < 2} onClick={() => onGroup([...picked].sort())}>
        Regrouper {picked.length >= 2 ? `ces ${picked.length} semaines` : "(choisissez 2 semaines)"}
      </Button>
    </section>
  );
}

export function ListFlow({ list, reload, onWeek, onGroup }: { list: ListPrepared; reload: () => void; onWeek: (week: string) => void; onGroup: (weeks: string[] | null) => void }) {
  if (list.access === "list") return <GuestView list={list} reload={reload} />;
  if (!list.menu || !list.model) {
    return (
      <>
        <Weeks list={list} onWeek={onWeek} />
        <p className={styles.empty}>
          Aucune liste à préparer pour l&apos;instant. <Link href="/courses?menu=1">Préparer le menu ›</Link>
        </p>
      </>
    );
  }
  return (
    <>
      {list.group ? (
        <div className={styles.tools}>
          <span className={family.hint}>Liste du mois · semaines du {list.group.weeks.map((w) => list.weeks.find((x) => x.week === w)?.range.replace(/^du /, "") ?? w).join(" · ")}</span>
          <button type="button" className={styles.link} onClick={() => onGroup(null)}>
            Quitter la liste du mois
          </button>
        </div>
      ) : (
        <>
          <Weeks list={list} onWeek={onWeek} />
          <GroupPicker list={list} onGroup={onGroup} />
        </>
      )}
      <Preparation list={list} reload={reload} />
    </>
  );
}

/** Invité secondaire : il ajoute un produit et retire les siens, rien d'autre (CR-10). */
function GuestView({ list, reload }: { list: ListPrepared; reload: () => void }) {
  return (
    <>
      <p className={styles.note}>
        La liste validée est dans <Link href="/courses/ma-liste">Ma liste de courses</Link>. Ici, vous pouvez ajouter un produit et retirer vos propres ajouts.
      </p>
      <AddedSection added={list.added} access={list.access} week={list.week} reload={reload} />
    </>
  );
}

function Rub({ title, open = false, children }: { title: string; open?: boolean; children: ReactNode }) {
  return (
    <details className={styles.rub} open={open}>
      <summary>{title}</summary>
      <div className={styles.rubBody}>{children}</div>
    </details>
  );
}

function AddedSection({ added, access, week, reload }: { added: AddedLine[]; access: "couple" | "list"; week: string | null; reload: () => void }) {
  const add = useApiMutation();
  const remove = useApiMutation();
  const [text, setText] = useState("");
  const [message, setMessage] = useState("");

  async function submit() {
    if (!text.trim()) return;
    const result = await add.run<{ duplicate: { name: string; quantity: number } | null }>("/api/courses/list/products", { method: "POST", body: { name: text.trim(), week: week ?? undefined } });
    if (!result) return;
    setMessage(result.duplicate ? `${result.duplicate.name} est déjà dans la liste : quantité ${result.duplicate.quantity}.` : "");
    setText("");
    reload();
  }
  async function drop(key: string, lineWeek?: string | null) {
    if (await remove.run("/api/courses/list/products", { method: "DELETE", body: { key, week: lineWeek ?? week ?? undefined } })) reload();
  }

  return (
    <Rub title="Produits ajoutés" open>
      {added.length === 0 && <p className={styles.empty}>Aucun produit ajouté.</p>}
      {added.map((a) => (
        <div key={a.key} className={styles.line}>
          <div className={styles.lineMain}>
            <div className={styles.lineName}>{a.name}</div>
            <div className={styles.lineSub}>
              {a.by ? `ajouté par ${a.by}` : "ajouté"}
            </div>
          </div>
          <span className={styles.meta}>×{a.qty}</span>
          {(access === "couple" || a.mine) && (
            <button type="button" className={styles.link} onClick={() => void drop(a.key, a.week)} aria-label={`Retirer ${a.name}`}>
              Retirer
            </button>
          )}
        </div>
      ))}
      <div className={styles.addRow}>
        <input id="cr-add" className={family.input} placeholder="Ajouter un produit" aria-label="Ajouter un produit" value={text} maxLength={120} onChange={(e) => { setText(e.target.value); setMessage(""); }} onKeyDown={(e) => e.key === "Enter" && void submit()} />
        <Button variant="ghost" onClick={() => void submit()} loading={add.pending}>
          + Ajouter
        </Button>
      </div>
      {message && <p className={family.hint}>{message}</p>}
      {(add.error || remove.error) && <Notice tone="error">{(add.error ?? remove.error)!.message}</Notice>}
    </Rub>
  );
}

/** Ce que le foyer a choisi à l'écran, rangé par nom de produit (les numéros de ligne changent quand la liste se recharge). */
interface Picks {
  checked: Record<string, boolean>;
  selected: Record<string, number | null>;
  qty: Record<string, number>;
  removed: Record<string, boolean>;
  modes: Record<string, DishMode>;
  applied: boolean;
}

function selectionOf(items: ListItem[], picks: Picks): ListSelection {
  const sel: ListSelection = { checked: new Map(), selected: new Map(), qty: new Map(), deleted: new Set(), modes: new Map(Object.entries(picks.modes)), applied: picks.applied };
  for (const i of items) {
    const k = norm(i.name);
    if (k in picks.checked) sel.checked!.set(i.id, picks.checked[k]);
    if (k in picks.selected) sel.selected!.set(i.id, picks.selected[k]);
    if (k in picks.qty) sel.qty!.set(i.id, picks.qty[k]);
    if (picks.removed[k]) sel.deleted!.add(i.id);
  }
  return sel;
}

function Preparation({ list, reload }: { list: ListPrepared; reload: () => void }) {
  const model = useMemo(() => fromDto(list.model!), [list.model]);
  const [picks, setPicks] = useState<Picks>({ checked: {}, selected: {}, qty: {}, removed: {}, modes: list.modes, applied: Object.keys(list.modes).length > 0 });
  const [view, setView] = useState<null | 1 | 2 | 3>(null);
  const [opened, setOpened] = useState({ all: false, key: 0 });
  const [done, setDone] = useState(false);
  const sel = useMemo(() => selectionOf(model.items, picks), [model, picks]);
  const chains = useMemo(() => [...new Set(list.stores.map((s) => s.chain))], [list.stores]);
  const scenarios = useMemo(() => computeScenarios(model, sel, chains), [model, sel, chains]);
  const save = useApiMutation();
  const validate = useApiMutation();

  const patch = (change: Partial<Picks>) => setPicks((p) => ({ ...p, ...change }));
  const rub = (title: string, open: boolean, children: ReactNode) => (
    <Rub key={`${title}-${opened.key}`} title={title} open={open || opened.all}>
      {children}
    </Rub>
  );

  if (done) return <Done group={list.group} />;

  if (view) {
    const scenario = scenarios.find((s) => s.id === view)!;
    return (
      <ScenarioView
        scenario={scenario}
        lines={scenarioLines(model, sel, scenario)}
        stores={list.stores}
        picks={picks}
        onQty={(name, qty) => patch({ qty: { ...picks.qty, [norm(name)]: qty } })}
        onRemoved={(name, removed) => patch({ removed: { ...picks.removed, [norm(name)]: removed } })}
        onPantry={(name, ticked) => patch({ checked: { ...picks.checked, [norm(name)]: ticked } })}
        onBack={() => setView(null)}
        month={!!list.group}
        pending={validate.pending}
        error={validate.error?.message}
        onValidate={async (lines) => {
          const result = await validate.run("/api/courses/list/validate", { method: "POST", body: list.group ? { scenario: view, lines, weeks: list.group.weeks } : { scenario: view, lines, week: list.week ?? undefined } });
          if (result) setDone(true);
        }}
        itemsByName={new Map(model.items.map((i) => [norm(i.name), i]))}
      />
    );
  }

  const menuItems = model.items.filter((i) => i.group === "menu" || i.group === "sante");
  const habit = model.items.filter((i) => i.group === "habituel");
  const compared = comparatif(model, sel);
  const summary = list.menu!;
  const byRayon = (list: ListItem[]) => [...list.reduce((m, i) => m.set(i.rayon, [...(m.get(i.rayon) ?? []), i]), new Map<string, ListItem[]>())];
  const habitByRayon = byRayon(habit);
  // « Pensez aussi à : » : produits du quotidien de la console, quand l'historique est court (CR-66)
  const dailyByRayon = byRayon(model.items.filter((i) => i.group === "quotidien"));

  async function apply() {
    patch({ applied: true });
    await save.run("/api/courses/list/modes", { method: "PUT", body: { modes: picks.modes, week: list.week ?? undefined } });
  }

  return (
    <>
      {!list.group && <p className={family.hint}>Semaine du {summary.weekLabel}</p>}
      {!list.group && list.access === "couple" && list.week && <DeleteWeek week={list.week} weekText={`de la semaine ${list.weeks.find((w) => w.week === list.week)?.range ?? ""}`} hasList={!!list.weeks.find((w) => w.week === list.week)?.hasList} onDone={reload} />}
      <div className={styles.tools}>
        <Button variant="ghost" onClick={() => setOpened({ all: true, key: opened.key + 1 })}>
          Tout déplier
        </Button>
      </div>

      {!list.group && rub("Menu validé et recettes", false, <RecipeList recipes={summary.recipes.filter((r) => r.kind === "dinner")} servings={summary.servings} title="Menu de la semaine : recettes" showDays />)}
      {!list.group && rub("Séance de batch", false, <BatchSession summary={summary} onWritten={reload} />)}
      {!list.group && rub("Plats express", false, <RecipeList recipes={summary.recipes.filter((r) => r.kind === "express")} servings={summary.servings} title="Plats express : recettes" showDays={false} />)}

      {!list.group && rub("Version standard ou allégée", true, (
        <>
          {model.dishes.map((d) => {
            const mode = picks.modes[d.name] ?? "standard";
            return (
              <div key={d.dishId} className={styles.dayCard}>
                <div className={styles.lineName}>{d.name}</div>
                {d.text && <span className={styles.meta}>{/^version/i.test(d.text) ? d.text : `Version allégée : ${d.text}`}</span>}
                <div className={family.wrapRow}>
                  {(["standard", "light"] as const).map((m) => (
                    <button key={m} type="button" className={family.chipToggle} aria-pressed={mode === m} onClick={() => patch({ modes: { ...picks.modes, [d.name]: m } })}>
                      {m === "standard" ? "Version standard" : "Version allégée"}
                    </button>
                  ))}
                </div>
                <span className={styles.meta}>
                  {d.hasAdaptation
                    ? `${d.removeNames.length ? `Retire ${d.removeNames.join(", ")}` : ""}${d.removeNames.length && d.addNames.length ? " ; " : ""}${d.addNames.length ? `ajoute ${d.addNames.join(", ")}` : ""}.`
                    : "Pas d'adaptation automatique de la liste pour ce plat (conseil de préparation seulement)."}
                </span>
              </div>
            );
          })}
          <Button variant="ghost" onClick={() => void apply()} loading={save.pending}>
            Actualiser la liste
          </Button>
          <p className={family.hint}>« Actualiser » applique les versions allégées à la liste.</p>
          {save.error && <Notice tone="error">{save.error.message}</Notice>}
        </>
      ))}

      {!list.group && rub("Ingrédients du menu", false, (
        <>
          <p className={family.hint}>Pour information : ce que demandent les plats de la semaine.</p>
          {menuItems.map((i) => {
            const replaced = isReplaced(i, model, sel);
            return (
              <div key={i.id} className={styles.line}>
                <div className={styles.lineMain}>
                  <div className={`${styles.lineName} ${replaced ? styles.struck : ""}`}>{i.name}</div>
                  <div className={styles.lineSub}>{replaced ? "remplacé par la version allégée" : i.group === "sante" ? "version allégée" : `${i.pour.join(", ")} · ${i.rayon}`}</div>
                </div>
              </div>
            );
          })}
        </>
      ))}

      <AddedSection added={list.added} access={list.access} week={list.week} reload={reload} />

      {list.group && list.group.later.length > 0 && rub("À acheter plus tard", true, (
        <>
          <p className={family.hint}>Produits frais des semaines suivantes : décochés et hors du total, à acheter la semaine venue.</p>
          {list.group.later.map((l) => (
            <div key={l.week} className={styles.dayCard}>
              <div className={styles.dayHead}>
                <span className={styles.dayName}>À acheter plus tard ({l.label})</span>
                <span className={styles.meta}>{l.subtotal !== null ? `sous-total estimé ${euro(l.subtotal)}` : "sans prix connu"}</span>
              </div>
              <span className={styles.meta}>{l.names.join(" · ")}</span>
            </div>
          ))}
        </>
      ))}

      {rub("Produits de mon historique", true, (
        <>
          <p className={family.hint}>Achetés ces 3 derniers mois, en plus des repas. Cochez ce qu&apos;il vous faut cette semaine : le produit entre dans les scénarios.</p>
          {habit.length === 0 && <p className={styles.empty}>Rien pour l&apos;instant : les produits achetés en plus des repas (tickets, cases cochées en magasin) apparaissent ici.</p>}
          {habitByRayon.map(([rayon, items]) => (
            <div key={rayon}>
              <h3 className={styles.kick}>{rayon}</h3>
              {items.map((i) => (
                <label key={i.id} className={styles.choice}>
                  <input type="checkbox" checked={sel.checked?.get(i.id) ?? i.checked} onChange={(e) => patch({ checked: { ...picks.checked, [norm(i.name)]: e.target.checked } })} />
                  <span>
                    {i.name}
                    {i.leftoverWeek && <span className={styles.pillWarn}> Pas encore acheté (semaine du {shortDay(i.leftoverWeek)})</span>}
                  </span>
                </label>
              ))}
            </div>
          ))}
          {dailyByRayon.length > 0 && (
            <>
              <h3 className={styles.kick} style={{ marginTop: 12 }}>Votre historique est encore court. Pensez aussi à :</h3>
              <p className={family.hint}>Des produits courants, décochés : cochez ceux qu&apos;il vous faut.</p>
              {dailyByRayon.map(([rayon, items]) => (
                <div key={`q-${rayon}`}>
                  <h3 className={styles.kick}>{rayon}</h3>
                  {items.map((i) => (
                    <label key={i.id} className={styles.choice}>
                      <input type="checkbox" checked={sel.checked?.get(i.id) ?? i.checked} onChange={(e) => patch({ checked: { ...picks.checked, [norm(i.name)]: e.target.checked } })} />
                      <span>
                        {i.name}
                        {i.choices.every((ch) => ch.price === null) && <span className={styles.meta}> · N/A · hors total</span>}
                      </span>
                    </label>
                  ))}
                </div>
              ))}
            </>
          )}
        </>
      ))}

      {/* toujours affichée, entre « Produits de mon historique » et « Comparatif des prix » ; la même liste pour tous les foyers, sans produit ni référence ni enseigne (US-157 RF1quater, US-167 RF1, CR-65) */}
      {rub("Ingrédients / additifs exclus des références proposées", false, (
        <>
          {list.criteria.length === 0 ? (
            <p className={styles.empty}>Aucun additif exclu pour le moment.</p>
          ) : (
            <>
              <p className={styles.note}>MAAQ ne vous propose aucune référence qui contient l&apos;un de ces additifs.</p>
              {list.criteria.map((c) => (
                <p key={c.label} style={{ margin: "0 0 6px" }}>
                  {c.label} — {c.reason}
                </p>
              ))}
            </>
          )}
        </>
      ))}

      {rub("Comparatif des prix", true, (
        <>
          {!list.sharing && (
            <p className={styles.note}>
              Partagez anonymement vos prix dans les <Link href="/courses/reglages">réglages</Link> pour voir où un produit est moins cher près de chez vous.
            </p>
          )}
          <p className={family.hint}>Seulement les produits qui ont au moins 2 choix. Le moins cher est coché ; cochez-en un autre, ou aucun. Un produit à un seul choix le garde d&apos;office.</p>
          {compared.length === 0 && <p className={styles.empty}>Aucun produit n&apos;a deux choix pour l&apos;instant.</p>}
          {compared.map((i) => {
            const chosen = selectedChoice(i, sel);
            return (
              <div key={i.id} className={styles.dayCard}>
                <div className={styles.lineName}>{i.name}</div>
                {i.choices.map((c, k) => {
                  const label = c.kind === "reference" ? "Référence proposée" : c.kind === "history" ? "Dernier acheté" : "Moins cher ailleurs";
                  const on = chosen === c;
                  return (
                    <label key={`${c.kind}-${k}`} className={styles.choice}>
                      <input type="checkbox" role="checkbox" checked={on} onChange={() => patch({ selected: { ...picks.selected, [norm(i.name)]: on ? null : k } })} />
                      <span>
                        {label} · {c.ref}{c.format ? ` (${c.format})` : ""} · {c.price !== null && c.priceUnit && c.priceUnit !== "unit" ? euroPer(c.price, c.priceUnit) : priceText(c.price)}{c.perUnit && (!c.priceUnit || c.priceUnit === "unit") ? ` (${euroPer(c.perUnit.value, c.perUnit.unit)})` : ""} — {c.store}
                        {c.city ? `, ${c.city}` : ""}
                        {AGE_LABEL[c.age] ? ` — ${AGE_LABEL[c.age]}` : ""}
                        {c.labelCheck && <span className={styles.meta}> · Composition à vérifier sur l&apos;étiquette</span>}
                      </span>
                    </label>
                  );
                })}
                {chosen === null && <span className={styles.confirm}>Aucun choix coché : le produit reste dans les scénarios, sans prix (N/A).</span>}
              </div>
            );
          })}
        </>
      ))}

      {rub("Scénarios d'achat", true, (
        <>
          <p className={family.hint}>Recalculés à chaque choix, chaque produit coché et chaque quantité. Choisissez-en un pour voir et ajuster la liste.</p>
          {scenarios.map((s) => (
            <button key={s.id} type="button" className={styles.scenarioCard} onClick={() => setView(s.id)}>
              <span>
                <div className={styles.lineName}>{scenarioTitle(s)}</div>
                <div className={styles.lineSub}>
                  {s.withoutPrice === 0 ? "Tous les produits ont un prix" : `${s.withoutPrice} produit${s.withoutPrice > 1 ? "s" : ""} sans prix`}
                  {s.notTotaled > 0 ? ` · ${s.notTotaled} au kilo, non totalisé${s.notTotaled > 1 ? "s" : ""}` : ""}
                </div>
              </span>
              <span className={styles.scenarioTotal}>{euro(s.total)} ›</span>
            </button>
          ))}
          <p className={family.hint}>
            Montants estimés : les quantités viennent des recettes écrites pour {list.menu?.servings ?? list.householdSize ?? 4} personnes, additionnées par produit et arrondies au paquet supérieur ; un produit au poids compte son poids × son prix au kilo. Les produits « placard » (sel, huile, épices…) sont décochés au départ. Un prix inconnu affiche N/A.
          </p>
        </>
      ))}
    </>
  );
}

function scenarioTitle(s: Scenario): string {
  if (s.id === 1) return `1. Tout chez ${s.store ?? "un magasin"}, le magasin qui couvre le plus de produits`;
  if (s.id === 2) return "2. Chaque référence choisie dans son magasin";
  return "3. Mes produits habituels dans mes magasins";
}

function ScenarioView({
  scenario,
  lines,
  stores,
  picks,
  itemsByName,
  onQty,
  onRemoved,
  onPantry,
  onBack,
  onValidate,
  month,
  pending,
  error,
}: {
  scenario: Scenario;
  lines: ScenarioLine[];
  stores: { chain: string; city: string }[];
  picks: Picks;
  itemsByName: Map<string, ListItem>;
  onQty: (name: string, qty: number) => void;
  onRemoved: (name: string, removed: boolean) => void;
  /** Coche ou décoche un produit « placard » (décoché au départ, hors du total tant qu'il n'est pas coché). */
  onPantry: (name: string, ticked: boolean) => void;
  onBack: () => void;
  onValidate: (lines: ValidateLine[]) => Promise<void>;
  /** Liste du mois : « Valider la liste du mois » (CR-56). */
  month: boolean;
  pending: boolean;
  error?: string;
}) {
  const cityOf = (chain: string) => stores.find((s) => norm(s.chain) === norm(chain))?.city ?? null;
  const groups = new Map<string, ScenarioLine[]>();
  for (const l of lines) groups.set(l.store ?? "", [...(groups.get(l.store ?? "") ?? []), l]);
  const ordered = [...groups].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, "fr")));
  // un produit « placard » est retiré du total tant que le foyer ne l'a pas coché ; les autres tant qu'il ne les a pas retirés
  const isOut = (l: ScenarioLine) => (l.pantry ? !l.checked : !!picks.removed[norm(l.name)]);
  const kept = lines.filter((l) => !isOut(l));
  // montant de chaque ligne : quantité × prix, ou poids × prix au kilo quand le poids est connu (CR-50) ; un prix au kilo sans poids connu n'est pas totalisé
  const total = kept.reduce((s, l) => s + (l.lineTotal ?? 0), 0);
  const without = kept.filter((l) => l.price === null).length;
  const loose = kept.filter((l) => l.price !== null && l.lineTotal === null).length;
  const toCheck = kept.filter((l) => l.toCheck).length;

  return (
    <>
      <button type="button" className={styles.link} onClick={onBack}>
        ‹ Retour à la préparation
      </button>
      <h2 className={styles.kick}>Scénario {scenario.id}</h2>
      <p className={styles.lead}>{scenarioTitle(scenario)}. Cochez, décochez et ajustez les quantités : le total suit.</p>
      {ordered.map(([store, rows]) => {
        const sub = rows.filter((l) => !isOut(l)).reduce((s, l) => s + (l.lineTotal ?? 0), 0);
        const byRayon = [...rows.reduce((m, l) => m.set(l.rayon, [...(m.get(l.rayon) ?? []), l]), new Map<string, ScenarioLine[]>())];
        return (
          <section key={store || "none"}>
            <div className={styles.storeHead}>
              <span>{store ? `${store}${cityOf(store) ? ` · ${cityOf(store)}` : ""}` : "Sans prix connu"}</span>
              <span className={styles.meta}>{store ? euro(sub) : "à trouver sur place"}</span>
            </div>
            {byRayon.map(([rayon, items]) => (
              <div key={rayon}>
                <h3 className={styles.kick}>{rayon}</h3>
                {items.map((l) => {
                  const removed = isOut(l);
                  const origin = itemsByName.get(norm(l.name))?.group;
                  const weighed = l.priceUnit !== "unit";
                  return (
                    <div key={l.itemId} className={`${styles.line} ${removed ? styles.struck : ""}`}>
                      <button type="button" className={styles.toggleBox} aria-pressed={!removed} aria-label={removed ? (l.pantry ? `Cocher « ${l.name} »` : `Remettre « ${l.name} »`) : `Retirer « ${l.name} »`} onClick={() => (l.pantry ? onPantry(l.name, removed) : onRemoved(l.name, !removed))}>
                        {removed ? "" : "✓"}
                      </button>
                      <div className={styles.lineMain}>
                        <div className={styles.lineName}>{l.name}</div>
                        <div className={styles.lineSub}>
                          {l.price === null
                            ? "Prix inconnu (N/A)"
                            : weighed
                              ? l.weight !== null
                                ? `${l.ref ?? ""} · ${formatQuantity(l.weight, l.priceUnit === "kg" ? "kg" : "l")} × ${euroPer(l.price, l.priceUnit)} = ${euro(l.lineTotal ?? 0)}`
                                : `${l.ref ?? ""} · ${euroPer(l.price, l.priceUnit)} · prix au ${l.priceUnit === "kg" ? "kilo" : "litre"}, non totalisé`
                              : `${l.ref ?? ""}${l.format ? ` (${l.format})` : ""}${l.age && AGE_LABEL[l.age] ? ` · ${AGE_LABEL[l.age]}` : ""}`}
                          {l.labelCheck && " · Composition à vérifier sur l'étiquette"}
                        </div>
                        {/* d'où vient la quantité (CR-50) */}
                        <div className={styles.lineSub}>
                          {l.need && !weighed
                            ? `${l.qty} × ${l.format ?? "unité"} · ${formatQuantity(l.need.amount, l.need.unit === "piece" ? "piece" : l.need.unit)} pour le menu`
                            : l.need && weighed && l.weight === null
                              ? ""
                              : origin === "ajout"
                                ? `Ajouté à la main · ${l.qty}`
                                : origin === "quotidien"
                                  ? `Produit du quotidien · ${l.qty}`
                                : origin === "habituel" && itemsByName.get(norm(l.name))?.leftoverWeek
                                  ? `Pas encore acheté · ${l.qty}`
                                : origin === "habituel"
                                  ? `De votre historique · ${l.qty}`
                                  : ""}
                          {l.toCheck && <span className={styles.pillWarn}> Quantité à vérifier</span>}
                          {l.pantry && <span className={styles.pillWarn}> Vous en avez peut-être déjà</span>}
                        </div>
                      </div>
                      {weighed && l.weight === null ? null : (
                        <span className={styles.stepper}>
                          <button type="button" aria-label="Moins" disabled={removed} onClick={() => onQty(l.name, weighed ? Math.max(0.2, Math.round(((l.weight ?? 0.2) - 0.2) * 10) / 10) : Math.max(1, l.qty - 1))}>
                            −
                          </button>
                          <span aria-live="polite">{weighed ? formatQuantity(l.weight, l.priceUnit === "kg" ? "kg" : "l") : l.qty}</span>
                          <button type="button" aria-label="Plus" disabled={removed} onClick={() => onQty(l.name, weighed ? Math.round(((l.weight ?? 0) + 0.2) * 10) / 10 : Math.min(99, l.qty + 1))}>
                            +
                          </button>
                        </span>
                      )}
                      <span className={styles.linePrice}>{l.price === null ? "N/A" : l.lineTotal !== null ? euro(l.lineTotal) : euroPer(l.price, l.priceUnit)}</span>
                    </div>
                  );
                })}
              </div>
            ))}
          </section>
        );
      })}
      <div className={styles.totalRow}>
        <span>Total estimé</span>
        <span>{euro(total)}</span>
      </div>
      <p className={family.hint}>
        {without === 0 ? "Montants estimés." : `${without} produit${without > 1 ? "s" : ""} sans prix : à payer en plus sur place.`}
        {loose > 0 ? ` ${loose} produit${loose > 1 ? "s" : ""} vendu${loose > 1 ? "s" : ""} au kilo ou au litre sans poids connu : prix au kilo affiché, non totalisé.` : ""}
        {toCheck > 0 ? ` ${toCheck} quantité${toCheck > 1 ? "s" : ""} à vérifier : 1 unité par défaut.` : ""}
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      <div className={styles.footer}>
        <Button
          block
          loading={pending}
          disabled={kept.length === 0}
          onClick={() =>
            void onValidate(
              kept.map((l) => ({
                name: l.name,
                qty: l.qty,
                store: l.store,
                ref: l.ref,
                price: l.price,
                priceUnit: l.priceUnit,
                need: l.need,
                weight: l.weight,
                toCheck: l.toCheck,
                pantry: l.pantry,
                // un rappel coché devient un produit ajouté de cette semaine (CR-55, CR-68)
                source: itemsByName.get(norm(l.name))?.leftoverWeek ? ("added" as const) : ({ menu: "menu", sante: "menu", ajout: "added", habituel: "habit", quotidien: "added" } as const)[itemsByName.get(norm(l.name))?.group ?? "menu"],
              })),
            )
          }
        >
          {month ? "Valider la liste du mois" : "Valider ma liste"}
        </Button>
      </div>
    </>
  );
}

function Done({ group }: { group?: { weeks: string[] } | null }) {
  return (
    <div className={styles.done} role="status">
      <span className={styles.tick} aria-hidden="true">
        ✓
      </span>
      <div className={styles.doneTitle}>Votre liste est prête</div>
      <p className={styles.lead}>Consultez-la en magasin dans « Ma liste de courses ». Vos choix seront repris la prochaine fois.</p>
      <ButtonLink href={group ? `/courses/ma-liste?week=${group.weeks[0]}&scope=group` : "/courses/ma-liste"}>Ouvrir Ma liste de courses</ButtonLink>
    </div>
  );
}
