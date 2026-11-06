"use client";

import { useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import { Button, Loading, Notice, RetryNotice } from "@/components/ui";
import family from "@/components/family/family.module.css";
import type { SettingsView } from "@/server/courses/household/settings";

const BACK = { href: "/courses", label: "Courses et repas" };
const DAYS = [
  [1, "Lun"], [2, "Mar"], [3, "Mer"], [4, "Jeu"], [5, "Ven"], [6, "Sam"], [7, "Dim"],
] as const;
const MISSING_TEXT: Record<string, string> = {
  city: "la ville",
  householdSize: "le nombre de personnes",
  shoppingDays: "les jours de courses",
  cuisines: "les cuisines préférées",
  goals: "les objectifs",
};

interface Form {
  city: string;
  size: number;
  days: number[];
  cuisines: number[];
  goals: { time: boolean; ownDishes: boolean; season: boolean };
  diets: string[];
  allergens: string[];
  allergyText: string;
  repeat: number;
  source: "own" | "cuisine";
  sourceCuisine: number | null;
  budgetDay: number;
  stores: { chain: string; city: string }[];
}

function fromView(v: SettingsView): Form {
  return {
    city: v.city ?? "",
    size: v.householdSize ?? 4,
    days: v.shoppingDays,
    cuisines: v.cuisineIds,
    goals: v.goals,
    diets: v.diets,
    allergens: v.allergens,
    allergyText: v.allergyText,
    repeat: v.repeatWeeks ?? v.options.defaultRepeatWeeks,
    source: v.replacementSource,
    sourceCuisine: v.replacementCuisineId,
    budgetDay: v.budgetDay,
    stores: v.stores,
  };
}

const toggle = <T,>(list: T[], value: T): T[] => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
const dayLabel = (d: number) => (d === 1 ? "Le 1er du mois" : `Le ${d}`);

/**
 * « Réglages du foyer » (US-153, US-154) : ville et enseignes de proximité, foyer, cuisines, objectifs, régimes et allergies (filtrage indicatif, jamais envoyés à l'agent),
 * répétition, remplacements, jour du budget et partage anonyme des prix. Communs au couple ; un invité secondaire n'y a pas accès (CR-10).
 */
export function CoursesSettingsScreen() {
  const query = useApiQuery<{ settings: SettingsView }>("/api/courses/settings");
  const forbidden = query.error?.body?.code === "forbidden";
  return (
    <AppShell title="Réglages du foyer" eyebrow="Courses et repas" back={BACK}>
      {query.loading && !query.data && <Loading slow={query.slow} />}
      {forbidden && <Notice tone="info">Les réglages de Courses et repas sont réservés aux deux parents du couple.</Notice>}
      {query.error && !forbidden && <RetryNotice message={query.error.message} onRetry={query.reload} />}
      {query.data && <SettingsForm initial={query.data.settings} />}
    </AppShell>
  );
}

function SettingsForm({ initial }: { initial: SettingsView }) {
  const save = useApiMutation();
  const sharing = useApiMutation();
  const [form, setForm] = useState<Form>(() => fromView(initial));
  const [view, setView] = useState<SettingsView>(initial);
  const [saved, setSaved] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [newStore, setNewStore] = useState({ chain: "", city: "" });

  const patch = (change: Partial<Form>) => {
    setForm((f) => ({ ...f, ...change }));
    setSaved(false);
  };

  async function submit() {
    const result = await save.run<{ settings: SettingsView }>("/api/courses/settings", {
      method: "PUT",
      body: {
        city: form.city.trim() || null,
        householdSize: form.size,
        shoppingDays: form.days,
        goals: form.goals,
        repeatWeeks: form.repeat,
        replacementSource: form.source,
        replacementCuisineId: form.source === "cuisine" ? form.sourceCuisine : null,
        budgetDay: form.budgetDay,
        cuisineIds: form.cuisines,
        stores: form.stores,
        diets: form.diets,
        allergens: form.allergens,
        allergyText: form.allergyText,
      },
    });
    if (result) {
      setView(result.settings);
      setSaved(true);
    }
  }

  async function setShare(share: boolean) {
    // le partage demande une ville enregistrée : on enregistre d'abord ce qui est affiché
    if (share && !view.city) await submit();
    const result = await sharing.run<{ settings: SettingsView }>("/api/courses/sharing", { method: "POST", body: { share } });
    if (result) {
      setView(result.settings);
      setStopping(false);
    }
  }

  function addStore() {
    const chain = newStore.chain.trim();
    const city = newStore.city.trim() || form.city.trim();
    if (!chain || !city) return;
    patch({ stores: [...form.stores, { chain, city }] });
    setNewStore({ chain: "", city: "" });
  }

  const couple = view.couple.length ? view.couple.join(" et ") : "les deux parents du foyer";

  return (
    <>
      {true && (
        <>
          <p className={family.hint}>Communs à {couple}. Les menus et les courses en tiennent compte, sans tout redemander.</p>
          {view.missing.length > 0 && !saved && <Notice tone="info">À renseigner : {view.missing.map((m) => MISSING_TEXT[m]).join(", ")}.</Notice>}

          <div className={family.form}>
            <div className={family.field}>
              <label className={family.label} htmlFor="cr-ville">
                Ville
              </label>
              <input id="cr-ville" className={family.input} value={form.city} maxLength={80} placeholder="ex. Nantes" onChange={(e) => patch({ city: e.target.value })} />
              <span className={family.hint}>Une ville, jamais une adresse. Seuls la ville et le mot « supermarché » servent à la recherche.</span>
            </div>
            <div className={family.field}>
              <span className={family.label}>Enseignes · gardez celles où vous allez</span>
              {form.stores.length === 0 && <span className={family.hint}>Aucune enseigne pour l&apos;instant.</span>}
              {form.stores.map((s, i) => (
                <div key={`${s.chain}|${s.city}`} className={family.wrapRow} style={{ alignItems: "center", justifyContent: "space-between" }}>
                  <span>
                    {s.chain} — {s.city}
                  </span>
                  <button type="button" className={family.chipToggle} aria-pressed="true" aria-label={`Retirer ${s.chain} — ${s.city}`} onClick={() => patch({ stores: form.stores.filter((_, k) => k !== i) })}>
                    Gardée · Retirer
                  </button>
                </div>
              ))}
              <div className={family.two}>
                <input className={family.input} aria-label="Nom de l'enseigne" placeholder="Enseigne, ex. Lidl" value={newStore.chain} maxLength={80} onChange={(e) => setNewStore({ ...newStore, chain: e.target.value })} />
                <input className={family.input} aria-label="Ville de l'enseigne" placeholder={form.city || "Ville"} value={newStore.city} maxLength={80} onChange={(e) => setNewStore({ ...newStore, city: e.target.value })} />
              </div>
              <Button variant="ghost" onClick={addStore} disabled={!newStore.chain.trim() || !(newStore.city.trim() || form.city.trim())}>
                Ajouter une enseigne
              </Button>
              <span className={family.hint}>Elles servent au comparatif des prix.</span>
            </div>

            <div className={family.field}>
              <span className={family.label}>Nombre de personnes</span>
              <div className={family.stepper}>
                <button type="button" className={family.stepBtn} aria-label="Moins" onClick={() => patch({ size: Math.max(1, form.size - 1) })}>
                  −
                </button>
                <span className={family.stepValue} aria-live="polite">
                  {form.size}
                </span>
                <button type="button" className={family.stepBtn} aria-label="Plus" onClick={() => patch({ size: Math.min(12, form.size + 1) })}>
                  +
                </button>
              </div>
            </div>
            <div className={family.field} role="group" aria-label="Jours de courses">
              <span className={family.label}>Jours de courses</span>
              <div className={family.wrapRow}>
                {DAYS.map(([d, label]) => (
                  <button key={d} type="button" className={family.chipToggle} aria-pressed={form.days.includes(d)} onClick={() => patch({ days: toggle(form.days, d) })}>
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className={family.field} role="group" aria-label="Cuisines préférées">
              <span className={family.label}>Cuisines préférées</span>
              <div className={family.wrapRow}>
                {view.options.cuisines.map((c) => (
                  <button key={c.id} type="button" className={family.chipToggle} aria-pressed={form.cuisines.includes(c.id)} onClick={() => patch({ cuisines: toggle(form.cuisines, c.id) })}>
                    {c.name}
                  </button>
                ))}
              </div>
            </div>
            <div className={family.field} role="group" aria-label="Objectifs">
              <span className={family.label}>Objectifs</span>
              <div className={family.wrapRow}>
                {(
                  [
                    ["time", "Temps"],
                    ["ownDishes", "Mes plats"],
                    ["season", "Saison"],
                  ] as const
                ).map(([key, label]) => (
                  <button key={key} type="button" className={family.chipToggle} aria-pressed={form.goals[key]} onClick={() => patch({ goals: { ...form.goals, [key]: !form.goals[key] } })}>
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className={family.field} role="group" aria-label="Régimes">
              <span className={family.label}>Régimes</span>
              <div className={family.wrapRow}>
                {view.options.diets.map((d) => (
                  <button key={d.id} type="button" className={family.chipToggle} aria-pressed={form.diets.includes(d.name)} onClick={() => patch({ diets: toggle(form.diets, d.name) })}>
                    {d.name}
                  </button>
                ))}
              </div>
            </div>
            <div className={family.field} role="group" aria-label="Allergies">
              <span className={family.label}>Allergies</span>
              <div className={family.wrapRow}>
                {view.options.allergens.map((a) => (
                  <button key={a.id} type="button" className={family.chipToggle} aria-pressed={form.allergens.includes(a.name)} onClick={() => patch({ allergens: toggle(form.allergens, a.name) })}>
                    {a.name}
                  </button>
                ))}
              </div>
              <label className={family.label} htmlFor="cr-all">
                Autre allergie
              </label>
              <input id="cr-all" className={family.input} value={form.allergyText} maxLength={500} placeholder="ex. kiwi" onChange={(e) => patch({ allergyText: e.target.value })} />
              <span className={family.hint} style={{ fontWeight: 700 }}>
                Le filtrage des allergies et des régimes est indicatif : vérifiez toujours les ingrédients.
              </span>
              <span className={family.hint}>Ils servent seulement au filtrage par MAAQ, jamais envoyés à l&apos;assistant.</span>
            </div>

            <div className={family.settingRow}>
              <label className={family.settingType} htmlFor="cr-rep">
                Un plat ne revient pas avant
              </label>
              <select id="cr-rep" className={family.select} aria-label="Répétition" value={form.repeat} onChange={(e) => patch({ repeat: Number(e.target.value) })}>
                {[1, 2, 3, 4].map((n) => (
                  <option key={n} value={n}>
                    {n} semaine{n > 1 ? "s" : ""}
                  </option>
                ))}
              </select>
              <label className={family.settingType} htmlFor="cr-src">
                Remplacements tirés de
              </label>
              <select
                id="cr-src"
                className={family.select}
                aria-label="Source des remplacements"
                value={form.source === "own" ? "own" : `c${form.sourceCuisine ?? ""}`}
                onChange={(e) => (e.target.value === "own" ? patch({ source: "own", sourceCuisine: null }) : patch({ source: "cuisine", sourceCuisine: Number(e.target.value.slice(1)) }))}
              >
                <option value="own">Mes plats</option>
                {view.options.cuisines.map((c) => (
                  <option key={c.id} value={`c${c.id}`}>
                    Cuisine : {c.name}
                  </option>
                ))}
              </select>
              <label className={family.settingType} htmlFor="cr-bud">
                Jour du budget
              </label>
              <select id="cr-bud" className={family.select} aria-label="Jour du budget" value={form.budgetDay} onChange={(e) => patch({ budgetDay: Number(e.target.value) })}>
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {dayLabel(d)}
                  </option>
                ))}
              </select>
            </div>

            <div className={family.settingRow} style={{ borderColor: "var(--secondary)" }}>
              <div className={family.settingType}>Partager anonymement nos prix</div>
              <button
                type="button"
                role="switch"
                aria-checked={view.sharePrices}
                aria-label="Partager anonymement nos prix"
                className={family.switch}
                disabled={sharing.pending}
                onClick={() => (view.sharePrices ? setStopping(true) : void setShare(true))}
              >
                {sharing.pending ? "Enregistrement…" : view.sharePrices ? "Oui" : "Non"}
              </button>
              <p className={family.confirmText}>{view.consentText}</p>
              <span className={family.hint}>Pour tout le foyer, sans question après chaque ticket. Partagé : produit, référence, prix, enseigne, ville, semaine. Jamais de prénom ni d&apos;identifiant.</span>
              {sharing.error && <Notice tone="error">{sharing.error.message}</Notice>}
              {stopping && (
                <div role="alertdialog" aria-label="Arrêter le partage" className={family.form}>
                  <div className={family.confirmTitle}>Arrêter le partage ?</div>
                  <p className={family.confirmText}>
                    Les prochains tickets ne seront plus partagés. Les prix déjà partagés, anonymes, restent dans la base commune. Vous ne verrez plus les prix des autres foyers.
                  </p>
                  <div className={family.actionsRow}>
                    <Button variant="ghost" onClick={() => setStopping(false)} disabled={sharing.pending}>
                      Annuler
                    </Button>
                    <Button onClick={() => void setShare(false)} loading={sharing.pending}>
                      Arrêter
                    </Button>
                  </div>
                </div>
              )}
            </div>

            {save.error && <Notice tone="error">{save.error.message}</Notice>}
            {saved && (
              <p className={family.saveOk} role="status">
                ✓ Réglages enregistrés
              </p>
            )}
            <Button block onClick={() => void submit()} loading={save.pending}>
              Enregistrer
            </Button>
          </div>
        </>
      )}
    </>
  );
}
