"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui";
import type { AdjustView } from "@/server/courses/menu-ia/adjust";
import { DishDetail } from "./MenuCard";
import styles from "./courses.module.css";

const CARD = { background: "var(--bg-raised)", border: "1px solid var(--line)", borderRadius: "var(--radius)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 6, fontSize: 14, lineHeight: 1.45 } as const;

/** « Poulet non acheté : Poulet yassa du mardi. » (CR-58) : un ingrédient ou plusieurs, plat par plat. */
const missingText = (d: AdjustView["dishes"][number]) => `${d.missing.join(", ")} non acheté${d.missing.length > 1 ? "s" : ""} : ${d.name} ${d.day === "express" ? "(plat express)" : `du ${d.day}`}.`;

/**
 * Ingrédients manquants après un ticket (CR-58, US-177) : « Ajuster le menu » demande à l'IA une proposition par plat, qu'on accepte ou refuse (« Garder le plat ») ; « Je l'achèterai plus tard »
 * ne redemande rien pour ce ticket. Un plat accepté remplace l'ancien dans le menu validé et la liste de courses est à valider de nouveau.
 */
export function AdjustCard({ view, busy, onAction }: { view: AdjustView; busy: boolean; onAction: (action: "later" | "propose" | "accept" | "refuse", key?: string) => Promise<boolean> }) {
  const [open, setOpen] = useState<string | null>(null);
  const accepted = Object.values(view.decided).includes("accepted");
  return (
    <div style={CARD}>
      <span style={{ fontFamily: "var(--font-serif, serif)", fontSize: 16 }}>Il manque des ingrédients · semaine du {view.weekLabel}</span>
      {view.dishes.map((d) => (
        <span key={d.key}>{missingText(d)}</span>
      ))}

      {view.status === "open" && (
        <>
          {view.failed && <span style={{ fontWeight: 700 }}>Je n&apos;ai pas réussi à proposer un ajustement pour le moment. Vous pouvez réessayer.</span>}
          {busy && <span className={styles.meta}>Je cherche des solutions avec ce que vous avez acheté… (jusqu&apos;à une minute)</span>}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {view.canAdjust && (
              <Button onClick={() => void onAction("propose")} loading={busy} disabled={busy}>
                Ajuster le menu
              </Button>
            )}
            <Button variant="secondary" disabled={busy} onClick={() => void onAction("later")}>
              Je l&apos;achèterai plus tard
            </Button>
          </div>
        </>
      )}
      {view.status === "later" && <span className={styles.meta}>D&apos;accord, je ne vous redemande rien pour ce ticket.</span>}

      {(view.status === "proposed" || view.status === "closed") &&
        view.proposals.map((p) => {
          const dish = view.dishes.find((d) => d.key === p.key);
          const decision = view.decided[p.key];
          return (
            <div key={p.key} style={{ borderTop: "1px solid var(--line)", paddingTop: 6, display: "flex", flexDirection: "column", gap: 4 }}>
              <span>
                <strong>{dish?.name}</strong> {dish?.day === "express" ? "(express)" : `du ${dish?.day}`} → <strong>{p.dish.name}</strong>
              </span>
              <span>{p.explanation}</span>
              <button type="button" className={styles.link} aria-expanded={open === p.key} onClick={() => setOpen(open === p.key ? null : p.key)} style={{ alignSelf: "flex-start", background: "none", border: "none", padding: 0 }}>
                {open === p.key ? "Masquer la recette" : "Voir la recette et les quantités"}
              </button>
              {open === p.key && <DishDetail dish={p.dish} />}
              {p.dish.warnings.map((w) => (
                <span key={w} style={{ fontSize: 12, fontWeight: 700 }}>
                  {w} · vérifiez avant d&apos;accepter
                </span>
              ))}
              {decision === undefined ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <Button disabled={busy} onClick={() => void onAction("accept", p.key)}>
                    Accepter
                  </Button>
                  <Button variant="secondary" disabled={busy} onClick={() => void onAction("refuse", p.key)}>
                    Garder le plat
                  </Button>
                </div>
              ) : (
                <span className={styles.meta}>{decision === "accepted" ? `Le plat ${dish?.day === "express" ? "express" : `du ${dish?.day}`} devient « ${p.dish.name} ».` : "Plat gardé."}</span>
              )}
            </div>
          );
        })}
      {accepted && (
        <Link href={`/courses/liste?week=${view.week}`} style={{ alignSelf: "flex-start", fontSize: 13, fontWeight: 700, color: "var(--success)", background: "var(--success-bg)", borderRadius: 8, padding: "10px 12px" }}>
          Menu mis à jour · Valider la liste de courses de nouveau ›
        </Link>
      )}
    </div>
  );
}
