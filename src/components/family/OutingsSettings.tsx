"use client";

import { useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { Section } from "@/components/app/AppShell";
import { Button, Loading, Notice, RetryNotice } from "@/components/ui";
import type { CriteriaInput, CriteriaView } from "@/server/assistant/outings/criteria";
import type { OutingCategory, OutingDayPref, OutingFrequency, OutingMood } from "@/server/db/schema.generated";
import styles from "./family.module.css";

const MOODS: { value: OutingMood; label: string }[] = [
  { value: "calm", label: "Calme" },
  { value: "playful", label: "Ludique" },
  { value: "both", label: "Les deux" },
];
const FREQUENCIES: { value: OutingFrequency; label: string }[] = [
  { value: "monthly", label: "Une par mois" },
  { value: "twice_monthly", label: "Deux par mois" },
  { value: "weekly", label: "Une par semaine" },
];
const DAYS: { value: OutingDayPref; label: string }[] = [
  { value: "weekend", label: "Week-end" },
  { value: "weekday_evenings", label: "Soirs de semaine" },
  { value: "monday", label: "Lundi" },
  { value: "tuesday", label: "Mardi" },
  { value: "wednesday", label: "Mercredi" },
  { value: "thursday", label: "Jeudi" },
  { value: "friday", label: "Vendredi" },
  { value: "saturday", label: "Samedi" },
  { value: "sunday", label: "Dimanche" },
];

const toggle = <T,>(list: T[], value: T): T[] => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);

/**
 * Section « Idées de sorties » des réglages (US-114) : réservée aux deux parents, désactivée par défaut. Les critères sont personnels : l'autre parent ne les voit pas.
 * « Enregistrer » n'est actif que lorsque les critères obligatoires sont remplis (catégorie et thème, budget, lieu). Pendant l'enregistrement un indicateur s'affiche ; en cas
 * d'erreur les critères saisis restent à l'écran avec le message (RF6, RF7).
 */
export function OutingsSettings() {
  const query = useApiQuery<{ criteria: CriteriaView }>("/api/family/outings/criteria");
  if (query.error?.body?.code === "forbidden") return null;
  const data = query.data?.criteria;
  return (
    <Section title="Idées de sorties">
      <p className={styles.hint}>Des idées de sorties proposées de temps en temps, selon vos critères. Réservé aux parents.</p>
      {query.loading && !data && <Loading slow={query.slow} />}
      {query.error && <RetryNotice message={query.error.kind === "server" ? "Les critères n'ont pas pu être chargés." : query.error.message} onRetry={query.reload} />}
      {data && <CriteriaForm initial={data} />}
    </Section>
  );
}

function CriteriaForm({ initial }: { initial: CriteriaView }) {
  const save = useApiMutation();
  const [saved, setSaved] = useState(initial);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [selected, setSelected] = useState<Partial<Record<OutingCategory, string[]>>>(initial.selected);
  const [budget, setBudget] = useState(initial.budget === null ? "" : String(initial.budget));
  const [people, setPeople] = useState(initial.people === null ? "" : String(initial.people));
  const [place, setPlace] = useState(initial.place);
  const [mood, setMood] = useState<OutingMood>(initial.mood);
  const [days, setDays] = useState<OutingDayPref[]>(initial.days);
  const [frequency, setFrequency] = useState<OutingFrequency>(initial.frequency);
  const [done, setDone] = useState(false);

  const themesCount = Object.values(selected).reduce((n, list) => n + (list?.length ?? 0), 0);
  // Activé : catégorie et thème, budget, nombre de personnes et lieu sont obligatoires (RF6). Désactivé, tout s'enregistre tel quel.
  const complete = themesCount > 0 && budget.trim() !== "" && people.trim() !== "" && place.trim() !== "" && days.length > 0;
  const canSave = !enabled || complete;

  async function submit() {
    setDone(false);
    const body: CriteriaInput = {
      enabled, selected, budget: budget.trim() === "" ? null : Number(budget), people: people.trim() === "" ? null : Number(people), place: place.trim(), mood, days, frequency,
    };
    const result = await save.run<{ criteria: CriteriaView }>("/api/family/outings/criteria", { method: "PUT", body });
    if (result) {
      setSaved(result.criteria);
      setDone(true);
    }
  }

  return (
    <>
      <div className={styles.settingRow} role="group" aria-label="Recevoir des idées de sorties">
        <div className={styles.settingType}>Recevoir des idées de sorties</div>
        <div className={styles.switches}>
          <button type="button" role="switch" aria-checked={enabled} aria-label="Recevoir des idées de sorties" className={styles.switch} disabled={save.pending} onClick={() => { setEnabled((v) => !v); setDone(false); }}>
            {enabled ? "Oui" : "Non"}
          </button>
        </div>
      </div>
      {enabled && !saved.open && <Notice tone="info">Les idées de sorties ne sont pas encore ouvertes : vos critères sont gardés, aucune proposition n&apos;est préparée pour le moment.</Notice>}

      {enabled && (
        <div className={styles.form}>
          {saved.categories.map((category) => (
            <div key={category.category}>
              <div className={styles.label}>{category.label}</div>
              <div className={styles.actionsRow}>
                {category.themes.map((theme) => (
                  <button
                    key={theme.key}
                    type="button"
                    className={styles.chipToggle}
                    aria-pressed={selected[category.category]?.includes(theme.key) ?? false}
                    onClick={() => setSelected((cur) => ({ ...cur, [category.category]: toggle(cur[category.category] ?? [], theme.key) }))}
                  >
                    {theme.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
          <div className={styles.two}>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="outing-budget">
                Budget total (€)
              </label>
              <input id="outing-budget" className={styles.input} inputMode="numeric" value={budget} onChange={(e) => setBudget(e.target.value.replace(/\D/g, "").slice(0, 4))} placeholder="Ex. 80" />
            </div>
            <div className={styles.field}>
              <label className={styles.label} htmlFor="outing-people">
                Nombre de personnes
              </label>
              <input id="outing-people" className={styles.input} inputMode="numeric" value={people} onChange={(e) => setPeople(e.target.value.replace(/\D/g, "").slice(0, 2))} placeholder="Ex. 2" />
            </div>
          </div>
          <div className={styles.field}>
            <label className={styles.label} htmlFor="outing-place">
              Lieu de départ
            </label>
            <input id="outing-place" className={styles.input} value={place} maxLength={80} onChange={(e) => setPlace(e.target.value)} placeholder="Une ville ou un secteur : Lyon, Paris et Île-de-France" />
          </div>
          <div className={styles.label}>Ambiance</div>
          <div className={styles.actionsRow}>
            {MOODS.map((m) => (
              <button key={m.value} type="button" className={styles.chipToggle} aria-pressed={mood === m.value} onClick={() => setMood(m.value)}>
                {m.label}
              </button>
            ))}
          </div>
          <div className={styles.label}>Jours préférés</div>
          <div className={styles.actionsRow}>
            {DAYS.map((d) => (
              <button key={d.value} type="button" className={styles.chipToggle} aria-pressed={days.includes(d.value)} onClick={() => setDays((cur) => toggle(cur, d.value))}>
                {d.label}
              </button>
            ))}
          </div>
          <div className={styles.label}>Fréquence</div>
          <div className={styles.actionsRow}>
            {FREQUENCIES.map((f) => (
              <button key={f.value} type="button" className={styles.chipToggle} aria-pressed={frequency === f.value} onClick={() => setFrequency(f.value)}>
                {f.label}
              </button>
            ))}
          </div>
          <p className={styles.hint}>{saved.otherParent ? `Ces critères restent privés : ${saved.otherParent} ne les voit pas.` : "Ces critères restent privés."}</p>
        </div>
      )}
      {save.error && <Notice tone="error">{save.error.kind === "server" ? "Les critères n'ont pas pu être enregistrés : ils restent à l'écran, réessayez." : save.error.message}</Notice>}
      {done && !save.error && <Notice tone="success">Critères enregistrés.</Notice>}
      <Button onClick={() => void submit()} loading={save.pending} disabled={!canSave}>
        Enregistrer
      </Button>
    </>
  );
}
