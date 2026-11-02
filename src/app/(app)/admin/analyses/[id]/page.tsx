"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AdminDialog, BackLink, PageHead, adminStyles as s } from "@/components/admin/AdminShell";
import { ErrorLine } from "@/components/auth/parts";
import { Button, Loading, Notice } from "@/components/ui";
import type { ReviewDetail } from "@/server/admin/reviews";

const when = (iso: string) => `${new Date(iso).toLocaleDateString("fr-FR")} à ${new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;
const PIECES = /(\[[A-Z]+_\d+\])|([\p{L}\p{N}][\p{L}\p{N}'’-]*)|([^\p{L}\p{N}[]+|\[)/gu;
const TOKEN_LABEL: Record<string, string> = { PERSONNE: "Personne", ADRESSE: "Adresse", EMAIL: "Email", TELEPHONE: "Téléphone", CONTRAT: "Contrat", IBAN: "IBAN", BIC: "BIC", RIB: "RIB", IMMATRICULATION: "Immatriculation", VIN: "Numéro de série", SECU: "Sécurité sociale", EMPLOYEUR: "Employeur", COMPTE: "Compte", IDENTIFIANT: "Identifiant", DONNEE: "Masque ajouté" };
const label = (token: string) => {
  const m = /^\[([A-Z]+)_(\d+)\]$/.exec(token);
  return m ? `${TOKEN_LABEL[m[1]] ?? m[1]} ${m[2]}` : token;
};

/** Texte masqué d'une page : jetons surlignés, passages mal lus par l'OCR en jaune, chaque mot touchable pour le masquer (US-138 RF2, RF3). */
function Text({ text, weak, onPick }: { text: string; weak: Set<string>; onPick: (word: string) => void }) {
  return (
    <p style={{ margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.7, overflowWrap: "anywhere" }}>
      {[...text.matchAll(PIECES)].map((m, i) =>
        m[1] ? (
          <mark key={i} style={{ background: "var(--primary-soft)", fontWeight: 700, fontSize: 12, borderRadius: 4, padding: "1px 5px" }}>
            {label(m[1])}
          </mark>
        ) : m[2] ? (
          <span key={i} onClick={() => onPick(m[2])} style={{ cursor: "pointer", background: weak.has(m[2].toLowerCase()) ? "var(--warning-bg)" : undefined, borderRadius: 3 }} title={weak.has(m[2].toLowerCase()) ? "Mal lu" : undefined}>
            {m[2]}
          </span>
        ) : (
          <span key={i}>{m[3]}</span>
        ),
      )}
    </p>
  );
}

/** Une demande « Analyse à valider » (US-138) : texte masqué par document, masques à ajouter, décision avec confirmation. */
export default function AdminReviewPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const query = useApiQuery<ReviewDetail>(`/api/admin/reviews/${id}`);
  const [latest, setLatest] = useState<ReviewDetail>();
  const [picked, setPicked] = useState<{ field: string; word: string } | null>(null);
  const [asking, setAsking] = useState<"continue" | "stop" | null>(null);
  const [done, setDone] = useState<"continue" | "stop" | null>(null);
  const mask = useApiMutation();
  const decide = useApiMutation();
  const review = latest ?? query.data;

  async function addMask(field: string, word: string) {
    const result = await mask.run<ReviewDetail>(`/api/admin/reviews/${id}/masks`, { method: "POST", body: { field, word } });
    if (result) {
      setLatest(result);
      setPicked(null);
    }
  }
  async function confirm() {
    if (!asking) return;
    const result = await decide.run<{ decision: "continue" | "stop" }>(`/api/admin/reviews/${id}/decision`, { method: "POST", body: { decision: asking } });
    if (result) {
      setAsking(null);
      setDone(result.decision);
    }
  }

  return (
    <>
      <BackLink href="/admin/analyses">Analyses à valider</BackLink>
      <PageHead title={review ? `Analyse à valider — ${review.category}` : "Analyse à valider"} lead={review ? `Documents supprimés le ${when(review.expiresAt)}. Sans décision d'ici là, la demande disparaît.` : undefined} />
      {query.loading && !review && <Loading slow={query.slow} />}
      {query.error && !review && (
        <Notice tone="info">
          {query.error.message} <Link href="/admin/analyses">Retour à la liste ›</Link>
        </Notice>
      )}
      {done && (
        <Notice tone="success">
          {done === "continue" ? "Décision enregistrée : l'analyse est lancée." : "Décision enregistrée : l'analyse est annulée et la famille est prévenue."}{" "}
          <button className={s.linkButton} onClick={() => router.replace("/admin/analyses")}>
            Retour à la liste
          </button>
        </Notice>
      )}
      {review && !done && (
        <div style={{ maxWidth: 820, display: "flex", flexDirection: "column", gap: 14 }}>
          <Notice tone="info">Vous voyez le texte masqué seulement. Les passages mal lus sont surlignés ; touchez un mot pour le masquer aussi.</Notice>
          {review.documentsDetail.map((doc) => {
            const weak = new Set(doc.weak);
            return (
              <section key={doc.field} className={s.panel}>
                <h2 className={s.panelTitle}>{doc.field}</h2>
                <p className={`${s.muted} ${s.small}`}>
                  {doc.pages} page{doc.pages > 1 ? "s" : ""} · lecture : {doc.confidencePct === null ? "inconnue" : `${doc.confidencePct} %`}
                </p>
                {doc.texts.map((page, index) => (
                  <div key={index} style={{ marginBottom: 10 }}>
                    <div className={`${s.muted} ${s.small}`}>Page {index + 1}</div>
                    {page.removed ? <p className={s.muted}>{page.text}</p> : <Text text={page.text} weak={weak} onPick={(word) => setPicked({ field: doc.field, word })} />}
                  </div>
                ))}
                {picked?.field === doc.field && (
                  <div className={s.row} style={{ padding: 10, background: "var(--bg-sunken)", borderRadius: 8 }}>
                    <span>
                      Masquer aussi « <strong>{picked.word}</strong> » ?
                    </span>
                    <Button loading={mask.pending} onClick={() => addMask(doc.field, picked.word)}>
                      Masquer aussi ce mot
                    </Button>
                    <Button variant="secondary" onClick={() => setPicked(null)}>
                      Annuler
                    </Button>
                  </div>
                )}
              </section>
            );
          })}
          <ErrorLine error={mask.error} />
          <p className={`${s.muted} ${s.small}`}>Masques ajoutés pendant cette vérification : {review.masksAdded}.</p>
          <div className={s.row}>
            <Button onClick={() => setAsking("continue")}>Poursuivre l&apos;analyse</Button>
            <Button variant="danger" onClick={() => setAsking("stop")}>
              Ne pas poursuivre
            </Button>
          </div>
        </div>
      )}
      {asking && (
        <AdminDialog title={asking === "continue" ? "Poursuivre l'analyse ?" : "Ne pas poursuivre ?"} onClose={() => !decide.pending && setAsking(null)}>
          <p>
            {asking === "continue"
              ? "Le texte masqué part à l'agent d'analyse. Cette décision est inscrite dans le journal d'administration."
              : "L'analyse est annulée : la famille verra que la lecture n'était pas assez fiable et la personne qui a transmis en sera prévenue. Cette décision est inscrite dans le journal d'administration."}
          </p>
          <ErrorLine error={decide.error} />
          <div className={s.row}>
            <Button variant="secondary" onClick={() => setAsking(null)} disabled={decide.pending}>
              Annuler
            </Button>
            <Button variant={asking === "stop" ? "danger" : "primary"} loading={decide.pending} onClick={confirm}>
              {asking === "continue" ? "Poursuivre" : "Ne pas poursuivre"}
            </Button>
          </div>
        </AdminDialog>
      )}
    </>
  );
}
