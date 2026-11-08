"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import family from "@/components/family/family.module.css";
import { Button, Loading, Notice, RetryNotice } from "@/components/ui";
import type { DishForm } from "@/server/courses/menu/dishes";
import styles from "./courses.module.css";

const BACK = { href: "/courses", label: "Courses et repas" };

/** « Nouveau plat » (US-159) : un plat du foyer, vu de ce foyer seulement ; ou plusieurs plats d'un coup par un fichier CSV ou xlsx. */
export function CoursesDishFormScreen() {
  const query = useApiQuery<{ form: DishForm }>("/api/courses/dishes");
  const forbidden = query.error?.body?.code === "forbidden";
  return (
    <AppShell title="Nouveau plat" eyebrow="Courses et repas · Mes plats" back={BACK}>
      {query.loading && !query.data && <Loading slow={query.slow} />}
      {forbidden && <Notice tone="info">Les plats du foyer sont réservés aux deux parents du couple.</Notice>}
      {query.error && !forbidden && <RetryNotice message={query.error.message} onRetry={query.reload} />}
      {query.data && <Form form={query.data.form} reload={query.reload} />}
    </AppShell>
  );
}

function Form({ form, reload }: { form: DishForm; reload: () => void }) {
  const save = useApiMutation();
  const upload = useApiMutation();
  const [name, setName] = useState("");
  const [cuisine, setCuisine] = useState(0);
  const [ingredients, setIngredients] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [minutes, setMinutes] = useState("");
  const [recipe, setRecipe] = useState("");
  const [tried, setTried] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [imported, setImported] = useState<number | null>(null);
  const file = useRef<HTMLInputElement>(null);

  const missing = [!name.trim() && "le nom", !cuisine && "la cuisine", ingredients.length === 0 && "au moins un ingrédient"].filter(Boolean) as string[];

  function addIngredient() {
    const value = draft.trim();
    if (!value || ingredients.some((i) => i.toLowerCase() === value.toLowerCase())) return setDraft("");
    setIngredients([...ingredients, value]);
    setDraft("");
  }

  async function submit() {
    setTried(true);
    if (missing.length) return;
    const result = await save.run<{ dish: { name: string } }>("/api/courses/dishes", {
      method: "POST",
      body: { name: name.trim(), cuisineId: cuisine, ingredients, minutes: minutes.trim() ? Number(minutes) : null, recipe: recipe.trim() || null },
    });
    if (result) setSaved(result.dish.name);
  }

  async function onFile(chosen: File | undefined) {
    if (!chosen) return;
    setImported(null);
    const body = new FormData();
    body.append("file", chosen);
    const result = await upload.run<{ count: number }>("/api/courses/dishes/import", { method: "POST", body });
    if (file.current) file.current.value = "";
    if (result) {
      setImported(result.count);
      reload();
    }
  }

  if (saved) {
    return (
      <div className={styles.done} role="status">
        <span className={styles.tick} aria-hidden="true">
          ✓
        </span>
        <div className={styles.doneTitle}>{saved} est dans vos plats</div>
        <p className={styles.lead}>Il entre dans « Mes plats » et dans vos prochains menus.</p>
        <Link href="/courses?menu=1" className={styles.link}>
          Préparer le menu ›
        </Link>
      </div>
    );
  }

  const issues = ((upload.error?.body?.details as { issues?: string[] } | undefined)?.issues ?? []).slice(0, 20);

  return (
    <div className={family.form}>
      <div className={family.field}>
        <label className={family.label} htmlFor="pl-nom">
          Nom du plat
        </label>
        <input id="pl-nom" className={family.input} maxLength={80} placeholder="ex. Poulet yassa" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className={family.field}>
        <label className={family.label} htmlFor="pl-cuis">
          Cuisine
        </label>
        <select id="pl-cuis" className={family.select} value={cuisine} onChange={(e) => setCuisine(Number(e.target.value))}>
          <option value={0}>Choisir…</option>
          {form.cuisines.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </div>
      <div className={family.field}>
        <label className={family.label} htmlFor="pl-ing">
          Ingrédients
        </label>
        <div className={family.wrapRow}>
          {ingredients.map((i) => (
            <span key={i} className={family.chipToggle}>
              {i}
              <button type="button" aria-label={`Retirer ${i}`} className={styles.link} onClick={() => setIngredients(ingredients.filter((x) => x !== i))}>
                ×
              </button>
            </span>
          ))}
        </div>
        <div className={styles.addRow}>
          <input
            id="pl-ing"
            className={family.input}
            placeholder="ex. oignons"
            value={draft}
            maxLength={120}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addIngredient();
              }
            }}
          />
          <Button variant="ghost" onClick={addIngredient}>
            Ajouter
          </Button>
        </div>
      </div>
      {tried && missing.length > 0 && (
        <p role="alert" style={{ margin: 0, color: "var(--error)", fontWeight: 700, fontSize: 13 }}>
          Il manque {missing.join(", ")}.
        </p>
      )}
      <div className={family.field}>
        <label className={family.label} htmlFor="pl-dur">
          Durée <span style={{ fontWeight: 400 }}>· facultatif, en minutes</span>
        </label>
        <input id="pl-dur" className={family.input} style={{ width: 120 }} inputMode="numeric" placeholder="ex. 45" value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/\D/g, "").slice(0, 3))} />
      </div>
      <div className={family.field}>
        <label className={family.label} htmlFor="pl-rec">
          Recette <span style={{ fontWeight: 400 }}>· facultatif</span>
        </label>
        <textarea id="pl-rec" className={family.textarea} placeholder="Les étapes, en quelques lignes" value={recipe} maxLength={5000} onChange={(e) => setRecipe(e.target.value)} />
      </div>
      <p className={family.hint}>Ce plat reste propre à votre foyer : il n&apos;est vu par aucun autre foyer. Il apparaît dans « Mes plats ».</p>
      {save.error && <Notice tone="error">{save.error.message}</Notice>}

      <section className={styles.dayCard} aria-label="Plusieurs plats d'un coup">
        <div className={styles.lineName}>Plusieurs plats d&apos;un coup</div>
        <span className={styles.meta}>Un fichier CSV ou xlsx avec trois colonnes : plat, cuisine, ingrédients.</span>
        <div className={family.wrapRow}>
          <a className={styles.link} href="/api/courses/dishes/template" download>
            Télécharger le modèle
          </a>
          <button type="button" className={styles.link} onClick={() => file.current?.click()}>
            Importer un fichier
          </button>
          <input ref={file} type="file" hidden accept=".csv,.xlsx,text/csv" onChange={(e) => void onFile(e.target.files?.[0])} />
        </div>
        {upload.pending && <span className={styles.meta}>Vérification du fichier…</span>}
        {imported !== null && (
          <Notice tone="success">
            {imported} plat{imported > 1 ? "s" : ""} ajouté{imported > 1 ? "s" : ""} à vos plats.
          </Notice>
        )}
        {upload.error && (
          <Notice tone="error">
            {upload.error.message}
            {issues.map((i) => (
              <div key={i}>{i}</div>
            ))}
          </Notice>
        )}
      </section>
      {form.dishes.length > 0 && <p className={family.hint}>Vos plats : {form.dishes.map((d) => d.name).join(", ")}.</p>}

      <div className={styles.footer}>
        <Button block loading={save.pending} onClick={() => void submit()}>
          Ajouter à mes plats
        </Button>
      </div>
    </div>
  );
}
