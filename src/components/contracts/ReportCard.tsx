"use client";

import type { ContractView } from "@/server/contracts/service";
import { frDate } from "./ContractParts";
import styles from "./contracts.module.css";

/**
 * Rapport d'analyse en tête du détail du contrat (US-132 RF1) : « Analyse — [nom du contrat] — [date] ». Le HTML a été nettoyé par le serveur (balises de mise en forme seulement,
 * aucun attribut, aucun lien, aucun script) ; les prénoms des membres sont déjà résolus.
 */
export function ReportCard({ contract }: { contract: ContractView }) {
  if (!contract.report) return null;
  return (
    <section className={styles.report} aria-label="Rapport d'analyse">
      <h2 className={styles.reportTitle}>
        Analyse — {contract.name} — {frDate(contract.report.generatedAt)}
      </h2>
      <div className={styles.reportBody} dangerouslySetInnerHTML={{ __html: contract.report.html }} />
    </section>
  );
}
