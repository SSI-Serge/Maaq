"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui";
import { fmtMin } from "@/server/courses/engine/text";
import type { CardView } from "@/server/courses/menu-ia/cards";
import type { ProposalDish } from "@/server/courses/menu-ia/proposal";
import { DAY_LABELS, servingsText, sessionText } from "./menu-text";
import styles from "./courses.module.css";

const CARD_STYLE = { background: "var(--bg-raised)", border: "1px solid var(--line)", borderRadius: "var(--radius)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 2 } as const;
const TAG = { display: "inline-block", marginTop: 3, fontSize: 10, fontWeight: 700, borderRadius: 100, padding: "2px 8px" } as const;

function DishRow({ day, dish }: { day: string; dish: ProposalDish }) {
  return (
    <div style={{ display: "flex", gap: 8, padding: "6px 0", borderBottom: "1px solid var(--line)", fontSize: 13, alignItems: "flex-start" }}>
      <span style={{ width: 32, flexShrink: 0, color: "var(--ink-soft)" }}>{day}</span>
      <span style={{ flex: 1 }}>
        <span style={{ display: "block", fontWeight: 600 }}>{dish.name}</span>
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
    </div>
  );
}

/**
 * Menu de la semaine en carte dans le tchat (CR-42, CR-Tchat) : 7 dîners, 4 plats express, séance de batch. « Valider le menu » sous la carte tant qu'elle est ouverte ; « Menu remplacé »
 * quand un menu plus récent existe ; pas de bouton si le menu est incomplet ; un conflit d'allergie bloque la validation.
 */
export function MenuCard({ card, busy, onValidate, onAdd }: { card: CardView; busy: boolean; onValidate: (card: CardView) => void; onAdd: (card: CardView, slots: string[]) => Promise<string[] | null> }) {
  const [confirming, setConfirming] = useState(false);
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
          <DishRow key={`${i}-${d.name}`} day={DAY_LABELS[i] ?? ""} dish={d} />
        ))}
        {p.express.length > 0 && (
          <>
            <div className={styles.meta} style={{ paddingTop: 8, textTransform: "uppercase" }}>
              {p.express.length} plat{p.express.length > 1 ? "s" : ""} express
            </div>
            <div style={{ fontSize: 12, lineHeight: 1.5 }}>{p.express.map((d) => d.name).join(" · ")}</div>
            {p.express.some((d) => d.blockers.length || d.warnings.length) && (
              <div style={{ fontSize: 12, fontWeight: 700 }}>
                {p.express.flatMap((d) => [...d.blockers, ...d.warnings.map((w) => `${d.name} : ${w}`)]).join(" ; ")}
              </div>
            )}
          </>
        )}
        <div className={styles.meta} style={{ paddingTop: 8, textTransform: "uppercase" }}>
          Séance de batch
        </div>
        <div style={{ fontSize: 13, lineHeight: 1.45 }}>{sessionText(p)}</div>
        {p.session.overCap && <div style={{ marginTop: 4, fontSize: 12, fontWeight: 700, background: "var(--warning-bg)", borderRadius: 6, padding: "6px 8px" }}>Séance au-dessus de {fmtMin(p.session.cap)}.</div>}
        {note && <div style={{ marginTop: 4, fontSize: 12 }}>Recettes et quantités écrites pour {note.slice(5)}.</div>}
        <span className={styles.meta} style={{ paddingTop: 6, fontWeight: 700 }}>
          Pensez à vérifier les allergies du foyer avant de valider.
        </span>
        <span className={styles.meta}>Ingrédients et recettes : dans la liste de courses, après validation.</span>
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
