"use client";

import Link from "next/link";
import { useState } from "react";
import { appStyles as s } from "@/components/app/AppShell";
import { Notice } from "@/components/ui";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import type { ChildLinkCandidate } from "@/server/assistant/family";

const DECLINED = "maaq:child-link-no";

function declined(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(DECLINED) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function decline(userId: string) {
  try {
    localStorage.setItem(DECLINED, JSON.stringify([...new Set([...declined(), userId])]));
  } catch {
    // Sans stockage, « Non » vaut pour cet affichage.
  }
}

export const LINK_DONE = (firstName: string) => `Le profil de ${firstName} est relié à sa fiche. Vous pourrez changer ce lien dans Réglages › Membres.`;
export const LINK_DECLINED = "C'est noté. Vous pourrez relier ce profil plus tard dans Réglages › Membres.";

/** Le bandeau lui-même (maquette Invités v87, tweak « rattrapage ») : un bouton « Relier à [fiche] » par fiche enfant libre, et « Non ». */
export function ChildLinkCard({ candidate, busy, onLink, onNo }: { candidate: ChildLinkCandidate; busy: boolean; onLink: (memberId: string) => void; onNo: () => void }) {
  return (
    <div role="region" aria-label="Profil à relier" style={{ background: "var(--secondary-soft)", border: "1px solid var(--secondary)", borderRadius: "var(--radius)", padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.4 }}>{candidate.firstName} a son profil. Est-ce le profil d&apos;un de vos enfants ?</div>
      <div style={{ fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.45 }}>Relié à sa fiche, ce profil aura un espace adapté : la tâche des devoirs, ses exercices, son calendrier et seulement ses propres RDV.</div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {candidate.sheets.map((sheet) => (
          <button key={sheet.memberId} type="button" disabled={busy} onClick={() => onLink(sheet.memberId)} style={{ flex: 1, minHeight: 40, background: "var(--primary)", color: "var(--primary-ink)", border: "none", fontWeight: 700, fontSize: 13, borderRadius: 8, padding: 9 }}>
            Relier à {sheet.firstName}
          </button>
        ))}
        <button type="button" disabled={busy} onClick={onNo} style={{ minHeight: 40, background: "transparent", border: "1px solid var(--line)", color: "var(--ink)", fontWeight: 600, fontSize: 13, borderRadius: 8, padding: "9px 18px" }}>
          Non
        </button>
      </div>
    </div>
  );
}

/**
 * Rattrapage de S-56 pour les profils créés avant la question de l'invitation : tant qu'un invité secondaire actif n'est relié à aucune fiche et qu'il reste une fiche enfant
 * sans profil, les parents voient ce bandeau sur l'écran « Invités » et en haut de l'accueil de l'assistant. Le serveur ne rend rien aux autres profils.
 * « Non » est retenu sur l'appareil : la question n'y est plus reposée pour ce profil.
 */
export function ChildLinkBanner({ onLinked }: { onLinked?: () => void }) {
  const query = useApiQuery<{ candidates: ChildLinkCandidate[] }>("/api/family/child-link");
  const mutation = useApiMutation();
  const [message, setMessage] = useState<string | null>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const candidate = (query.data?.candidates ?? []).find((c) => !hidden.includes(c.userId) && !declined().includes(c.userId));

  async function link(memberId: string) {
    if (!candidate) return;
    const done = await mutation.run("/api/family/child-link", { method: "POST", body: { userId: candidate.userId, memberId } });
    if (done === undefined) return;
    setMessage(LINK_DONE(candidate.firstName));
    setHidden((h) => [...h, candidate.userId]);
    query.reload();
    onLinked?.();
  }
  function no() {
    if (!candidate) return;
    decline(candidate.userId);
    setHidden((h) => [...h, candidate.userId]);
    setMessage(LINK_DECLINED);
  }

  return (
    <>
      {message && (
        <div role="status" style={{ background: "var(--success-bg)", color: "var(--success)", borderRadius: 10, padding: "10px 14px", fontSize: 12, fontWeight: 600, lineHeight: 1.45 }}>
          {message}
        </div>
      )}
      {mutation.error && (
        <div role="alert" style={{ background: "var(--error-bg)", borderRadius: 10, padding: "10px 14px", fontSize: 12 }}>
          {mutation.error.kind === "server" ? "Le profil n'a pas pu être relié." : mutation.error.message}
        </div>
      )}
      {candidate && !message && <ChildLinkCard candidate={candidate} busy={mutation.pending} onLink={(id) => void link(id)} onNo={no} />}
    </>
  );
}

export interface ChildSheetOption {
  memberId: string;
  firstName: string;
  age: number | null;
}
type ChildSheet = ChildSheetOption;

/** Rappel affiché après le choix de la fiche (S-56) : sans genre, la fiche n'en porte pas. */
export const childImpact = (firstName: string) => `${firstName} verra la tâche des devoirs, ses exercices, son calendrier et seulement ses propres RDV. Pas de tchats des agents ni de catalogue.`;
export const CHILD_QUESTION_HELP =
  "Si vous répondez oui, votre enfant aura un espace adapté : la tâche des devoirs, ses exercices à partir de ses leçons, son calendrier, et seulement ses propres RDV. Il n'aura ni les tchats des agents ni le catalogue. Si vous répondez non, ce profil verra les RDV de toute la famille, comme tout invité.";

const chip = (on: boolean) => ({ padding: "8px 16px", borderRadius: 100, fontSize: 13, fontWeight: 600, border: `1px solid ${on ? "var(--primary)" : "var(--line)"}`, background: on ? "var(--primary)" : "transparent", color: on ? "var(--primary-ink)" : "var(--ink)" }) as const;

/**
 * « Est-ce un de vos enfants ? » (S-56, maquette Invités v87) : les impacts sont affichés avant toute réponse ; avec « Oui », le parent choisit la fiche de l'enfant
 * (rôle enfant, sans profil), et un rappel dit ce que l'enfant verra.
 */
export function ChildQuestion({ sheets, kid, sheet, onKid, onSheet }: { sheets: ChildSheet[]; kid: boolean | null; sheet: string | null; onKid: (kid: boolean) => void; onSheet: (memberId: string) => void }) {
  const chosen = sheets.find((x) => x.memberId === sheet);
  return (
    <>
      <div role="radiogroup" aria-label="Est-ce un de vos enfants ?" style={{ display: "flex", flexDirection: "column", gap: 6, borderTop: "1px solid var(--line)", paddingTop: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Est-ce un de vos enfants ?</div>
        <div style={{ fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.5, background: "var(--bg-sunken)", borderRadius: 8, padding: "9px 11px" }}>{CHILD_QUESTION_HELP}</div>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" role="radio" aria-checked={kid === true} onClick={() => onKid(true)} style={chip(kid === true)}>
            Oui
          </button>
          <button type="button" role="radio" aria-checked={kid === false} onClick={() => onKid(false)} style={chip(kid === false)}>
            Non
          </button>
        </div>
      </div>
      {kid && (
        <div role="radiogroup" aria-label="Quelle fiche est la sienne ?" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>Quelle fiche est la sienne ?</div>
          {sheets.map((x) => (
            <button
              key={x.memberId}
              type="button"
              role="radio"
              aria-checked={sheet === x.memberId}
              onClick={() => onSheet(x.memberId)}
              style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", borderRadius: 8, textAlign: "left", background: "var(--bg)", border: `${sheet === x.memberId ? 2 : 1}px solid ${sheet === x.memberId ? "var(--primary)" : "var(--line)"}` }}
            >
              <span style={{ flex: 1 }}>
                <span style={{ display: "block", fontSize: 13, fontWeight: 700 }}>{x.firstName}</span>
                <span style={{ display: "block", fontSize: 11, color: "var(--ink-soft)" }}>Enfant{x.age !== null ? ` · ${x.age} an${x.age > 1 ? "s" : ""}` : ""} · pas encore de profil</span>
              </span>
            </button>
          ))}
          {sheets.length > 0 ? (
            <span className={s.muted}>Seules les fiches au rôle « Enfant » sans profil sont proposées.</span>
          ) : (
            <Notice tone="info">
              Toutes les fiches au rôle « Enfant » ont déjà un profil. Ajoutez d&apos;abord la fiche de votre enfant dans <Link href="/assistant/membres">Réglages › Membres</Link>.
            </Notice>
          )}
          {chosen && (
            <div role="note" style={{ fontSize: 12, lineHeight: 1.5, background: "var(--secondary-soft)", borderRadius: 8, padding: "9px 11px" }}>
              {childImpact(chosen.firstName)}
            </div>
          )}
          {sheets.length > 0 && (
            <span className={s.muted}>
              Vous pourrez changer ce lien dans <Link href="/assistant/membres">Réglages › Membres</Link>.
            </span>
          )}
        </div>
      )}
    </>
  );
}
