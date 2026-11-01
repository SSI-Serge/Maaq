"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import { useSessionUser } from "@/components/auth/AuthGate";
import { ErrorLine } from "@/components/auth/parts";
import { Button, Loading, Notice, RetryNotice } from "@/components/ui";
import type { MaskedPreview as Preview } from "@/server/contracts/process";
import { frDate } from "./ContractParts";
import styles from "./contracts.module.css";

const TOKEN_LABEL: Record<string, string> = {
  PERSONNE: "Personne", ADRESSE: "Adresse", EMAIL: "Email", TELEPHONE: "Téléphone", CONTRAT: "Contrat", IBAN: "IBAN", BIC: "BIC", RIB: "RIB", IMMATRICULATION: "Immatriculation",
  VIN: "Numéro de série", SECU: "Sécurité sociale", EMPLOYEUR: "Employeur", COMPTE: "Compte", DONNEE: "Masque ajouté",
};
const PIECES = /(\[[A-Z]+_\d+\])|([\p{L}\p{N}][\p{L}\p{N}'’-]*)|([^\p{L}\p{N}\[]+|\[)/gu;

/** « [PERSONNE_1] » → « Personne 1 » (US-137 RF2). */
export function tokenLabel(token: string): string {
  const m = /^\[([A-Z]+)_(\d+)\]$/.exec(token);
  return m ? `${TOKEN_LABEL[m[1]] ?? m[1]} ${m[2]}` : token;
}

/** Aperçu du texte masqué d'un document (maquette à créer, US-137) : jetons surlignés, « Masquer aussi ce mot », annulation d'un masque posé à la main, « Confirmer ce document ». */
export function MaskedPreview({ contractId, documentId }: { contractId: string; documentId: string }) {
  const user = useSessionUser();
  const router = useRouter();
  const allowed = user.role === "primary_user" || user.guestRank === "core";
  const query = useApiQuery<Preview>(allowed ? `/api/contracts/documents/${documentId}/masked` : null);
  const [latest, setLatest] = useState<Preview>();
  const [picked, setPicked] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const edit = useApiMutation();
  const confirm = useApiMutation();

  useEffect(() => {
    if (!allowed) router.replace("/accueil");
  }, [allowed, router]);
  if (!allowed) return null;

  const preview = latest ?? query.data;
  const editable = preview?.status === "to_verify" || preview?.status === "uncertain";

  async function mask(word: string) {
    const result = await edit.run<Preview>(`/api/contracts/documents/${documentId}/masks`, { method: "POST", body: { word } });
    if (result) {
      setLatest(result);
      setPicked(null);
      setTyped("");
    }
  }
  async function unmask(token: string) {
    const result = await edit.run<Preview>(`/api/contracts/documents/${documentId}/masks`, { method: "DELETE", body: { token } });
    if (result) setLatest(result);
  }
  async function verify() {
    const result = await confirm.run<Preview>(`/api/contracts/documents/${documentId}/verify`, { method: "POST" });
    if (result) setLatest(result);
  }

  /** Un appui sur un mot du texte le propose au masquage ; les jetons, eux, ne se choisissent pas. */
  function onText(event: React.MouseEvent<HTMLDivElement>) {
    const word = (event.target as HTMLElement).dataset.word;
    if (word && editable) setPicked(word);
  }

  return (
    <AppShell title="Texte masqué" subtitle={preview?.fileName} back={{ href: `/contrats/${contractId}`, label: "Contrat" }}>
      {query.loading && !preview && <Loading slow={query.slow} />}
      {query.error && !preview && (query.error.kind === "rejected" ? <Notice tone="info">{query.error.message} <Link href={`/contrats/${contractId}`}>Retour au contrat ›</Link></Notice> : <RetryNotice message={query.error.message} onRetry={query.reload} />)}
      {preview && (
        <div className={styles.detail}>
          <Notice tone="info">Vérifiez qu&apos;aucune donnée personnelle ne reste visible. Touchez un mot pour le masquer.</Notice>
          {preview.removedHealthPages > 0 && <div className={styles.hint}>{preview.removedHealthPages > 1 ? `${preview.removedHealthPages} pages de relevé de soins ont été retirées de l'analyse.` : "Une page de relevé de soins a été retirée de l'analyse."}</div>}
          {preview.residual.length > 0 && editable && (
            <Notice tone="warning">Il reste peut-être des données personnelles : {preview.residual.join(", ")}. Touchez le mot concerné pour le masquer.</Notice>
          )}
          {preview.healthDoubt && <Notice tone="warning">Ce document contient peut-être des données de santé : il ne peut pas être confirmé. Retirez-le du contrat.</Notice>}

          <div className={styles.maskedDoc} onClick={onText}>
            {preview.pages.map((page, index) => (
              <section key={index} className={styles.maskedPage}>
                <div className={styles.maskedPageNumber}>Page {index + 1}</div>
                {page.removed ? <p className={styles.hint}>{page.text}</p> : <MaskedText text={page.text} picked={picked} />}
              </section>
            ))}
          </div>

          {editable && (
            <form
              className={styles.maskForm}
              onSubmit={(event) => {
                event.preventDefault();
                if (typed.trim()) void mask(typed.trim());
              }}
            >
              <label className={styles.hint} htmlFor="mask-word">
                Un mot ou une expression à masquer
              </label>
              <div className={styles.maskRow}>
                <input id="mask-word" className={styles.maskInput} value={typed} maxLength={60} onChange={(event) => setTyped(event.target.value)} />
                <Button type="submit" variant="secondary" loading={edit.pending && picked === null} disabled={!typed.trim() || edit.pending}>
                  Masquer
                </Button>
              </div>
            </form>
          )}

          {preview.manual.length > 0 && (
            <div className={styles.panel}>
              <div className={styles.docName}>Masques ajoutés</div>
              {preview.manual.map((m) => (
                <div key={m.token} className={styles.maskRow}>
                  <span className={styles.docMeta}>
                    {tokenLabel(m.token)} · {m.occurrences > 1 ? `${m.occurrences} occurrences` : "1 occurrence"}
                  </span>
                  {editable && (
                    <button type="button" className={styles.maskingLink} disabled={edit.pending} onClick={() => void unmask(m.token)}>
                      Annuler ce masque
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
          <ErrorLine error={edit.error} />

          {editable ? (
            <>
              <Button onClick={verify} loading={confirm.pending} disabled={preview.healthDoubt || confirm.pending || edit.pending}>
                Confirmer ce document
              </Button>
              <ErrorLine error={confirm.error} onRetry={verify} />
            </>
          ) : (
            <Notice tone="success">
              Vérifié par {preview.verifiedByFirstName ?? "un profil supprimé"}
              {preview.verifiedAt ? ` le ${frDate(preview.verifiedAt)}` : ""}.
            </Notice>
          )}
          <Link href={`/contrats/${contractId}`}>‹ Retour au contrat</Link>
        </div>
      )}

      {picked && editable && (
        <div className={styles.maskBar} role="dialog" aria-label="Masquer ce mot">
          <span>
            Masquer aussi « <strong>{picked}</strong> » ?
          </span>
          <div className={styles.maskRow}>
            <Button onClick={() => void mask(picked)} loading={edit.pending} disabled={edit.pending}>
              Masquer aussi ce mot
            </Button>
            <Button variant="secondary" onClick={() => setPicked(null)} disabled={edit.pending}>
              Annuler
            </Button>
          </div>
        </div>
      )}
    </AppShell>
  );
}

/** Le texte d'une page : les jetons surlignés, chaque autre mot touchable. */
function MaskedText({ text, picked }: { text: string; picked: string | null }) {
  return (
    <p className={styles.maskedText}>
      {[...text.matchAll(PIECES)].map((m, index) =>
        m[1] ? (
          <mark key={index} className={styles.maskedToken}>
            {tokenLabel(m[1])}
          </mark>
        ) : m[2] ? (
          <span key={index} data-word={m[2]} className={`${styles.maskedWord} ${picked && m[2].toLowerCase() === picked.toLowerCase() ? styles.maskedPicked : ""}`}>
            {m[2]}
          </span>
        ) : (
          <span key={index}>{m[3]}</span>
        ),
      )}
    </p>
  );
}
