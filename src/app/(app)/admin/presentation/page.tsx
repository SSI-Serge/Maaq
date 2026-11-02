"use client";

import { useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { PageHead, adminStyles as s, formatDate } from "@/components/admin/AdminShell";
import { ErrorLine } from "@/components/auth/parts";
import { Button, Loading, Notice } from "@/components/ui";
import type { PresentationView } from "@/server/presentation/service";

interface AdminPresentation {
  view: PresentationView | null;
  updatedBy: string | null;
  missing: string[];
}

/**
 * Vidéo de présentation (US-140 RF9) : l'administrateur dépose le fichier vidéo (MP4, 15 Mo au plus), les sous-titres français (WebVTT), l'image d'aperçu, la durée affichée et la
 * transcription, sans livraison de l'application. Tant qu'aucune vidéo n'est configurée, l'écran « Découvrir MAAQ » n'est proposé à personne.
 */
export default function AdminPresentationPage() {
  const query = useApiQuery<AdminPresentation>("/api/admin/presentation");
  const [current, setCurrent] = useState<AdminPresentation>();
  const data = current ?? query.data;
  const [formKey, setFormKey] = useState(0);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<{ tone: "success" | "error"; text: string }>();
  const remove = useApiMutation();
  const [asking, setAsking] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(undefined);
    setPending(true);
    try {
      const response = await fetch("/api/admin/presentation", { method: "POST", body: new FormData(event.currentTarget), credentials: "same-origin" });
      const body = (await response.json().catch(() => null)) as (AdminPresentation & { error?: { message?: string } }) | null;
      if (!response.ok || !body) setMessage({ tone: "error", text: body?.error?.message ?? "Le dépôt n'a pas pu être enregistré." });
      else {
        setCurrent(body);
        setFormKey((k) => k + 1);
        setMessage({ tone: "success", text: "Présentation enregistrée. Les profils la voient tout de suite." });
      }
    } catch {
      setMessage({ tone: "error", text: "Le dépôt n'a pas pu être envoyé. Vérifiez votre connexion et réessayez." });
    } finally {
      setPending(false);
    }
  }

  async function removeAll() {
    const result = await remove.run<AdminPresentation>("/api/admin/presentation", { method: "DELETE" });
    if (result) {
      setCurrent(result);
      setAsking(false);
      setMessage({ tone: "success", text: "Présentation retirée. L'écran « Découvrir MAAQ » n'est plus proposé." });
    }
  }

  return (
    <>
      <PageHead
        title="Vidéo de présentation"
        lead="La vidéo « Découvrir MAAQ en 1 minute » est proposée une fois à chaque profil après son inscription, puis dans Réglages › Aide. Tant qu'aucune vidéo n'est configurée, personne ne la voit."
      />
      {query.loading && !data && <Loading slow={query.slow} />}
      <ErrorLine error={query.error} onRetry={query.reload} />
      {data && (
        <div style={{ maxWidth: 820 }}>
          {data.view ? (
            <section className={s.panel}>
              <h2 className={s.panelTitle}>Vidéo en place</h2>
              <video src={data.view.videoUrl} poster={data.view.posterUrl ?? undefined} controls preload="metadata" playsInline style={{ width: "100%", maxHeight: 360, background: "var(--bg-sunken)", borderRadius: 8 }}>
                <track kind="subtitles" srcLang="fr" label="Français" src={data.view.captionsUrl} default />
              </video>
              <p className={`${s.muted} ${s.small}`}>
                {data.view.sizeLabel}
                {data.view.durationLabel ? ` · ${data.view.durationLabel}` : ""} · mise à jour le {formatDate(data.view.updatedAt)}
              </p>
              {data.missing.length > 0 && <Notice tone="warning">Non renseigné : {data.missing.join(", ")}.</Notice>}
              {data.view.transcript && (
                <details>
                  <summary>Transcription</summary>
                  <p style={{ whiteSpace: "pre-wrap" }}>{data.view.transcript}</p>
                </details>
              )}
              <div className={s.row} style={{ marginTop: 12 }}>
                {!asking ? (
                  <button className={`${s.linkButton} ${s.dangerLink}`} onClick={() => setAsking(true)}>
                    Retirer la vidéo
                  </button>
                ) : (
                  <>
                    <span>Retirer la vidéo ? L&apos;écran ne sera plus proposé à personne.</span>
                    <Button variant="secondary" onClick={() => setAsking(false)} disabled={remove.pending}>
                      Annuler
                    </Button>
                    <Button variant="danger" onClick={() => void removeAll()} loading={remove.pending}>
                      Retirer
                    </Button>
                  </>
                )}
              </div>
              <ErrorLine error={remove.error} />
            </section>
          ) : (
            <Notice tone="info">Aucune vidéo n&apos;est configurée : l&apos;écran « Découvrir MAAQ » n&apos;est proposé à personne.</Notice>
          )}

          <form key={formKey} className={s.panel} onSubmit={submit}>
            <h2 className={s.panelTitle}>{data.view ? "Remplacer ou compléter" : "Déposer la vidéo"}</h2>
            <p className={`${s.muted} ${s.small}`}>
              {data.view ? "Ne choisissez que ce que vous voulez remplacer : le reste est conservé." : "Une première vidéo demande aussi ses sous-titres français."} Vidéo MP4 (H.264, 720p) de 15 Mo au plus ;
              sous-titres WebVTT (.vtt) ; image d&apos;aperçu JPEG, PNG ou WebP de 1 Mo au plus.
            </p>
            <label className={s.label} htmlFor="pres-video">
              Vidéo (MP4)
            </label>
            <input id="pres-video" name="video" type="file" accept="video/mp4,.mp4" />
            <label className={s.label} htmlFor="pres-captions" style={{ marginTop: 12 }}>
              Sous-titres français (WebVTT)
            </label>
            <input id="pres-captions" name="captions" type="file" accept=".vtt,text/vtt" />
            <label className={s.label} htmlFor="pres-poster" style={{ marginTop: 12 }}>
              Image d&apos;aperçu
            </label>
            <input id="pres-poster" name="poster" type="file" accept="image/jpeg,image/png,image/webp" />
            <label className={s.label} htmlFor="pres-duration" style={{ marginTop: 12 }}>
              Durée affichée (par exemple « 1 min 20 »)
            </label>
            <input id="pres-duration" name="durationLabel" className={s.input} style={{ maxWidth: 240 }} maxLength={30} defaultValue={data.view?.durationLabel ?? ""} />
            <label className={s.label} htmlFor="pres-transcript" style={{ marginTop: 12 }}>
              Texte de la vidéo : une phrase par ligne, avec son heure en début de ligne si vous voulez l&apos;afficher (par exemple « 0:15 Dites ou écrivez un rendez-vous… »)
            </label>
            <textarea id="pres-transcript" name="transcript" className={s.textarea} rows={8} maxLength={8000} defaultValue={data.view?.transcript ?? ""} />
            <div className={s.actions}>
              <Button type="submit" loading={pending}>
                {data.view ? "Enregistrer" : "Déposer"}
              </Button>
            </div>
            {message && <Notice tone={message.tone}>{message.text}</Notice>}
          </form>
        </div>
      )}
    </>
  );
}
