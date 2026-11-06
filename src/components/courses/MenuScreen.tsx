"use client";

import Link from "next/link";
import { useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import family from "@/components/family/family.module.css";
import { Button, ButtonLink, Loading, Notice, RetryNotice } from "@/components/ui";
import type { MenuProposal, MenuStart, ValidatedMenu } from "@/server/courses/menu/service";
import styles from "./courses.module.css";

const BACK = { href: "/courses", label: "Courses et repas" };
const PAGE = 10;
const MAX_PICKS = 2;

const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** « Menu de la semaine » (US-155, US-156) : 1 ou 2 plats plaisir, puis le menu proposé autour d'eux, modifiable jour par jour, puis la validation. Réservé au couple. */
export function CoursesMenuScreen() {
  const query = useApiQuery<{ start: MenuStart }>("/api/courses/menu");
  const forbidden = query.error?.body?.code === "forbidden";
  return (
    <AppShell title="Menu de la semaine" eyebrow="Courses et repas" back={BACK}>
      {query.loading && !query.data && <Loading slow={query.slow} />}
      {forbidden && <Notice tone="info">Le menu de la semaine est réservé aux deux parents du couple.</Notice>}
      {query.error && !forbidden && <RetryNotice message={query.error.message} onRetry={query.reload} />}
      {query.data && <MenuFlow start={query.data.start} />}
    </AppShell>
  );
}

function MenuFlow({ start }: { start: MenuStart }) {
  const propose = useApiMutation();
  const [picks, setPicks] = useState<string[]>([]);
  const [menu, setMenu] = useState<MenuProposal | null>(null);
  const [done, setDone] = useState<ValidatedMenu | null>(null);

  if (start.missing.length > 0) {
    return (
      <Notice tone="info">
        Complétez d&apos;abord les <Link href="/courses/reglages">réglages du foyer</Link> : ville, nombre de personnes, jours de courses, cuisines et objectifs.
      </Notice>
    );
  }
  if (done) return <Done done={done} />;
  if (menu) return <MenuStep menu={menu} onDone={setDone} />;

  async function submit() {
    const result = await propose.run<{ menu: MenuProposal }>("/api/courses/menu/propose", { method: "POST", body: { picks, week: start.week } });
    if (result) setMenu(result.menu);
  }

  return <PickStep start={start} picks={picks} onPicks={setPicks} onSubmit={() => void submit()} pending={propose.pending} error={propose.error?.message} />;
}

function PickStep({ start, picks, onPicks, onSubmit, pending, error }: { start: MenuStart; picks: string[]; onPicks: (ids: string[]) => void; onSubmit: () => void; pending: boolean; error?: string }) {
  const [search, setSearch] = useState("");
  const [shown, setShown] = useState<Record<string, number>>({});
  const names = new Map(start.groups.flatMap((g) => g.dishes).map((d) => [d.id, d.name]));
  const query = fold(search.trim());

  const toggle = (id: string) => {
    if (picks.includes(id)) onPicks(picks.filter((p) => p !== id));
    else if (picks.length < MAX_PICKS) onPicks([...picks, id]);
  };
  const groups = start.groups
    .map((g) => ({ ...g, dishes: query ? g.dishes.filter((d) => fold(d.name).includes(query)) : g.dishes }))
    .filter((g) => g.dishes.length > 0);

  return (
    <>
      <p className={styles.lead}>Semaine du {start.weekLabel}. Choisissez 1 ou 2 plats qui vous font plaisir : le reste du menu se construit autour.</p>
      {start.validated && <Notice tone="info">Un menu est déjà validé pour cette semaine. Si vous le validez de nouveau, il remplace l&apos;ancien.</Notice>}
      <div className={family.field}>
        <label className={family.label} htmlFor="mn-search" style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
          Chercher un plat
        </label>
        <input id="mn-search" type="search" className={family.input} placeholder="Chercher un plat par son nom" value={search} onChange={(e) => setSearch(e.target.value)} />
      </div>
      <p className={styles.count} role="status">
        {picks.length === 0 ? "Aucun plat choisi" : `${picks.length} plat${picks.length > 1 ? "s" : ""} choisi${picks.length > 1 ? "s" : ""} : ${picks.map((id) => names.get(id)).join(", ")}`}
      </p>
      {groups.length === 0 && <p className={styles.empty}>Aucun plat ne correspond à « {search} ».</p>}
      {groups.map((g) => {
        const limit = query ? g.dishes.length : (shown[g.name] ?? PAGE);
        return (
          <section key={g.name} className={styles.group} aria-label={g.name}>
            <h2 className={styles.kick}>{g.name}</h2>
            <div className={family.wrapRow}>
              {g.dishes.slice(0, limit).map((d) => (
                <button key={d.id} type="button" className={family.chipToggle} aria-pressed={picks.includes(d.id)} onClick={() => toggle(d.id)}>
                  {d.name}
                </button>
              ))}
            </div>
            {!query && g.dishes.length > limit && (
              <button type="button" className={styles.more} onClick={() => setShown({ ...shown, [g.name]: limit + PAGE })}>
                Voir d&apos;autres plats ›
              </button>
            )}
          </section>
        );
      })}
      {error && <Notice tone="error">{error}</Notice>}
      <div className={styles.footer}>
        <Button block disabled={picks.length === 0} loading={pending} onClick={onSubmit}>
          Proposer le menu
        </Button>
      </div>
    </>
  );
}

function MenuStep({ menu, onDone }: { menu: MenuProposal; onDone: (v: ValidatedMenu) => void }) {
  const validate = useApiMutation();
  const [chosen, setChosen] = useState<string[]>(() => menu.days.map((d) => d.dish.id));
  const s = menu.session;
  const estimated = s.source === "estimation";

  async function submit() {
    const result = await validate.run<{ validated: ValidatedMenu }>("/api/courses/menu/validate", {
      method: "POST",
      body: { week: menu.week, picks: menu.picks.map((p) => p.id), dinners: chosen, express: menu.express.map((e) => e.id) },
    });
    if (result) onDone(result.validated);
  }

  return (
    <>
      <div className={`${styles.session} ${s.overCap ? styles.sessionOver : ""}`}>
        <div className={styles.sessionTitle}>Séance batch du dimanche : {s.label}{estimated ? " (durée estimée)" : ""}</div>
        <p className={styles.sessionText}>
          {estimated
            ? "Aucune semaine type ne convient : menu composé par ingrédients. Estimation : le plat le plus long, plus 40 % des autres."
            : `Semaine type « ${s.theme || "du catalogue"} »${s.percentShared != null ? `, ${s.percentShared} % d'ingrédients en commun` : ""}, du lundi au vendredi. Remplacer un plat change la durée.`}
        </p>
        {s.overCap && <span className={styles.sessionFlag}>Séance au-dessus de {s.capLabel}</span>}
      </div>
      {menu.servingsNote && <p className={styles.banner}>{menu.servingsNote}</p>}
      <h2 className={styles.kick}>7 dîners · changez un plat avec la liste</h2>
      {menu.days.map((d, i) => {
        const replaced = chosen[i] !== d.dish.id;
        const current = [d.dish, ...d.alternatives].find((x) => x.id === chosen[i]) ?? d.dish;
        const weekend = i >= 5;
        const state = weekend ? { text: "Hors séance", cls: "" } : !replaced && d.inSession ? { text: "Séance du dimanche", cls: styles.pillSession } : { text: "hors séance batch", cls: styles.pillOff };
        return (
          <div key={d.day} className={styles.dayCard}>
            <div className={styles.dayHead}>
              <span className={styles.dayName}>{d.day}</span>
              <span className={`${styles.pill} ${state.cls}`}>{state.text}</span>
            </div>
            <select className={family.select} aria-label={`Plat du ${d.day.toLowerCase()}`} value={chosen[i]} onChange={(e) => setChosen(chosen.map((c, k) => (k === i ? e.target.value : c)))}>
              <option value={d.dish.id}>★ {d.dish.name}</option>
              {d.alternatives.map((a) => (
                <option key={a.id} value={a.id}>
                  ↔ {a.name}
                </option>
              ))}
            </select>
            <span className={styles.meta}>{replaced ? `Remplacé : ${current.name}` : `${current.time}`}</span>
            {!replaced && d.confirmFrom && <span className={styles.confirm}>Plat du planning : « {d.confirmFrom} » (correspondance à confirmer)</span>}
          </div>
        );
      })}

      {s.steps.length > 0 && (
        <details className={styles.rub}>
          <summary>Séance batch du dimanche</summary>
          <div className={styles.rubBody}>
            <ol>
              {s.steps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
          </div>
        </details>
      )}
      <details className={styles.rub} open>
        <summary>
          {menu.express.length} plat{menu.express.length > 1 ? "s" : ""} express de secours
        </summary>
        <div className={styles.rubBody}>
          <ul>
            {menu.express.map((e) => (
              <li key={e.id}>
                {e.name} <span className={styles.meta}>⏱ {e.time} · {e.cuisine}</span>
              </li>
            ))}
          </ul>
          {menu.expressShort && (
            <p>
              Moins de 4 plats express pour vos cuisines. <Link href="/courses/plats/nouveau">Ajouter un plat express ›</Link>
            </p>
          )}
        </div>
      </details>
      {menu.recipes.length > 0 && (
        <details className={styles.rub}>
          <summary>Recettes</summary>
          <div className={styles.rubBody}>
            {menu.recipes.map((r) => (
              <div key={r.id} className={styles.recipe}>
                <div className={styles.recipeName}>{r.name}</div>
                <div>{r.text}</div>
              </div>
            ))}
          </div>
        </details>
      )}
      <p className={family.hint}>Vous pouvez aussi corriger le menu dans le tchat. Le filtrage des allergies et des régimes est indicatif.</p>
      {validate.error && <Notice tone="error">{validate.error.message}</Notice>}
      <div className={styles.footer}>
        <Button block loading={validate.pending} onClick={() => void submit()}>
          Valider le menu
        </Button>
      </div>
    </>
  );
}

function Done({ done }: { done: ValidatedMenu }) {
  return (
    <div className={styles.done} role="status">
      <span className={styles.tick} aria-hidden="true">
        ✓
      </span>
      <div className={styles.doneTitle}>Menu enregistré</div>
      <p className={styles.lead}>Semaine du {done.weekLabel}. Ses ingrédients sont dans la liste de courses.</p>
      <ButtonLink href="/courses/liste">Ouvrir la liste de courses</ButtonLink>
    </div>
  );
}
