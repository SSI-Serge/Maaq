"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiRequest } from "@/client/api";
import { useApiAction, useApiQuery } from "@/client/hooks";
import { Button, Card, Eyebrow, Field, Loading, RetryNotice, Screen } from "@/components/ui";
import type { WhatsAppOutboxEntry } from "@/server/adapters/whatsapp/types";

/**
 * WhatsApp simulé : ce que MAAQ « envoie » (rien ne part en mode dev) et un formulaire pour jouer le rôle de
 * la personne qui écrit depuis son téléphone. Même chemin que le vrai webhook.
 */
export default function WhatsAppDemoPage() {
  const outbox = useApiQuery<{ messages: WhatsAppOutboxEntry[] }>("/api/dev/whatsapp");
  const [polled, setPolled] = useState<WhatsAppOutboxEntry[] | null>(null);
  const messages = polled ?? outbox.data?.messages ?? [];
  const [from, setFrom] = useState("33612345678");
  const [text, setText] = useState("");
  const send = useApiAction<{ from: string; text?: string; buttonId?: string }, { externalId: string }>("/api/dev/whatsapp");

  useEffect(() => {
    const timer = setInterval(() => {
      apiRequest<{ messages: WhatsAppOutboxEntry[] }>("/api/dev/whatsapp")
        .then((r) => setPolled(r.messages))
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    const result = await send.run({ from, text: text.trim() });
    if (result) setText("");
  }

  async function press(buttonId: string, title: string) {
    await send.run({ from, buttonId, text: title });
  }

  return (
    <Screen>
      <Link href="/" style={{ fontSize: 13, color: "var(--secondary-strong)", fontWeight: 600 }}>← Retour</Link>
      <h1 style={{ fontSize: 24, margin: "16px 0 6px" }}>WhatsApp simulé</h1>
      <p style={{ fontSize: 13, color: "var(--ink-soft)", margin: "0 0 16px", lineHeight: 1.5 }}>
        Écrivez comme depuis votre téléphone. Pour relier ce numéro : Réglages › WhatsApp et rappels dans l&apos;application, puis envoyez le code ici.
      </p>

      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 18 }}>
        <Field label="Numéro de l'expéditeur (sans +)" value={from} onChange={(e) => setFrom(e.target.value)} />
        <Field label="Message" value={text} onChange={(e) => setText(e.target.value)} placeholder="LINK-ABC123, ou « Une idée pour Léa, 20 € »" />
        <Button type="submit" loading={send.pending}>Envoyer comme {from}</Button>
        {send.error && <p style={{ color: "var(--error)", fontSize: 13 }}>{send.error.message}</p>}
      </form>

      {outbox.loading && messages.length === 0 && <Loading slow={outbox.slow} />}
      {outbox.error && <RetryNotice message={outbox.error.message} onRetry={outbox.reload} />}
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {messages.length === 0 && !outbox.loading && <p style={{ fontSize: 14, color: "var(--ink-soft)" }}>Aucun message envoyé pour l&apos;instant.</p>}
        {messages.map((m) => (
          <Card key={m.id}>
            <Eyebrow>
              {m.message.kind === "template" ? `Modèle ${m.message.name}` : m.message.kind === "buttons" ? "Message à boutons" : "Message"} · à {m.message.to} · {new Date(m.sentAt).toLocaleString("fr-FR")}
            </Eyebrow>
            <p style={{ fontSize: 14, margin: "8px 0 0", whiteSpace: "pre-wrap", lineHeight: 1.5 }}>{m.message.kind === "buttons" ? m.message.text : m.preview}</p>
            {m.message.kind === "buttons" && (
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                {m.message.buttons.map((b) => (
                  <Button key={b.id} variant="secondary" type="button" disabled={m.message.to !== from} onClick={() => press(b.id, b.title)}>
                    {b.title}
                  </Button>
                ))}
              </div>
            )}
            {m.message.kind === "template" && m.message.buttonPayloads && m.message.buttonPayloads.length > 0 && (
              <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                {m.message.buttonPayloads.map((payload, index) => (
                  <Button key={payload} variant="secondary" type="button" disabled={m.message.to !== from} onClick={() => press(payload, m.preview.match(/\[(.+)\]$/)?.[1].split("] [")[index] ?? payload)}>
                    {m.preview.match(/\[(.+)\]$/)?.[1].split("] [")[index] ?? payload}
                  </Button>
                ))}
              </div>
            )}
          </Card>
        ))}
      </div>
    </Screen>
  );
}
