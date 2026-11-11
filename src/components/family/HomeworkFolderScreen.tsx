"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell, Section } from "@/components/app/AppShell";
import { Button, Loading, Notice, RetryNotice } from "@/components/ui";
import type { PageFolder, PageSummary } from "@/server/assistant/homework/pages";
import { plainDate } from "./format";
import styles from "./family.module.css";

/** « Les fractions — 10/11/2026 », et « · créée par Camille » quand un parent l'a créée pour l'enfant (US-180 RF7). */
export const pageLabel = (p: PageSummary) => `${p.theme} — ${plainDate(p.created)}`;

/**
 * Dossier « Exercices » des parents (US-180 RF7) : les pages rangées par enfant, de la plus récente à la plus ancienne. Une page ouverte montre l'énoncé, la fiche réponse et le
 * barème. Un parent supprime une page après confirmation : elle disparaît pour les deux parents et pour l'enfant.
 */
export function HomeworkFolderScreen() {
  const folder = useApiQuery<{ folder: PageFolder }>("/api/family/homework/pages");
  const remove = useApiMutation();
  const [asking, setAsking] = useState<{ id: string; label: string; firstName: string } | null>(null);
  const [toast, setToast] = useState(false);
  const data = folder.data?.folder;

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(false), 3000);
    return () => clearTimeout(timer);
  }, [toast]);

  async function confirm() {
    if (!asking) return;
    if ((await remove.run(`/api/family/homework/pages/${asking.id}`, { method: "DELETE" })) !== undefined) {
      setAsking(null);
      setToast(true);
      folder.reload();
    }
  }

  return (
    <AppShell title="Dossier « Exercices »" eyebrow="Préparer les devoirs" back={{ href: "/assistant/devoirs/tache", label: "Préparer les devoirs" }}>
      {folder.loading && !data && <Loading slow={folder.slow} />}
      {folder.error && <RetryNotice message={folder.error.kind === "server" ? "Le dossier n'a pas pu être chargé." : folder.error.message} onRetry={folder.reload} />}
      {data?.role === "child" && <Notice tone="info">Le dossier « Exercices » est réservé aux parents.</Notice>}
      {data?.role === "parent" && (
        <>
          <p className={styles.hint}>
            Les pages d&apos;exercices des enfants, de la plus récente à la plus ancienne. Chaque page montre l&apos;énoncé, la fiche réponse et le barème. Elles sont supprimées 12 mois après leur création.
          </p>
          {data.children.map((k) => (
            <Section key={k.memberId} title={k.firstName}>
              {k.pages.length === 0 && <p className={styles.hint}>Aucune page pour l&apos;instant.</p>}
              {k.pages.map((p) => (
                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 0", borderBottom: "1px solid var(--line)" }}>
                  <Link href={`/assistant/devoirs/exercices/${p.id}`} style={{ flex: 1, fontSize: 13, fontWeight: 600, color: "var(--ink)", textDecoration: "none" }}>
                    {pageLabel(p)}
                    {p.createdBy ? ` · créée par ${p.createdBy}` : ""}
                  </Link>
                  <button type="button" className={styles.iconButton} aria-label={`Supprimer la page « ${pageLabel(p)} »`} onClick={() => setAsking({ id: p.id, label: pageLabel(p), firstName: k.firstName })}>
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                      <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
                    </svg>
                  </button>
                </div>
              ))}
            </Section>
          ))}
        </>
      )}
      {asking && (
        <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(43, 33, 31, 0.5)", display: "grid", placeItems: "center", padding: 20 }}>
          <div role="alertdialog" aria-modal="true" aria-label="Supprimer la page" className={styles.form} style={{ maxWidth: 420, borderTop: "5px solid var(--error)", background: "var(--bg-raised)" }}>
            <div className={styles.confirmTitle}>Supprimer la page</div>
            <p className={styles.confirmText}>
              Supprimer la page « {asking.label} » de {asking.firstName} ? Elle est supprimée pour les deux parents, et {asking.firstName} ne la verra plus. C&apos;est définitif.
            </p>
            {remove.error && <Notice tone="error">{remove.error.kind === "server" ? "La page n'a pas pu être supprimée." : remove.error.message}</Notice>}
            <div className={styles.actionsRow}>
              <Button variant="ghost" onClick={() => setAsking(null)} disabled={remove.pending}>
                Annuler
              </Button>
              <Button variant="danger" onClick={() => void confirm()} loading={remove.pending}>
                Supprimer
              </Button>
            </div>
          </div>
        </div>
      )}
      {toast && (
        <p className={styles.banner} role="status">
          Page supprimée.
        </p>
      )}
    </AppShell>
  );
}
