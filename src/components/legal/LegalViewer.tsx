"use client";

import { useState } from "react";
import { useApiQuery } from "@/client/hooks";
import { Loading, RetryNotice } from "@/components/ui";
import type { LegalDocument } from "@/server/compliance/legal";
import styles from "./legal.module.css";

const TITLES: Record<LegalDocument["type"], { tab: string; title: string }> = {
  privacy_policy: { tab: "Confidentialité", title: "Politique de confidentialité" },
  terms_of_use: { tab: "Conditions d'utilisation", title: "Conditions d'utilisation" },
};

const longDate = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" });

/**
 * Les deux documents juridiques en vigueur, sur deux onglets, chacun avec sa date de dernière mise à jour
 * (US-54 RF1, RF2). Fonctionne sans être connecté.
 */
export function LegalViewer({ initial = "privacy_policy", highlight = [] }: { initial?: LegalDocument["type"]; highlight?: string[] }) {
  const documents = useApiQuery<{ documents: LegalDocument[] }>("/api/legal");
  const [tab, setTab] = useState<LegalDocument["type"]>(initial);
  const list = documents.data?.documents ?? [];
  const current = list.find((d) => d.type === tab);

  return (
    <div className={styles.viewer}>
      <div className={styles.tabs} role="tablist">
        {(Object.keys(TITLES) as LegalDocument["type"][]).map((type) => (
          <button key={type} role="tab" type="button" aria-selected={tab === type} className={`${styles.tab} ${tab === type ? styles.tabOn : ""}`} onClick={() => setTab(type)}>
            {TITLES[type].tab}
            {highlight.includes(type) && <span className={styles.dot} aria-label="Nouvelle version" />}
          </button>
        ))}
      </div>
      {documents.loading && !documents.data && <Loading slow={documents.slow} />}
      {documents.error && !documents.data && <RetryNotice message={documents.error.message} onRetry={documents.reload} />}
      {documents.data && !current && <p className={styles.muted}>Ce document n&apos;est pas encore disponible.</p>}
      {current && (
        <article className={styles.document}>
          <h2>{TITLES[current.type].title}</h2>
          <p className={styles.muted}>
            Version {current.label} — dernière mise à jour le {longDate.format(new Date(current.publishedAt))}
          </p>
          <div className={styles.text}>{current.content}</div>
        </article>
      )}
    </div>
  );
}
