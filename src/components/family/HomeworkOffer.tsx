"use client";

import Link from "next/link";
import { Button, Notice } from "@/components/ui";
import styles from "./family.module.css";

/**
 * Carte « Préparer la semaine de devoirs avec l'aide Devoirs ? » (US-119 RF1) : elle apparaît sous le formulaire de tâche quand le titre parle de devoirs. La tâche est
 * déjà enregistrée ; « Oui » ouvre la préparation de la semaine de l'échéance, « Pas maintenant » revient à la liste.
 */
export function HomeworkOfferCard({ weekStart, onLater }: { weekStart: string; onLater: () => void }) {
  return (
    <div className={styles.form} role="group" aria-label="Aide Devoirs">
      <Notice tone="info">La tâche est enregistrée.</Notice>
      <div className={styles.confirmTitle}>Préparer la semaine de devoirs avec l&apos;aide Devoirs ?</div>
      <div className={styles.actionsRow}>
        <Button variant="ghost" onClick={onLater}>
          Pas maintenant
        </Button>
        <Link href={`/assistant/devoirs/preparer?semaine=${weekStart}`} className={styles.cta}>
          Oui
        </Link>
      </div>
    </div>
  );
}
