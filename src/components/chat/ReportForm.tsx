"use client";

import { useState } from "react";
import { useApiMutation } from "@/client/hooks";
import { ErrorLine } from "@/components/auth/parts";
import styles from "./chat.module.css";

const CATEGORIES = [
  { value: "incorrect_response", label: "Réponse incorrecte" },
  { value: "wrong_action", label: "Action erronée" },
  { value: "other", label: "Autre" },
] as const;

type Category = (typeof CATEGORIES)[number]["value"];

const MAX_COMMENT = 1000;

/** Signalement d'une erreur de l'agent : catégorie, commentaire facultatif (US-61 RF2, RF3). */
export function ReportForm({ agentId, messageRef, onCancel, onDone }: { agentId: string; messageRef: string; onCancel: () => void; onDone: () => void }) {
  const [category, setCategory] = useState<Category | null>(null);
  const [comment, setComment] = useState("");
  const report = useApiMutation();

  async function submit() {
    if (!category) return;
    const result = await report.run(`/api/chat/${agentId}/reports`, { method: "POST", body: { messageRef, category, comment: comment.trim() || undefined } });
    if (result) onDone();
  }

  return (
    <div className={styles.panel} role="group" aria-label="Signaler une erreur">
      <div className={styles.panelTitle}>Signaler une erreur</div>
      <div>
        <span className={styles.fieldLabel}>Catégorie</span>
        <div className={styles.chips} style={{ marginTop: 6 }}>
          {CATEGORIES.map((c) => (
            <button key={c.value} type="button" aria-pressed={category === c.value} className={`${styles.chip} ${category === c.value ? styles.chipOn : ""}`} onClick={() => setCategory(c.value)}>
              {c.label}
            </button>
          ))}
        </div>
      </div>
      <textarea
        className={styles.textarea}
        placeholder="Commentaire (facultatif)"
        aria-label="Commentaire"
        maxLength={MAX_COMMENT}
        value={comment}
        onChange={(event) => setComment(event.target.value)}
      />
      <div className={styles.counter}>
        {comment.length}/{MAX_COMMENT}
      </div>
      <ErrorLine error={report.error} onRetry={submit} />
      <div className={styles.buttons}>
        <button type="button" className={styles.secondary} disabled={report.pending} onClick={onCancel}>
          Annuler
        </button>
        <button type="button" className={styles.primary} disabled={!category || report.pending} onClick={submit}>
          {report.pending ? "Envoi…" : "Envoyer"}
        </button>
      </div>
    </div>
  );
}
