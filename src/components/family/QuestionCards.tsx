"use client";

import { useState } from "react";
import { useApiMutation } from "@/client/hooks";
import { Button, Notice, RetryNotice } from "@/components/ui";
import type { AnticipationView, QuestionView } from "@/server/assistant/anticipation";
import { shortDate } from "./format";
import styles from "./family.module.css";

/**
 * Carte d'une question d'anticipation à trois choix (US-102 RF4, RF6, AT-6) : « Oui, c'est fait ou prévu », « Non, à faire » (une tâche est créée) et « Me le rappeler dans… »
 * (1, 3 ou 6 mois). Pendant l'enregistrement, les trois boutons sont désactivés (RF10) ; en cas d'erreur, la question reste posée avec « Réessayer » (RF11). La réponse d'un parent
 * vaut pour la famille : si l'autre parent a déjà répondu, la carte le dit et disparaît au rechargement.
 */
export function QuestionCard({ question, onAnswered }: { question: QuestionView; onAnswered: () => void }) {
  const mutation = useApiMutation();
  const [months, setMonths] = useState("3");
  const [last, setLast] = useState<{ answer: string; remindMonths?: number } | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function answer(body: { answer: "done_or_planned" | "todo" | "remind_later"; remindMonths?: number }) {
    setLast(body);
    const result = await mutation.run<{ result: { taskId: string | null } }>(`/api/family/anticipation/${question.id}/answer`, { method: "POST", body });
    if (!result) return;
    setDone(body.answer === "todo" ? "Tâche créée. Retrouvez-la dans Tâches." : body.answer === "done_or_planned" ? "C'est noté." : `Je vous le rappellerai dans ${body.remindMonths} mois.`);
    window.setTimeout(onAnswered, 1500);
  }

  const code = mutation.error?.body?.code;
  const busy = mutation.pending || done !== null;
  return (
    <div className={styles.proposalCard}>
      <div className={styles.proposalTitle}>{question.text}</div>
      <div className={styles.hint}>D&apos;ici le {shortDate(question.period.end)}</div>
      {done ? (
        <div className={`${styles.alert} ${styles.alertSuccess}`} role="status">
          ✓ {done}
        </div>
      ) : (
        <>
          <div className={styles.actions}>
            <Button onClick={() => void answer({ answer: "done_or_planned" })} loading={mutation.pending && last?.answer === "done_or_planned"} disabled={busy}>
              Oui, c&apos;est fait ou prévu
            </Button>
            <Button variant="secondary" onClick={() => void answer({ answer: "todo" })} loading={mutation.pending && last?.answer === "todo"} disabled={busy}>
              Non, à faire
            </Button>
            <div className={styles.actionsRow}>
              <select className={styles.select} value={months} onChange={(e) => setMonths(e.target.value)} aria-label="Me le rappeler dans" disabled={busy}>
                <option value="1">Me le rappeler dans 1 mois</option>
                <option value="3">Me le rappeler dans 3 mois</option>
                <option value="6">Me le rappeler dans 6 mois</option>
              </select>
              <Button variant="ghost" onClick={() => void answer({ answer: "remind_later", remindMonths: Number(months) })} loading={mutation.pending && last?.answer === "remind_later"} disabled={busy}>
                OK
              </Button>
            </div>
          </div>
          {mutation.error && code === "already_handled" && (
            <Notice tone="info">
              Cette question a déjà reçu une réponse de l&apos;autre parent.{" "}
              <button type="button" className={styles.undo} onClick={onAnswered}>
                Actualiser
              </button>
            </Notice>
          )}
          {mutation.error && code !== "already_handled" && (mutation.error.kind === "rejected" ? <Notice tone="error">{mutation.error.message}</Notice> : <RetryNotice message={mutation.error.kind === "server" ? "La réponse n'a pas pu être enregistrée. La question reste posée." : mutation.error.message} onRetry={() => last && void answer(last as never)} />)}
          {mutation.slow && <Notice tone="info">Toujours en cours…</Notice>}
        </>
      )}
    </div>
  );
}

const skipKey = (memberId: string) => `maaq-birth-skip-${memberId}`;

/**
 * « Indiquez le mois et l'année de naissance de Léo pour recevoir les rappels adaptés à son âge. » (US-102 RF7) : champ mois et année, « Enregistrer » et « Pas maintenant ».
 * Après « Pas maintenant », la carte dit qu'aucun rappel lié à l'âge ne sera proposé ; ce choix est gardé sur cet appareil.
 */
export function BirthCard({ memberId, firstName, onSaved }: { memberId: string; firstName: string; onSaved: () => void }) {
  const mutation = useApiMutation();
  const [value, setValue] = useState("");
  // La carte n'apparaît qu'après le chargement de la section : le stockage de l'appareil se lit à la création, sans effet.
  const [skipped, setSkipped] = useState(() => {
    try {
      return window.localStorage.getItem(skipKey(memberId)) === "1";
    } catch {
      return false; // stockage indisponible : la carte reste proposée
    }
  });

  async function save() {
    const result = await mutation.run(`/api/family/members/${memberId}`, { method: "PATCH", body: { birth: value } });
    if (result !== undefined) onSaved();
  }

  if (skipped) return <div className={styles.hint}>Aucun rappel lié à l&apos;âge de {firstName} ne sera proposé.</div>;
  return (
    <div className={styles.proposalCard}>
      <div className={styles.proposalTitle}>Indiquez le mois et l&apos;année de naissance de {firstName} pour recevoir les rappels adaptés à son âge.</div>
      <input type="month" className={styles.input} value={value} onChange={(e) => setValue(e.target.value)} aria-label={`Mois et année de naissance de ${firstName}`} disabled={mutation.pending} />
      <div className={styles.actionsRow}>
        <Button
          variant="ghost"
          onClick={() => {
            try {
              window.localStorage.setItem(skipKey(memberId), "1");
            } catch {
              /* ignoré */
            }
            setSkipped(true);
          }}
          disabled={mutation.pending}
        >
          Pas maintenant
        </Button>
        <Button onClick={() => void save()} loading={mutation.pending} disabled={!/^\d{4}-\d{2}$/.test(value) || mutation.pending}>
          Enregistrer
        </Button>
      </div>
      {mutation.error && <Notice tone="error">{mutation.error.kind === "rejected" ? mutation.error.message : "La naissance n'a pas pu être enregistrée. Réessayez."}</Notice>}
    </div>
  );
}

/** Les questions et cartes de naissance d'une section « À anticiper » ; rien si la famille a désactivé le catalogue (RF9). */
export function AnticipationCards({ data, onChanged }: { data: AnticipationView; onChanged: () => void }) {
  return (
    <>
      {data.birthCards.map((b) => (
        <BirthCard key={b.memberId} memberId={b.memberId} firstName={b.firstName} onSaved={onChanged} />
      ))}
      {data.questions.map((q) => (
        <QuestionCard key={q.id} question={q} onAnswered={onChanged} />
      ))}
    </>
  );
}
