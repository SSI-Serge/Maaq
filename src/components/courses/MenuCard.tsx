"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui";
import { ingredientText } from "@/server/courses/engine/quantities";
import { fmtMin } from "@/server/courses/engine/text";
import type { CardView } from "@/server/courses/menu-ia/cards";
import { recipeSteps } from "@/server/courses/menu-ia/entries";
import type { ProposalDish } from "@/server/courses/menu-ia/proposal";
import type { ReplaceChoice, ReplaceKind, ReplaceOptions } from "@/server/courses/menu-ia/replace";
import { DAY_LABELS, servingsText, sessionText } from "./menu-text";
import styles from "./courses.module.css";

const CARD_STYLE = { background: "var(--bg-raised)", border: "1px solid var(--line)", borderRadius: "var(--radius)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 2 } as const;
const TAG = { display: "inline-block", marginTop: 3, fontSize: 10, fontWeight: 700, borderRadius: 100, padding: "2px 8px" } as const;

/** Ce que « Remplacer » peut faire pour un plat (CR-57) : charger les plats proposés, puis remplacer ; rien n'est envoyé à l'IA. */
export interface ReplaceApi {
  options: (kind: ReplaceKind, index: number) => Promise<ReplaceOptions | null>;
  replace: (kind: ReplaceKind, index: number, choice: ReplaceChoice) => Promise<boolean>;
}

/** Détail d'un plat (CR-57) : ingrédients avec les quantités pour le foyer, puis recette. */
export function DishDetail({ dish }: { dish: ProposalDish }) {
  const steps = recipeSteps(dish.recipe);
  return (
    <div style={{ fontSize: 12, lineHeight: 1.5, padding: "4px 0 6px" }}>
      <div className={styles.meta} style={{ textTransform: "uppercase" }}>
        Ingrédients
      </div>
      <ul style={{ margin: 0, paddingLeft: 16 }}>
        {dish.ingredients.map((i) => (
          <li key={i.label}>
            {ingredientText(i)}
            {i.quantity === null && <span className={styles.meta}> · Quantité à vérifier</span>}
          </li>
        ))}
      </ul>
      <div className={styles.meta} style={{ textTransform: "uppercase", paddingTop: 4 }}>
        Recette
      </div>
      {steps.length ? (
        <ol style={{ margin: 0, paddingLeft: 18 }}>
          {steps.map((s, k) => (
            <li key={k}>{s}</li>
          ))}
        </ol>
      ) : (
        <p className={styles.meta} style={{ margin: 0 }}>
          Recette non renseignée.
        </p>
      )}
    </div>
  );
}

/** Les trois groupes de « Remplacer » : plats express du menu, autres plats du menu (échange de jour), Mes plats. */
function ReplacePanel({ kind, options, busy, onPick, onClose }: { kind: ReplaceKind; options: ReplaceOptions; busy: boolean; onPick: (choice: ReplaceChoice) => void; onClose: () => void }) {
  const group = (title: string, items: { key: string; label: string; choice: ReplaceChoice }[]) =>
    items.length > 0 && (
      <div>
        <div className={styles.meta} style={{ textTransform: "uppercase", paddingTop: 4 }}>
          {title}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, paddingTop: 4 }}>
          {items.map((i) => (
            <button key={i.key} type="button" disabled={busy} onClick={() => onPick(i.choice)} style={{ minHeight: 34, padding: "0 12px", borderRadius: 100, fontSize: 12, fontWeight: 700, border: "1px solid var(--line)", background: "var(--bg-raised)", color: "var(--ink)" }}>
              {i.label}
            </button>
          ))}
        </div>
      </div>
    );
  const empty = options.express.length === 0 && options.dinners.length === 0 && options.own.length === 0;
  return (
    <div role="group" aria-label="Remplacer ce plat" style={{ background: "var(--bg-sunken)", borderRadius: 8, padding: "8px 10px", margin: "4px 0 6px" }}>
      {group("Plats express du menu", options.express.map((e) => ({ key: `e${e.index}`, label: e.name, choice: { group: "express", index: e.index } })))}
      {group(kind === "dinner" ? "Autres plats du menu (ils échangent leur jour)" : "Dîners du menu (ils échangent leur place)", options.dinners.map((d) => ({ key: `d${d.index}`, label: `${DAY_LABELS[d.index] ?? ""} · ${d.name}`, choice: { group: "dinners", index: d.index } })))}
      {group("Mes plats", options.own.map((o) => ({ key: `o${o.id}`, label: o.name, choice: { group: "own", dishId: o.id } })))}
      {empty && <span className={styles.meta}>Aucun plat à proposer.</span>}
      <button type="button" className={styles.link} style={{ background: "none", border: "none", padding: "6px 0 0", display: "block" }} onClick={onClose}>
        Fermer
      </button>
    </div>
  );
}

function DishRow({ day, dish, kind, index, replacing }: { day: string; dish: ProposalDish; kind: ReplaceKind; index: number; replacing: { api: ReplaceApi; allowed: boolean } }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<ReplaceOptions | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  async function show() {
    if (options) return setOptions(null);
    setLoading(true);
    const result = await replacing.api.options(kind, index);
    setLoading(false);
    if (result) setOptions(result);
  }
  return (
    <div style={{ borderBottom: "1px solid var(--line)" }}>
    <div style={{ display: "flex", gap: 8, padding: "6px 0", fontSize: 13, alignItems: "flex-start" }}>
      <span style={{ width: 32, flexShrink: 0, color: "var(--ink-soft)" }}>{day}</span>
      <span style={{ flex: 1 }}>
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} style={{ display: "block", textAlign: "left", background: "none", border: "none", padding: 0, fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
          {dish.name} <span aria-hidden="true" className={styles.meta}>{open ? "⌃" : "⌄"}</span>
        </button>
        {dish.servedOn && <span style={{ ...TAG, background: "var(--secondary-soft)", color: "var(--ink)" }}>Déjà servi le {dish.servedOn} · vous pouvez le garder</span>}
        {dish.warnings.map((w) => (
          <span key={w} style={{ ...TAG, background: "var(--warning-bg)", color: "var(--ink)", border: "1px solid var(--warning)" }}>
            {w} · vérifiez avant de valider
          </span>
        ))}
        {dish.blockers.map((b) => (
          <span key={b} style={{ display: "block", marginTop: 4, fontSize: 12, fontWeight: 700, color: "var(--error)", background: "var(--error-bg)", borderRadius: 6, padding: "4px 8px" }}>
            {b}. Remplacez ce plat pour valider.
          </span>
        ))}
      </span>
      <span className={styles.meta} style={{ flexShrink: 0 }}>
        {fmtMin(dish.minutes)}
      </span>
      {replacing.allowed && (
        <button type="button" className={styles.link} aria-label={`Remplacer ${dish.name}`} disabled={loading} onClick={() => void show()} style={{ background: "none", border: "none", padding: 0, flexShrink: 0 }}>
          Remplacer
        </button>
      )}
    </div>
    {open && <DishDetail dish={dish} />}
    {options && (
      <ReplacePanel
        kind={kind}
        options={options}
        busy={busy}
        onClose={() => setOptions(null)}
        onPick={async (choice) => {
          setBusy(true);
          const done = await replacing.api.replace(kind, index, choice);
          setBusy(false);
          if (done) setOptions(null);
        }}
      />
    )}
    </div>
  );
}

/**
 * Menu de la semaine en carte dans le tchat (CR-42, CR-Tchat) : 7 dîners, 4 plats express, séance de batch. « Valider le menu » sous la carte tant qu'elle est ouverte ; « Menu remplacé »
 * quand un menu plus récent existe ; pas de bouton si le menu est incomplet ; un conflit d'allergie bloque la validation.
 */
export function MenuCard({ card, busy, onValidate, onAdd, replaceApi }: { card: CardView; busy: boolean; onValidate: (card: CardView) => void; onAdd: (card: CardView, slots: string[]) => Promise<string[] | null>; replaceApi?: ReplaceApi }) {
  const [confirming, setConfirming] = useState(false);
  const [showSession, setShowSession] = useState(false);
  const replacing = { api: replaceApi ?? { options: async () => null, replace: async () => false }, allowed: !!replaceApi && (card.status === "open" || card.status === "incomplete") };
  const [kept, setKept] = useState(false);
  const [ticked, setTicked] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const [addDone, setAddDone] = useState<string[] | null>(null);
  const p = card.proposal;
  const note = servingsText(p.householdSize);
  const blocking = [...p.dinners, ...p.express].filter((d) => d.blockers.length).map((d) => d.name);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ ...CARD_STYLE, opacity: card.status === "replaced" ? 0.55 : 1 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontFamily: "var(--font-serif, serif)", fontSize: 17 }}>Menu de la semaine</span>
          <span className={styles.meta}>{p.weekLabel}</span>
        </div>
        <div className={styles.meta} style={{ paddingTop: 6, textTransform: "uppercase" }}>
          {p.dinners.length} dîner{p.dinners.length > 1 ? "s" : ""}
        </div>
        {p.dinners.map((d, i) => (
          <DishRow key={`${i}-${d.name}`} day={DAY_LABELS[i] ?? ""} dish={d} kind="dinner" index={i} replacing={replacing} />
        ))}
        {p.express.length > 0 && (
          <>
            <div className={styles.meta} style={{ paddingTop: 8, textTransform: "uppercase" }}>
              {p.express.length} plat{p.express.length > 1 ? "s" : ""} express
            </div>
            {p.express.map((d, i) => (
              <DishRow key={`x${i}-${d.name}`} day="Exp." dish={d} kind="express" index={i} replacing={replacing} />
            ))}
          </>
        )}
        <div className={styles.meta} style={{ paddingTop: 8, textTransform: "uppercase" }}>
          Séance de batch
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.45 }}>{sessionText(p)}</div>
        <button type="button" className={styles.link} aria-expanded={showSession} onClick={() => setShowSession(!showSession)} style={{ alignSelf: "flex-start", background: "none", border: "none", padding: "4px 0" }}>
          {showSession ? "Masquer la séance de batch" : "Voir la séance de batch"}
        </button>
        {showSession && (
          <div style={{ fontSize: 12, lineHeight: 1.5, paddingBottom: 4 }}>
            {p.stepsStale && <div style={{ fontWeight: 700, background: "var(--warning-bg)", borderRadius: 6, padding: "4px 8px", marginBottom: 4 }}>Déroulé à mettre à jour : l&apos;IA le réécrira quand vous validerez le menu.</div>}
            {p.steps.length > 0 ? (
              <ol style={{ margin: 0, paddingLeft: 18 }}>
                {p.steps.map((s) => (
                  <li key={s.position}>
                    {s.text}
                    {(s.dish || s.minutes) && <span className={styles.meta}> · {[s.dish, s.minutes ? `${s.minutes} min` : null].filter(Boolean).join(" · ")}</span>}
                    {s.overlaps && <span className={styles.meta}> · en même temps que l&apos;étape {s.overlaps}</span>}
                  </li>
                ))}
              </ol>
            ) : p.planSteps.length > 0 ? (
              <ol style={{ margin: 0, paddingLeft: 18 }}>
                {p.planSteps.map((s, k) => (
                  <li key={k}>{s}</li>
                ))}
              </ol>
            ) : (
              <span className={styles.meta}>Pas de déroulé pour l&apos;instant : durée estimée.</span>
            )}
          </div>
        )}
        {p.session.overCap && <div style={{ marginTop: 4, fontSize: 12, fontWeight: 700, background: "var(--warning-bg)", borderRadius: 6, padding: "6px 8px" }}>Séance au-dessus de {fmtMin(p.session.cap)}.</div>}
        {note && <div style={{ marginTop: 4, fontSize: 12 }}>Recettes et quantités écrites pour {note.slice(5)}.</div>}
        <span className={styles.meta} style={{ paddingTop: 6, fontWeight: 700 }}>
          Pensez à vérifier les allergies du foyer avant de valider.
        </span>
        <span className={styles.meta}>Touchez un plat pour voir ses ingrédients et sa recette, ou « Remplacer » pour en changer sans passer par l&apos;IA.</span>
      </div>

      {card.status === "open" && !confirming && !kept && (
        <Button
          onClick={() => (card.replacesValidated ? setConfirming(true) : onValidate(card))}
          loading={busy}
          disabled={busy}
          style={{ alignSelf: "flex-start" }}
        >
          Valider le menu
        </Button>
      )}
      {card.status === "open" && confirming && (
        <div role="alertdialog" aria-label="Remplacer le menu validé" style={{ background: "var(--secondary-soft)", borderRadius: "var(--radius)", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8, fontSize: 14, lineHeight: 1.45 }}>
          <span>Un menu est déjà validé pour cette semaine. Le remplacer ? Votre liste de courses sera refaite : les produits déjà achetés et ceux ajoutés à la main sont gardés.</span>
          <div style={{ display: "flex", gap: 8 }}>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirming(false);
                setKept(true);
              }}
            >
              Garder l&apos;ancien
            </Button>
            <Button
              onClick={() => {
                setConfirming(false);
                onValidate(card);
              }}
              loading={busy}
            >
              Remplacer le menu
            </Button>
          </div>
        </div>
      )}
      {card.status === "open" && kept && <div style={{ ...CARD_STYLE, maxWidth: "92%", fontSize: 14, lineHeight: 1.45 }}>D&apos;accord, le menu déjà validé est gardé. Votre liste de courses ne change pas.</div>}
      {card.status === "replaced" && (
        <button type="button" disabled style={{ alignSelf: "flex-start", minHeight: 40, padding: "0 14px", borderRadius: 8, border: "1px dashed var(--line)", background: "var(--bg-sunken)", color: "var(--ink-soft)", fontSize: 13, fontWeight: 700 }}>
          Menu remplacé
        </button>
      )}
      {card.status === "incomplete" && blocking.length > 0 && (
        <button type="button" disabled style={{ alignSelf: "flex-start", minHeight: 40, padding: "0 14px", borderRadius: 8, border: "1px dashed var(--line)", background: "var(--bg-sunken)", color: "var(--ink-soft)", fontSize: 13, fontWeight: 700, textAlign: "left" }}>
          Valider le menu · remplacez d&apos;abord : {blocking.join(", ")}
        </button>
      )}
      {card.status === "incomplete" && blocking.length === 0 && !p.complete && <span className={styles.meta}>Menu incomplet : demandez les dîners qui manquent dans la conversation.</span>}
      {card.status === "validated" && (
        <Link href="/courses/liste" style={{ alignSelf: "flex-start", fontSize: 13, fontWeight: 700, color: "var(--success)", background: "var(--success-bg)", borderRadius: 8, padding: "10px 12px" }}>
          ✓ Menu validé · Ouvrir la liste de courses ›
        </Link>
      )}
      {card.status === "validated" && card.addable.length > 0 && addDone === null && (
        <div style={{ ...CARD_STYLE, gap: 4, fontSize: 14, lineHeight: 1.45 }}>
          <span>Menu enregistré. Ajouter ces plats à vos plats ?</span>
          {card.addable.map((a) => {
            const on = ticked.includes(a.slot);
            return (
              <button key={a.slot} type="button" role="checkbox" aria-checked={on} onClick={() => setTicked(on ? ticked.filter((s) => s !== a.slot) : [...ticked, a.slot])} style={{ display: "flex", alignItems: "center", gap: 10, background: "none", border: "none", padding: "6px 0", textAlign: "left", fontSize: 13, color: "var(--ink)" }}>
                <span style={{ width: 22, height: 22, flexShrink: 0, borderRadius: 5, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, color: "#FFFFFF", border: `2px solid ${on ? "var(--success)" : "var(--line)"}`, background: on ? "var(--success)" : "transparent" }}>{on ? "✓" : ""}</span>
                {a.name}
              </button>
            );
          })}
          <div style={{ display: "flex", gap: 8 }}>
            <Button variant="secondary" disabled={adding} onClick={async () => { setAdding(true); const done = await onAdd(card, []); setAdding(false); if (done) setAddDone([]); }}>
              Non merci
            </Button>
            <Button loading={adding} disabled={!ticked.length} onClick={async () => { setAdding(true); const done = await onAdd(card, ticked); setAdding(false); if (done) setAddDone(done); }}>
              Ajouter à mes plats
            </Button>
          </div>
        </div>
      )}
      {card.status === "validated" && addDone !== null && (
        <div style={{ ...CARD_STYLE, maxWidth: "92%", fontSize: 14, lineHeight: 1.45 }}>
          {addDone.length ? `C'est fait : ${addDone.join(", ")} ${addDone.length > 1 ? "entrent" : "entre"} dans « Mes plats », avec ingrédients, recette et durée.` : "D'accord, aucun plat ajouté à « Mes plats »."}
        </div>
      )}
    </div>
  );
}
