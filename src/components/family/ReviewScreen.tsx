"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useApiMutation } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import { Loading, Notice, RetryNotice } from "@/components/ui";
import type { ReviewView } from "@/server/emotions/reviews";
import { shortDate } from "./format";
import styles from "./emotions.module.css";

/** Les deux étapes du parcours du dimanche, jamais affichées ensemble : le bilan de la semaine passée, puis le point de la semaine à venir (US-144, US-145). */
export function ReviewSteps({ current }: { current: "review" | "point" }) {
  return (
    <div className={styles.steps}>
      <Link href="/assistant/bilan" className={`${styles.step} ${current === "review" ? styles.stepOn : ""}`}>
        1 · Bilan
      </Link>
      <span aria-hidden style={{ color: "var(--ink-soft)", fontSize: 11 }}>
        ›
      </span>
      <Link href="/assistant/semaine" className={`${styles.step} ${current === "point" ? styles.stepOn : ""}`}>
        2 · Point
      </Link>
    </div>
  );
}

/**
 * Bilan de la semaine (US-144), étape 1 : le mot du partenaire, les cœurs reçus, ce que la famille a fait ensemble. Aucun chiffre, aucun nom de celui qui a fait. L'ouverture de l'écran
 * est un POST : la première fois, elle rattache et fige les mots du partenaire (US-143 RF8). Le point (étape 2) reste facultatif.
 */
export function ReviewScreen() {
  const mutation = useApiMutation();
  const [review, setReview] = useState<ReviewView | null>(null);
  const started = useRef(false);
  const run = mutation.run;

  async function openIt() {
    const result = await run<{ review: ReviewView }>("/api/family/review/open", { method: "POST", body: {} });
    if (result) setReview(result.review);
  }
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void openIt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const code = mutation.error?.body?.code;
  return (
    <AppShell title="Bilan de la semaine" back={{ href: "/assistant", label: "Assistant Famille" }} subtitle={review ? `Du ${shortDate(review.weekStart)} au ${shortDate(review.weekEnd)}` : undefined}>
      <ReviewSteps current="review" />
      {mutation.pending && !review && <Loading slow={false} label="Chargement du bilan…" />}
      {mutation.error && code === "no_review" && <Notice tone="info">Votre bilan n&apos;est pas encore prêt. Il arrive avec la notification du dimanche.</Notice>}
      {mutation.error && code === "forbidden" && (
        <Notice tone="info">
          Le bilan est réservé aux deux parents du couple. <Link href="/assistant/semaine">Voir le point de la semaine ›</Link>
        </Notice>
      )}
      {mutation.error && code !== "no_review" && code !== "forbidden" && (
        <RetryNotice message={mutation.error.kind === "server" ? "Le bilan n'a pas pu être chargé." : mutation.error.message} onRetry={() => void openIt()} />
      )}

      {review && (
        <>
          {review.notes.length > 0 && (
            <div className={styles.mot}>
              <div className={styles.kick}>Un mot de {review.partner}</div>
              {review.notes.map((n) => (
                <p key={n.id} className={styles.motText}>
                  {n.text}
                </p>
              ))}
            </div>
          )}
          {review.thanks.length > 0 && (
            <div className={`${styles.card} ${styles.cardGold}`}>
              <div className={styles.cardTitle}>{review.partner} vous remercie pour :</div>
              {review.thanks.map((t) => (
                <div key={`${t.kind}:${t.id}`} className={styles.line}>
                  <span className={styles.lineHeart}>♥</span>
                  {t.title}
                </div>
              ))}
            </div>
          )}
          {review.together.length > 0 && (
            <div className={styles.card}>
              <div className={styles.cardTitle}>Ce que vous avez fait ensemble</div>
              {review.together.map((t) => (
                <div key={`${t.kind}:${t.id}`} className={styles.line}>
                  <span className={styles.lineDone}>✓</span>
                  {t.title}
                </div>
              ))}
              {review.togetherMore && <div className={styles.noteMeta}>… et tout le reste</div>}
            </div>
          )}
          {review.quiet && <div className={styles.quiet}>Une semaine tranquille. Profitez-en.</div>}
          <Link href="/assistant/mot" className={styles.goldLink}>
            ✎ Un mot pour {review.partner}
          </Link>
          <Link href="/assistant/semaine" className={styles.primary}>
            Et la semaine qui vient ?
          </Link>
        </>
      )}
    </AppShell>
  );
}
