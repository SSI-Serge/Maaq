"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { useApiQuery } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import { Loading, Notice, RetryNotice } from "@/components/ui";
import type { HomeworkToday } from "@/server/assistant/homework/weeks";
import { shrink } from "./HomeworkPhotoPanel";
import s from "./homework-page.module.css";
import styles from "./family.module.css";

/** Textes de l'écran : l'enfant est tutoyé, le parent vouvoyé (US-180 RF2, RF6, RF9bis). Les messages d'erreur viennent du serveur, dans le même ton. */
const TEXTS = {
  child: {
    title: "Créer mes exercices", photo: "Photo de ta leçon", ok: "Photo prête : la page « Je retiens »", paste: "Ou colle le texte de ta leçon", pastePlaceholder: "Colle ici le texte de ta leçon",
    warn: "La photo sera effacée dès que tes exercices seront prêts.", send: "Créer mes exercices", busy: "Je prépare tes exercices…",
    ready: () => "Tes exercices sont prêts. La photo de ta leçon a été effacée.", readyBtn: "Voir mes exercices", failed: "Les exercices n'ont pas pu être créés. Réessaie.",
  },
  parent: {
    title: "Créer des exercices", photo: "Photo de la leçon", ok: "Photo prête : la page « Je retiens »", paste: "Ou collez le texte de la leçon", pastePlaceholder: "Collez ici le texte de la leçon",
    warn: "La photo sera effacée dès que les exercices seront prêts.", send: "Créer les exercices", busy: "Préparation des exercices…",
    ready: (name: string) => `Les exercices de ${name} sont prêts. La photo de la leçon a été effacée.`, readyBtn: "Voir la page et la fiche réponse", failed: "Les exercices n'ont pas pu être créés. Réessayez.",
  },
} as const;

type Phase = { step: "before" } | { step: "sending" } | { step: "ready"; pageId: string; firstName: string } | { step: "error"; code: string; message: string };

/**
 * Envoi d'une leçon (US-180 RF2, RF6, RF8, RF10, RF11) : une photo, une page à la fois, ou le texte collé. L'avertissement « La photo sera effacée… » est affiché avant l'envoi.
 * Un parent crée la page pour l'enfant choisi (`memberId`) ; le profil d'un enfant, pour lui-même. Après une erreur, la photo est à reprendre : elle n'a pas été gardée.
 */
export function HomeworkLessonScreen({ memberId }: { memberId: string | null }) {
  const today = useApiQuery<{ today: HomeworkToday }>("/api/family/homework/today");
  const data = today.data?.today;
  const [file, setFile] = useState<File | null>(null);
  const [pasting, setPasting] = useState(false);
  const [text, setText] = useState("");
  const [phase, setPhase] = useState<Phase>({ step: "before" });
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);
  const role = data?.role === "parent" ? "parent" : "child";
  const T = TEXTS[role];
  const kid = data?.role === "parent" ? data.children.find((c) => c.memberId === memberId) : undefined;
  const ready = Boolean(file) || text.trim().length > 0;

  async function send() {
    if (!ready) return;
    setPhase({ step: "sending" });
    const form = new FormData();
    if (kid) form.set("memberId", kid.memberId);
    if (file) form.set("photo", await shrink(file), "lecon.jpg");
    else form.set("text", text.trim());
    // La photo n'est gardée nulle part : après l'envoi, réussi ou non, elle est à reprendre (RF6, RF11).
    setFile(null);
    try {
      const response = await fetch("/api/family/homework/pages", { method: "POST", body: form, credentials: "same-origin", signal: AbortSignal.timeout(120_000) });
      const body = (await response.json().catch(() => null)) as { result?: { pageId: string; firstName: string }; error?: { code?: string; message?: string } } | null;
      if (!response.ok || !body?.result) setPhase({ step: "error", code: body?.error?.code ?? "page_failed", message: body?.error?.message ?? T.failed });
      else {
        setText("");
        setPhase({ step: "ready", ...body.result });
      }
    } catch {
      setPhase({ step: "error", code: "page_failed", message: T.failed });
    }
  }

  const pick = (list: FileList | null) => {
    if (list?.[0]) {
      setFile(list[0]);
      setPasting(false);
      setText("");
    }
  };

  return (
    <AppShell title={T.title} eyebrow="Préparer les devoirs" back={{ href: "/assistant/devoirs/tache", label: "Préparer les devoirs" }}>
      {today.loading && !data && <Loading slow={today.slow} />}
      {today.error && <RetryNotice message={today.error.kind === "server" ? "L'écran n'a pas pu être chargé." : today.error.message} onRetry={today.reload} />}
      {data?.role === "parent" && !kid && (
        <Notice tone="info">
          Choisissez d&apos;abord l&apos;enfant depuis la tâche « Préparer les devoirs ». <Link href="/assistant/devoirs/tache">Revenir</Link>
        </Notice>
      )}
      {data && (data.role === "child" || kid) && (
        <>
          {kid && phase.step !== "ready" && (
            <div className={styles.form} style={{ fontSize: 14 }}>
              <span>
                Pour <b>{kid.firstName}</b> · {kid.levelLabel}{" "}
                <Link href="/assistant/devoirs/tache" className={styles.link}>
                  Changer
                </Link>
              </span>
            </div>
          )}

          {phase.step === "before" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div className={`${s.drop} ${file ? s.dropReady : ""}`}>{file ? T.ok : T.photo}</div>
              <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => pick(e.target.files)} aria-label="Prendre une photo" />
              <input ref={library} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => pick(e.target.files)} aria-label="Choisir une image" />
              <div style={{ display: "flex", gap: 10 }}>
                <button type="button" className={`${s.big} ${s.big2}`} onClick={() => camera.current?.click()}>
                  Prendre une photo
                </button>
                <button type="button" className={`${s.big} ${s.big2}`} onClick={() => library.current?.click()}>
                  Choisir une image
                </button>
              </div>
              <button type="button" className={styles.link} style={{ alignSelf: "flex-start", background: "none", border: "none", padding: "4px 0", textDecoration: "underline" }} onClick={() => setPasting((v) => !v)}>
                {T.paste}
              </button>
              {pasting && (
                <textarea
                  className={styles.textarea}
                  value={text}
                  maxLength={6000}
                  placeholder={T.pastePlaceholder}
                  aria-label={T.paste}
                  onChange={(e) => {
                    setText(e.target.value);
                    setFile(null);
                  }}
                />
              )}
              <div className={s.warn}>
                <span aria-hidden>🗑</span>
                <span>{T.warn}</span>
              </div>
              <button type="button" className={s.big} disabled={!ready} onClick={() => void send()}>
                {T.send}
              </button>
            </div>
          )}

          {phase.step === "sending" && (
            <div className={s.center} role="status">
              <div className={s.spin} />
              <span>{T.busy}</span>
            </div>
          )}

          {phase.step === "ready" && (
            <div className={s.center}>
              <div className={s.check}>✓</div>
              <p style={{ margin: 0 }}>{T.ready(phase.firstName)}</p>
              <Link href={`/assistant/devoirs/exercices/${phase.pageId}`} className={s.big} style={{ alignSelf: "stretch" }}>
                {T.readyBtn}
              </Link>
            </div>
          )}

          {phase.step === "error" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 14, paddingTop: 20 }}>
              <div className={s.oops} role="alert">
                {phase.message}
              </div>
              {phase.code !== "daily_cap_reached" && (
                <button type="button" className={s.big} onClick={() => setPhase({ step: "before" })}>
                  {phase.code === "lesson_unreadable" || phase.code === "lesson_off_topic" ? "Reprendre la photo" : "Réessayer"}
                </button>
              )}
              <Link href="/assistant/devoirs/tache" className={styles.link} style={{ alignSelf: "center" }}>
                Revenir
              </Link>
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}
