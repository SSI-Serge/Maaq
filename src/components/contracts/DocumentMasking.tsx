"use client";

import Link from "next/link";
import type { DocumentView } from "@/server/contracts/service";
import { frDate, TONE_CLASS } from "./ContractParts";
import styles from "./contracts.module.css";

/**
 * État d'anonymisation d'un document (US-136 RF7, US-137) : « Masquage en cours », « À vérifier », « Vérifié », « Lecture incertaine » ou « Illisible », avec l'accès à
 * l'aperçu du texte masqué. Rien n'est affiché tant que l'analyse n'est pas activée sur le contrat : le document n'est alors pas traité.
 */
export function DocumentMasking({ doc, contractId, analysisActive }: { doc: DocumentView; contractId: string; analysisActive: boolean }) {
  const m = doc.masking;
  const preview = `/contrats/${contractId}/documents/${doc.id}`;
  if (!analysisActive && (m.status === "pending" || m.status === "masking")) return null;

  const pill = (label: string, tone: keyof typeof TONE_CLASS) => <span className={`${styles.pill} ${TONE_CLASS[tone]}`}>{label}</span>;
  return (
    <div className={styles.maskingLine}>
      {(m.status === "pending" || m.status === "masking") && pill("Masquage en cours", "info")}
      {m.status === "to_verify" && pill("À vérifier", "warn")}
      {m.status === "uncertain" && pill("Lecture incertaine", "warn")}
      {m.status === "verified" && pill("Vérifié", "ok")}
      {m.status === "unreadable" && pill("Illisible", "warn")}
      {(m.status === "to_verify" || m.status === "uncertain") && (
        <Link className={styles.maskingLink} href={preview}>
          Vérifier le texte masqué ›
        </Link>
      )}
      {m.status === "verified" && (
        <>
          <span className={styles.docMeta}>
            Vérifié par {m.verifiedByFirstName ?? "un profil supprimé"}
            {m.verifiedAt ? ` le ${frDate(m.verifiedAt)}` : ""}
          </span>
          <Link className={styles.maskingLink} href={preview}>
            Revoir ›
          </Link>
        </>
      )}
      {m.status === "uncertain" && <span className={styles.docMeta}>La lecture est peu sûre : une fois le texte vérifié, MAAQ décidera si l&apos;analyse continue.</span>}
      {m.status === "unreadable" && <span className={styles.error}>Document illisible : reprenez une photo plus nette.</span>}
      {m.removedHealthPages > 0 && (
        <span className={styles.docMeta}>
          {m.removedHealthPages > 1 ? `${m.removedHealthPages} pages de relevé de soins ont été retirées de l'analyse.` : "Une page de relevé de soins a été retirée de l'analyse."}
        </span>
      )}
      {m.healthDoubt && <span className={styles.error}>Ce document contient peut-être des données de santé : ne déposez que vos documents contractuels. Retirez-le pour poursuivre.</span>}
    </div>
  );
}
