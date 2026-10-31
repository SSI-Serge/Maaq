"use client";

import Link from "next/link";
import { useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell, Section } from "@/components/app/AppShell";
import { Button, Loading, Notice, RetryNotice } from "@/components/ui";
import type { CriteriaInput, CriteriaView } from "@/server/assistant/outings/criteria";
import {
  budgetValid, DAY_INITIAL, DAY_LABEL, FREQUENCIES, FREQUENCY_LABEL, GROUP_LABEL, MOOD_LABEL, MOODS, MSG_ADDRESS, MSG_BUDGET, MSG_STORE_ERROR, PEOPLE_MAX, PEOPLE_MIN, SPECIFIC_DAYS,
  looksLikeAddress,
} from "@/server/assistant/outings/rules";
import type { OutingCategory, OutingDayPref, OutingFrequency, OutingMood } from "@/server/db/schema.generated";
import styles from "./family.module.css";

const toggle = <T,>(list: T[], value: T): T[] => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** Regroupe par clé en gardant l'ordre ; écrit à la main : `Object.groupBy` manque aux navigateurs un peu anciens. */
function grouped<T>(items: T[], key: (item: T) => string): [string, T[]][] {
  const map = new Map<string, T[]>();
  for (const item of items) map.set(key(item), [...(map.get(key(item)) ?? []), item]);
  return [...map.entries()];
}

/**
 * Ligne d'accès « Idées de sorties » de Réglages > Mes notifications (D68) : un résumé (« Activées · En couple, Pour moi · deux par mois » ou « Désactivées · touchez pour choisir vos
 * critères ») et un lien vers l'écran des critères. Réservé aux parents : un profil sans ce droit ne voit pas la ligne.
 */
export function OutingsAccessRow() {
  const query = useApiQuery<{ criteria: CriteriaView }>("/api/family/outings/criteria");
  if (query.error?.body?.code === "forbidden") return null;
  return (
    <Link href="/assistant/reglages/sorties" className={styles.linkRow}>
      <span>
        Idées de sorties
        <span className={styles.linkRowSub}>{query.data ? query.data.criteria.summary : query.error ? "Touchez pour choisir vos critères" : "…"}</span>
      </span>
      <span aria-hidden>›</span>
    </Link>
  );
}

/** Écran des critères de sorties (US-114, D68, proposition A) : accordéon par catégorie, une seule ouverte à la fois, « Enregistrer » fixé en bas. */
export function OutingsCriteriaScreen() {
  const query = useApiQuery<{ criteria: CriteriaView }>("/api/family/outings/criteria");
  const forbidden = query.error?.body?.code === "forbidden";
  return (
    <AppShell title="Idées de sorties" back={{ href: "/assistant/reglages", label: "Réglages" }}>
      {query.loading && !query.data && <Loading slow={query.slow} />}
      {forbidden && <Notice tone="info">Les idées de sorties sont réservées aux deux parents.</Notice>}
      {query.error && !forbidden && <RetryNotice message={query.error.kind === "server" ? "Les critères n'ont pas pu être chargés." : query.error.message} onRetry={query.reload} />}
      {query.data && <CriteriaForm initial={query.data.criteria} />}
    </AppShell>
  );
}

function CriteriaForm({ initial }: { initial: CriteriaView }) {
  const save = useApiMutation();
  const [saved, setSaved] = useState(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [cats, setCats] = useState<OutingCategory[]>(() => initial.categories.filter((c) => (initial.selected[c.category]?.length ?? 0) > 0).map((c) => c.category));
  const [themes, setThemes] = useState<Partial<Record<OutingCategory, string[]>>>(initial.selected);
  const [open, setOpen] = useState<OutingCategory | null>(() => initial.categories.find((c) => (initial.selected[c.category]?.length ?? 0) > 0)?.category ?? initial.categories[0]?.category ?? null);
  const [groupOpen, setGroupOpen] = useState<Record<string, boolean>>({});
  const [budget, setBudget] = useState(initial.budget === null ? "" : String(initial.budget));
  const [people, setPeople] = useState(initial.people ?? 2);
  const [place, setPlace] = useState(initial.place);
  const [mood, setMood] = useState<OutingMood>(initial.mood);
  const [weekend, setWeekend] = useState(initial.days.includes("weekend"));
  const [evenings, setEvenings] = useState(initial.days.includes("weekday_evenings"));
  const [specific, setSpecific] = useState<OutingDayPref[]>(initial.days.filter((d) => SPECIFIC_DAYS.includes(d)));
  const [showDays, setShowDays] = useState(initial.days.some((d) => SPECIFIC_DAYS.includes(d)));
  const [frequency, setFrequency] = useState<OutingFrequency>(initial.frequency);
  const [done, setDone] = useState(false);

  const days: OutingDayPref[] = [...(weekend ? (["weekend"] as const) : []), ...(evenings ? (["weekday_evenings"] as const) : []), ...specific];
  const count = (category: OutingCategory) => themes[category]?.length ?? 0;
  const budgetError = budget.trim() !== "" && !budgetValid(budget);
  const placeError = looksLikeAddress(place);
  // Activé : chaque catégorie cochée a au moins un thème, le budget et la ville sont valides, au moins un jour (RF6).
  const ready = cats.length > 0 && cats.every((c) => count(c) > 0) && budget.trim() !== "" && !budgetError && place.trim().length >= 2 && !placeError && days.length > 0;
  const changedOff = !enabled && saved.enabled;
  const canSave = !save.pending && (enabled ? ready : changedOff);

  function markCategory(category: OutingCategory) {
    setCats((cur) => toggle(cur, category));
    setOpen(category);
    setDone(false);
  }
  function pickTheme(category: OutingCategory, key: string) {
    if (!cats.includes(category)) return;
    setThemes((cur) => ({ ...cur, [category]: toggle(cur[category] ?? [], key) }));
    setDone(false);
  }

  async function submit() {
    setDone(false);
    const selected: CriteriaInput["selected"] = {};
    for (const c of cats) if (count(c) > 0) selected[c] = themes[c];
    const body: CriteriaInput = {
      enabled, selected, budget: budget.trim() === "" ? null : Number(budget), people, place: place.trim(), mood, days: days.length ? days : ["weekend"], frequency,
    };
    const result = await save.run<{ criteria: CriteriaView }>("/api/family/outings/criteria", { method: "PUT", body });
    if (result) {
      setSaved(result.criteria);
      setDone(true);
    }
  }

  const summaryOf = (category: OutingCategory): string => {
    if (!cats.includes(category)) return "Non choisie";
    const list = initial.categories.find((c) => c.category === category)!.themes;
    const chosen = list.filter((t) => themes[category]?.includes(t.key));
    if (!chosen.length) return "Choisissez au moins un thème";
    const plain = chosen.filter((t) => !t.group).map((t) => capitalize(t.label));
    const groups = grouped(chosen.filter((t) => t.group), (t) => t.group!).map(([group, items]) => `${GROUP_LABEL[group] ?? capitalize(group)} (${items.length})`);
    return [...plain, ...groups].join(", ");
  };

  return (
    <div className={styles.form}>
      <div className={styles.settingRow} role="group" aria-label="Recevoir des idées de sorties" style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div className={styles.settingType}>Recevoir des idées de sorties</div>
          <span className={styles.hint}>MAAQ vous propose de lui-même des idées.</span>
        </div>
        <div className={styles.switches}>
          <button type="button" role="switch" aria-checked={enabled} aria-label="Recevoir des idées de sorties" className={styles.switch} disabled={save.pending} onClick={() => { setEnabled((v) => !v); setDone(false); }}>
            {enabled ? "Oui" : "Non"}
          </button>
        </div>
      </div>

      {enabled && !saved.open && <Notice tone="info">Les idées de sorties ne sont pas encore ouvertes : vos critères sont gardés, aucune proposition n&apos;est préparée pour le moment.</Notice>}

      {enabled && (
        <>
          <p className={styles.noteBox}>{saved.otherParent ? `Ces critères restent privés : ${saved.otherParent} ne les voit pas.` : "Ces critères restent privés."}</p>

          <Section title="Pour qui, et quels thèmes ?">
            <p className={styles.hint}>Cochez la case pour choisir une catégorie. Touchez son nom pour voir et choisir ses thèmes.</p>
            <div className={styles.accordion}>
              {initial.categories.map((category) => {
                const selected = cats.includes(category.category);
                const isOpen = open === category.category;
                const plain = category.themes.filter((t) => !t.group);
                const groups = grouped(category.themes.filter((t) => t.group), (t) => t.group!);
                return (
                  <div key={category.category} className={styles.accItem}>
                    <div className={styles.accHead}>
                      <button
                        type="button"
                        className={`${styles.accCase} ${selected ? styles.accCaseOn : ""}`}
                        aria-label={`${selected ? "Retirer" : "Choisir"} ${category.label}`}
                        aria-pressed={selected}
                        onClick={() => markCategory(category.category)}
                      >
                        <span className={`${styles.accBox} ${selected ? styles.accBoxOn : ""}`} aria-hidden>
                          {selected ? "✓" : ""}
                        </span>
                      </button>
                      <button type="button" className={styles.accRow} aria-expanded={isOpen} aria-label={`${category.label} : ${isOpen ? "fermer" : "voir"} les thèmes`} onClick={() => setOpen(isOpen ? null : category.category)}>
                        <span>
                          <span className={styles.accLabel}>{category.label}</span>
                          <span className={styles.accSummary}>{summaryOf(category.category)}</span>
                        </span>
                        <span className={styles.accOpen}>
                          {isOpen ? "Fermer" : "Thèmes"}
                          <span aria-hidden className={`${styles.accChevron} ${isOpen ? styles.accChevronOpen : ""}`}>
                            ›
                          </span>
                        </span>
                      </button>
                    </div>
                    {isOpen && (
                      <div className={styles.accBody}>
                        {!selected && <p className={styles.hint}>Cochez la catégorie pour choisir ses thèmes.</p>}
                        <div className={styles.wrapRow}>
                          {plain.map((theme) => (
                            <button key={theme.key} type="button" className={styles.chipToggle} aria-pressed={themes[category.category]?.includes(theme.key) ?? false} aria-disabled={!selected} onClick={() => pickTheme(category.category, theme.key)}>
                              {capitalize(theme.label)}
                            </button>
                          ))}
                        </div>
                        {groups.map(([group, items]) => {
                          const key = `${category.category}/${group}`;
                          const chosen = items.filter((t) => themes[category.category]?.includes(t.key)).length;
                          const expanded = groupOpen[key] ?? chosen > 0;
                          return (
                            <div key={group} className={styles.subgroup}>
                              <button type="button" className={styles.subgroupHead} aria-expanded={expanded} onClick={() => setGroupOpen((cur) => ({ ...cur, [key]: !expanded }))}>
                                <span>
                                  <strong>{GROUP_LABEL[group] ?? capitalize(group)}</strong>
                                  {chosen > 0 && <span className={styles.hint}> · {chosen} choisi{chosen > 1 ? "s" : ""}</span>}
                                </span>
                                <span aria-hidden className={`${styles.accChevron} ${expanded ? styles.accChevronOpen : ""}`}>
                                  ›
                                </span>
                              </button>
                              {expanded && (
                                <div className={styles.wrapRow} style={{ padding: "0 12px 12px" }}>
                                  {items.map((theme) => (
                                    <button key={theme.key} type="button" className={styles.chipToggle} aria-pressed={themes[category.category]?.includes(theme.key) ?? false} aria-disabled={!selected} onClick={() => pickTheme(category.category, theme.key)}>
                                      {capitalize(theme.label)}
                                    </button>
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
            <p className={styles.hint}>« Ados » n&apos;apparaît que si un enfant de la famille a de 11 à 17 ans.</p>
          </Section>

          <Section title="Budget et lieu de départ">
            <div className={styles.field}>
              <label className={styles.label} htmlFor="outing-budget">
                Budget total, en euros
              </label>
              <input id="outing-budget" className={styles.input} inputMode="numeric" value={budget} onChange={(e) => { setBudget(e.target.value.replace(/[^\d]/g, "").slice(0, 4)); setDone(false); }} />
              {budgetError && <span className={styles.fieldError}>{MSG_BUDGET}</span>}
            </div>
            <div className={styles.stepperRow}>
              <span className={styles.label}>Nombre de personnes</span>
              <div className={styles.stepper}>
                <button type="button" aria-label="Une personne de moins" className={styles.stepBtn} disabled={people <= PEOPLE_MIN} onClick={() => { setPeople((n) => Math.max(PEOPLE_MIN, n - 1)); setDone(false); }}>
                  −
                </button>
                <span className={styles.stepValue} aria-live="polite">
                  {people}
                </span>
                <button type="button" aria-label="Une personne de plus" className={styles.stepBtn} disabled={people >= PEOPLE_MAX} onClick={() => { setPeople((n) => Math.min(PEOPLE_MAX, n + 1)); setDone(false); }}>
                  +
                </button>
              </div>
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="outing-place">
                Ville ou secteur
              </label>
              <input id="outing-place" className={styles.input} value={place} maxLength={80} placeholder="ex. Lyon" onChange={(e) => { setPlace(e.target.value); setDone(false); }} />
              {placeError && <span className={styles.fieldError}>{MSG_ADDRESS}</span>}
              <span className={styles.hint}>Une ville ou un secteur, jamais une adresse.</span>
            </div>
          </Section>

          <Section title="Ambiance">
            <div className={styles.segGrid} style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
              {MOODS.map((m) => (
                <button key={m} type="button" className={styles.segBtn} aria-pressed={mood === m} onClick={() => { setMood(m); setDone(false); }}>
                  {MOOD_LABEL[m]}
                </button>
              ))}
            </div>
          </Section>

          <Section title="Quand ?">
            <div className={styles.wrapRow}>
              <button type="button" className={styles.chipToggle} aria-pressed={weekend} onClick={() => { setWeekend((v) => !v); setDone(false); }}>
                {DAY_LABEL.weekend}
              </button>
              <button type="button" className={styles.chipToggle} aria-pressed={evenings} onClick={() => { setEvenings((v) => !v); setDone(false); }}>
                {DAY_LABEL.weekday_evenings}
              </button>
              <button
                type="button"
                className={styles.chipToggle}
                aria-pressed={showDays}
                aria-expanded={showDays}
                onClick={() => {
                  if (showDays) setSpecific([]);
                  setShowDays((v) => !v);
                  setDone(false);
                }}
              >
                Jours précis
              </button>
            </div>
            {showDays && (
              <div className={styles.rounds}>
                {SPECIFIC_DAYS.map((day) => (
                  <button key={day} type="button" className={styles.roundBtn} aria-label={DAY_LABEL[day]} aria-pressed={specific.includes(day)} onClick={() => { setSpecific((cur) => toggle(cur, day)); setDone(false); }}>
                    {DAY_INITIAL[day]}
                  </button>
                ))}
              </div>
            )}
            {days.length === 0 && <span className={styles.hint}>Choisissez au moins un moment.</span>}
          </Section>

          <Section title="Fréquence">
            <div className={styles.segGrid} style={{ gridTemplateColumns: "1fr 1fr" }}>
              {FREQUENCIES.map((f) => (
                <button key={f} type="button" className={styles.segBtn} aria-pressed={frequency === f} onClick={() => { setFrequency(f); setDone(false); }}>
                  {FREQUENCY_LABEL[f]}
                </button>
              ))}
            </div>
          </Section>
        </>
      )}

      {(enabled || changedOff) && (
        <div className={styles.saveBar}>
          {save.error && <Notice tone="error">{save.error.kind === "server" || save.error.kind === "timeout" || save.error.kind === "offline" ? MSG_STORE_ERROR : save.error.message}</Notice>}
          {done && !save.error && <span className={styles.saveOk}>✓ Critères enregistrés.</span>}
          <Button onClick={() => void submit()} loading={save.pending} disabled={!canSave}>
            {save.pending ? "Enregistrement…" : "Enregistrer"}
          </Button>
        </div>
      )}
    </div>
  );
}
