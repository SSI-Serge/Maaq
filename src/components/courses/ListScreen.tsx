"use client";

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import family from "@/components/family/family.module.css";
import { Button, ButtonLink, Loading, Notice, RetryNotice } from "@/components/ui";
import { AGE_LABEL, comparatif, computeScenarios, isReplaced, norm, scenarioLines, selectedChoice, type DishMode, type ListItem, type ListSelection, type Scenario, type ScenarioLine } from "@/server/courses/engine";
import { fromDto } from "@/server/courses/list/dto";
import type { AddedLine, ListPrepared, ValidateLine } from "@/server/courses/list/service";
import styles from "./courses.module.css";

const BACK = { href: "/courses", label: "Courses et repas" };

export const euro = (value: number) => `${value.toFixed(2).replace(".", ",")} €`;
/** « 1,49 €/kg » : prix au kilo ou au litre. */
export const euroPer = (value: number, unit: "kg" | "l" | "unit") => `${euro(value)}${unit === "unit" ? "" : unit === "kg" ? "/kg" : "/L"}`;
const priceText = (value: number | null) => (value === null ? "N/A" : euro(value));

/** « Liste de courses » (US-157, US-158) : préparation après la validation du menu, comparatif des prix, trois scénarios d'achat, validation. */
export function CoursesListScreen() {
  const query = useApiQuery<{ list: ListPrepared }>("/api/courses/list");
  const forbidden = query.error?.body?.code === "forbidden";
  return (
    <AppShell title="Liste de courses" eyebrow="Courses et repas" back={BACK}>
      {query.loading && !query.data && <Loading slow={query.slow} />}
      {forbidden && <Notice tone="info">La liste de courses n&apos;est pas disponible pour ce profil.</Notice>}
      {query.error && !forbidden && <RetryNotice message={query.error.message} onRetry={query.reload} />}
      {query.data && <ListFlow list={query.data.list} reload={query.reload} />}
    </AppShell>
  );
}

function ListFlow({ list, reload }: { list: ListPrepared; reload: () => void }) {
  if (list.access === "list") return <GuestView list={list} reload={reload} />;
  if (!list.menu || !list.model) {
    return (
      <p className={styles.empty}>
        Aucune liste à préparer pour l&apos;instant. <Link href="/courses/menu">Préparer le menu ›</Link>
      </p>
    );
  }
  return <Preparation list={list} reload={reload} />;
}

/** Invité secondaire : il ajoute un produit et retire les siens, rien d'autre (CR-10). */
function GuestView({ list, reload }: { list: ListPrepared; reload: () => void }) {
  return (
    <>
      <p className={styles.note}>
        La liste validée est dans <Link href="/courses/ma-liste">Ma liste de courses</Link>. Ici, vous pouvez ajouter un produit et retirer vos propres ajouts.
      </p>
      <AddedSection added={list.added} access={list.access} reload={reload} />
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

function AddedSection({ added, access, reload }: { added: AddedLine[]; access: "couple" | "list"; reload: () => void }) {
  const add = useApiMutation();
  const remove = useApiMutation();
  const [text, setText] = useState("");
  const [message, setMessage] = useState("");

  async function submit() {
    if (!text.trim()) return;
    const result = await add.run<{ duplicate: { name: string; quantity: number } | null }>("/api/courses/list/products", { method: "POST", body: { name: text.trim() } });
    if (!result) return;
    setMessage(result.duplicate ? `${result.duplicate.name} est déjà dans la liste : quantité ${result.duplicate.quantity}.` : "");
    setText("");
    reload();
  }
  async function drop(key: string) {
    if (await remove.run("/api/courses/list/products", { method: "DELETE", body: { key } })) reload();
  }

  return (
    <Rub title="Produits ajoutés" open>
      {added.length === 0 && <p className={styles.empty}>Aucun produit ajouté.</p>}
      {added.map((a) => (
        <div key={a.key} className={styles.line}>
          <div className={styles.lineMain}>
            <div className={styles.lineName}>{a.name}</div>
            <div className={styles.lineSub}>
              {a.by ? `ajouté par ${a.by}` : "ajouté"} {a.notBoughtLastTime && <span className={styles.pillWarn}>Pas acheté la dernière fois</span>}
            </div>
          </div>
          <span className={styles.meta}>×{a.qty}</span>
          {(access === "couple" || a.mine) && (
            <button type="button" className={styles.link} onClick={() => void drop(a.key)} aria-label={`Retirer ${a.name}`}>
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

  if (done) return <Done />;

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
        onBack={() => setView(null)}
        pending={validate.pending}
        error={validate.error?.message}
        onValidate={async (lines) => {
          const result = await validate.run("/api/courses/list/validate", { method: "POST", body: { scenario: view, lines } });
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
  const habitByRayon = [...habit.reduce((m, i) => m.set(i.rayon, [...(m.get(i.rayon) ?? []), i]), new Map<string, ListItem[]>())];

  async function apply() {
    patch({ applied: true });
    await save.run("/api/courses/list/modes", { method: "PUT", body: { modes: picks.modes } });
  }

  return (
    <>
      <p className={family.hint}>Semaine du {summary.weekLabel}</p>
      <div className={styles.tools}>
        <Button variant="ghost" onClick={() => setOpened({ all: true, key: opened.key + 1 })}>
          Tout déplier
        </Button>
      </div>

      {rub("Menu validé et recettes", false, (
        <ul style={{ margin: 0, paddingLeft: 0, listStyle: "none" }}>
          {summary.days.map((d) => (
            <li key={d.day} className={styles.line}>
              <span className={styles.lineMain}>
                <span className={styles.meta}>{d.day}</span>
                <div className={styles.lineName}>{d.name}</div>
              </span>
              <span className={styles.meta}>{d.time}</span>
            </li>
          ))}
        </ul>
      ))}
      {rub("Séance de batch", false, <p style={{ margin: 0 }}>Dimanche, {summary.session.label}{summary.session.estimated ? " (durée estimée)" : ""}{summary.session.theme ? ` · semaine type « ${summary.session.theme} »` : ""}. Lundi à vendredi.</p>)}
      {rub("Plats express", false, (
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          {summary.express.map((e) => (
            <li key={e.name}>
              {e.name} <span className={styles.meta}>⏱ {e.time}</span>
            </li>
          ))}
        </ul>
      ))}

      {rub("Version standard ou allégée", true, (
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

      {rub("Ingrédients du menu", false, (
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

      <AddedSection added={list.added} access={list.access} reload={reload} />

      {rub("Produits de mon historique", true, (
        <>
          <p className={family.hint}>Achetés ces 3 derniers mois. Cochez ce qu&apos;il vous faut cette semaine : le produit entre dans les scénarios.</p>
          {habit.length === 0 && <p className={styles.empty}>Rien pour l&apos;instant : les produits achetés (tickets, cases cochées en magasin) apparaissent ici.</p>}
          {habitByRayon.map(([rayon, items]) => (
            <div key={rayon}>
              <h3 className={styles.kick}>{rayon}</h3>
              {items.map((i) => (
                <label key={i.id} className={styles.choice}>
                  <input type="checkbox" checked={sel.checked?.get(i.id) ?? i.checked} onChange={(e) => patch({ checked: { ...picks.checked, [norm(i.name)]: e.target.checked } })} />
                  <span>{i.name}</span>
                </label>
              ))}
            </div>
          ))}
        </>
      ))}

      {rub("Ingrédients exclus des références proposées", false, (
        <>
          {list.excluded.length === 0 && <p className={styles.empty}>Aucune référence écartée pour cette liste.</p>}
          {list.excluded.map((e) => (
            <p key={`${e.product}|${e.store}|${e.reference}`} style={{ margin: "0 0 8px" }}>
              {e.reference} ({e.store}) : {e.because.length ? `contient ${e.because.join(", ")}. La référence suivante, conforme, est proposée.` : "aucune référence conforme trouvée pour le moment."}
            </p>
          ))}
          {list.criteria.length > 0 && (
            <>
              <h3 className={styles.kick}>Critères additifs appliqués</h3>
              {list.criteria.map((c) => (
                <div key={c.label} className={styles.line}>
                  <span className={styles.lineName}>{c.label}</span>
                  <span className={styles.lineSub}>{c.reason}</span>
                </div>
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
            Montants estimés : prix d&apos;une unité (paquet, boîte…) × la quantité. Recettes prévues pour 4 personnes ; votre foyer : {list.householdSize ?? 4}. Un prix inconnu affiche N/A.
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
  onBack,
  onValidate,
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
  onBack: () => void;
  onValidate: (lines: ValidateLine[]) => Promise<void>;
  pending: boolean;
  error?: string;
}) {
  const cityOf = (chain: string) => stores.find((s) => norm(s.chain) === norm(chain))?.city ?? null;
  const groups = new Map<string, ScenarioLine[]>();
  for (const l of lines) groups.set(l.store ?? "", [...(groups.get(l.store ?? "") ?? []), l]);
  const ordered = [...groups].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b, "fr")));
  const kept = lines.filter((l) => !picks.removed[norm(l.name)]);
  // un article vendu au kilo ou au litre n'entre pas dans le total estimé (CR-40)
  const total = kept.reduce((s, l) => s + (l.priceUnit === "unit" ? (l.price ?? 0) * l.qty : 0), 0);
  const without = kept.filter((l) => l.price === null).length;
  const loose = kept.filter((l) => l.price !== null && l.priceUnit !== "unit").length;

  return (
    <>
      <button type="button" className={styles.link} onClick={onBack}>
        ‹ Retour à la préparation
      </button>
      <h2 className={styles.kick}>Scénario {scenario.id}</h2>
      <p className={styles.lead}>{scenarioTitle(scenario)}. Cochez, décochez et ajustez les quantités : le total suit.</p>
      {ordered.map(([store, rows]) => {
        const sub = rows.filter((l) => !picks.removed[norm(l.name)]).reduce((s, l) => s + (l.price ?? 0) * l.qty, 0);
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
                  const removed = !!picks.removed[norm(l.name)];
                  return (
                    <div key={l.itemId} className={`${styles.line} ${removed ? styles.struck : ""}`}>
                      <button type="button" className={styles.toggleBox} aria-pressed={!removed} aria-label={removed ? `Remettre « ${l.name} »` : `Retirer « ${l.name} »`} onClick={() => onRemoved(l.name, !removed)}>
                        {removed ? "" : "✓"}
                      </button>
                      <div className={styles.lineMain}>
                        <div className={styles.lineName}>{l.name}</div>
                        <div className={styles.lineSub}>
                          {l.price === null ? "Prix inconnu (N/A)" : l.priceUnit !== "unit" ? `${l.ref ?? ""} · prix au ${l.priceUnit === "kg" ? "kilo" : "litre"}, non totalisé` : `${l.ref ?? ""}${l.format ? ` (${l.format})` : ""}${l.age && AGE_LABEL[l.age] ? ` · ${AGE_LABEL[l.age]}` : ""}`}
                          {l.labelCheck && " · Composition à vérifier sur l'étiquette"}
                        </div>
                      </div>
                      <span className={styles.stepper}>
                        <button type="button" aria-label="Moins" disabled={removed} onClick={() => onQty(l.name, Math.max(1, l.qty - 1))}>
                          −
                        </button>
                        <span aria-live="polite">{l.qty}</span>
                        <button type="button" aria-label="Plus" disabled={removed} onClick={() => onQty(l.name, Math.min(99, l.qty + 1))}>
                          +
                        </button>
                      </span>
                      <span className={styles.linePrice}>{l.price === null ? "N/A" : l.priceUnit !== "unit" ? euroPer(l.price, l.priceUnit) : euro(l.price * l.qty)}</span>
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
        {loose > 0 ? ` ${loose} produit${loose > 1 ? "s" : ""} vendu${loose > 1 ? "s" : ""} au kilo ou au litre : prix au kilo affiché, non totalisé.` : ""}
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
                source: ({ menu: "menu", sante: "menu", ajout: "added", habituel: "habit" } as const)[itemsByName.get(norm(l.name))?.group ?? "menu"],
              })),
            )
          }
        >
          Valider ma liste
        </Button>
      </div>
    </>
  );
}

function Done() {
  return (
    <div className={styles.done} role="status">
      <span className={styles.tick} aria-hidden="true">
        ✓
      </span>
      <div className={styles.doneTitle}>Votre liste est prête</div>
      <p className={styles.lead}>Consultez-la en magasin dans « Ma liste de courses ». Vos choix seront repris la prochaine fois.</p>
      <ButtonLink href="/courses/ma-liste">Ouvrir Ma liste de courses</ButtonLink>
    </div>
  );
}
