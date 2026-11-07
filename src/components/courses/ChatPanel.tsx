"use client";

import Link from "next/link";
import { Fragment, useEffect, useRef, useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import family from "@/components/family/family.module.css";
import { Button, Notice } from "@/components/ui";
import { SCREENS, type ScreenKey } from "@/server/courses/chat/screens";
import type { CourseMessageView, CourseReply } from "@/server/courses/chat/service";
import styles from "./courses.module.css";

/** Texte d'une réponse de l'agent : les marqueurs `[[ecran:nom]]` deviennent des liens vers les écrans de l'application. */
function Rich({ text, couple }: { text: string; couple: boolean }) {
  const parts = text.split(/(\[\[ecran:[a-z_]+\]\])/g);
  return (
    <>
      {parts.map((part, i) => {
        const key = /^\[\[ecran:([a-z_]+)\]\]$/.exec(part)?.[1] as ScreenKey | undefined;
        const screen = key ? SCREENS[key] : undefined;
        if (!screen || (screen.couple && !couple)) return <Fragment key={i}>{key ? "" : part}</Fragment>;
        return (
          <Link key={i} href={screen.href} className={styles.link} style={{ fontWeight: 700 }}>
            {screen.label} ›
          </Link>
        );
      })}
    </>
  );
}

/**
 * Tchat de l'agent « Courses et repas » (CR-Tchat) : bandeau « Vous échangez avec une IA », fil des échanges (4 jours), zone de saisie et bouton appareil photo vers l'écran des
 * tickets. L'agent ne calcule rien : il ajoute un produit, coche un achat, donne deux chiffres du budget et renvoie vers les écrans.
 */
export function ChatPanel({ couple }: { couple: boolean }) {
  const history = useApiQuery<{ messages: CourseMessageView[] }>("/api/courses/chat");
  const send = useApiMutation();
  const [text, setText] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const request = useRef<string>(crypto.randomUUID());
  const end = useRef<HTMLDivElement>(null);
  const messages = history.data?.messages ?? [];

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages.length, pending]);

  async function submit() {
    const value = text.trim();
    if (!value || send.pending) return;
    setPending(value);
    setFailed(null);
    const result = await send.run<CourseReply>("/api/courses/chat", { method: "POST", body: { requestId: request.current, text: value } });
    setPending(null);
    if (result && !result.failed) {
      request.current = crypto.randomUUID();
      setText("");
      history.reload();
    } else if (result?.failed) {
      setFailed(result.reply);
    }
  }

  return (
    <section aria-label="Tchat Courses et repas" style={{ marginTop: 16 }}>
      <p className={styles.banner} style={{ fontWeight: 400, fontSize: 11, background: "var(--warning-bg)" }}>
        Vous échangez avec une IA. Ses réponses peuvent contenir des erreurs.
      </p>
      <div role="log" aria-live="polite" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? undefined : styles.dayCard} style={m.role === "user" ? { alignSelf: "flex-end", maxWidth: "85%", padding: "8px 12px", borderRadius: "12px 12px 2px 12px", background: "var(--primary)", color: "var(--primary-ink)", fontSize: 14 } : { fontSize: 14, lineHeight: 1.4 }}>
            {m.role === "user" ? m.text : <Rich text={m.text} couple={couple} />}
          </div>
        ))}
        {pending && (
          <>
            <div style={{ alignSelf: "flex-end", maxWidth: "85%", padding: "8px 12px", borderRadius: "12px 12px 2px 12px", background: "var(--primary)", color: "var(--primary-ink)", fontSize: 14 }}>{pending}</div>
            <div className={styles.dayCard} role="status">
              <span className={styles.meta}>Courses et repas écrit…</span>
            </div>
          </>
        )}
        <div ref={end} />
      </div>
      {(failed || send.error) && <Notice tone="error">{failed ?? send.error!.message}</Notice>}
      <div className={styles.addRow} style={{ marginTop: 10 }}>
        <input
          className={family.input}
          aria-label="Écrire à Courses et repas"
          placeholder="Écrire à Courses et repas…"
          value={text}
          maxLength={2000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
        />
        {couple && (
          <Link href="/courses/ticket" aria-label="Envoyer une photo de ticket" className={styles.toggleBox} style={{ display: "grid", placeItems: "center", width: 44, height: 44, textDecoration: "none" }}>
            📷
          </Link>
        )}
        <Button onClick={() => void submit()} loading={send.pending} disabled={!text.trim()}>
          Envoyer
        </Button>
      </div>
    </section>
  );
}
