"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { apiRequest } from "@/client/api";
import { useApiAction, useApiQuery, useDraft } from "@/client/hooks";
import { Button, Loading, RetryNotice, Screen } from "@/components/ui";
import type { ActionProposal, ChatEvent } from "@/server/adapters/digitorn/types";

const STATUS_LABEL: Record<ActionProposal["status"], string> = {
  pending: "",
  executing: "Exécution en cours…",
  succeeded: "Validée — exécutée",
  failed: "L'action n'a pas pu être exécutée",
  refused: "Refusée",
  abandoned: "Abandonnée",
};

/** Démonstration du simulateur Digitorn : envoyer une demande, valider ou refuser une action. */
export default function DigitornDemoPage() {
  const conversation = useApiQuery<{ events: ChatEvent[] }>("/api/dev/digitorn");
  const [polled, setPolled] = useState<ChatEvent[] | null>(null);
  const events = polled ?? conversation.data?.events ?? [];
  const [draft, setDraft, clearDraft] = useDraft("dev-digitorn");
  const send = useApiAction<{ text: string }, { requestId: string }>("/api/dev/digitorn");

  // Le traitement est asynchrone (CC-10) : on relit la conversation régulièrement.
  useEffect(() => {
    const timer = setInterval(() => {
      apiRequest<{ events: ChatEvent[] }>("/api/dev/digitorn")
        .then((r) => setPolled(r.events))
        .catch(() => {});
    }, 1500);
    return () => clearInterval(timer);
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    const result = await send.run({ text });
    if (result) clearDraft();
  }

  return (
    <Screen>
      <Link href="/" style={{ fontSize: 13, color: "var(--secondary-strong)", fontWeight: 600 }}>← Retour</Link>
      <h1 style={{ fontSize: 24, margin: "16px 0 6px" }}>Digitorn simulé</h1>
      <p style={{ fontSize: 13, color: "var(--ink-soft)", margin: "0 0 16px", lineHeight: 1.5 }}>
        Essayez « Prends rendez-vous chez le notaire » ou « Écris un email à la banque ».
      </p>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 10, marginBottom: 16 }}>
        {conversation.loading && events.length === 0 && <Loading slow={conversation.slow} />}
        {conversation.error && <RetryNotice message={conversation.error.message} onRetry={conversation.reload} />}
        {events.map((e) => (
          <ChatItem key={e.id} event={e} />
        ))}
      </div>

      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 8, position: "sticky", bottom: 0, background: "var(--bg)", paddingTop: 8 }}>
        {send.error && <RetryNotice message={send.error.message} onRetry={() => send.run({ text: draft.trim() })} />}
        <div style={{ display: "flex", gap: 8 }}>
          <input
            aria-label="Votre demande"
            value={draft}
            maxLength={2000}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="Votre demande…"
            style={{ flex: 1, padding: "12px 14px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-raised)", fontSize: 14 }}
          />
          <Button type="submit" loading={send.pending} disabled={!draft.trim()}>
            Envoyer
          </Button>
        </div>
      </form>
    </Screen>
  );
}

function ChatItem({ event }: { event: ChatEvent }) {
  if (event.type === "user_message") {
    return (
      <div style={{ alignSelf: "flex-end", maxWidth: "80%", background: "var(--primary)", color: "var(--primary-ink)", borderRadius: "14px 14px 2px 14px", padding: "10px 14px", fontSize: 14, lineHeight: 1.45 }}>
        {event.text}
      </div>
    );
  }
  if (event.type === "agent_message") {
    return (
      <div style={{ alignSelf: "flex-start", maxWidth: "82%", background: "var(--bg-raised)", border: "1px solid var(--line)", borderRadius: "14px 14px 14px 2px", padding: "10px 14px", fontSize: 14, lineHeight: 1.45 }}>
        {event.text}
      </div>
    );
  }
  return <ProposalCard proposal={event.proposal} />;
}

function ProposalCard({ proposal }: { proposal: ActionProposal }) {
  const decide = useApiAction<{ proposalId: string; decision: "validate" | "refuse" }, { proposal: ActionProposal }>("/api/dev/digitorn/decide");
  const decided = proposal.status !== "pending";

  return (
    <div style={{ background: "var(--bg-raised)", border: "1px solid var(--secondary)", borderRadius: 12, padding: 14, display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, fontWeight: 700, color: "var(--secondary-strong)", textTransform: "uppercase", letterSpacing: ".05em" }}>
        Action proposée — validation requise
      </div>
      <div style={{ fontSize: 14, fontWeight: 600 }}>{proposal.summary}</div>
      <div style={{ fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.5 }}>
        {proposal.when && <div>Quand : {new Date(proposal.when).toLocaleString("fr-FR", { dateStyle: "full", timeStyle: "short" })}</div>}
        {proposal.place && <div>Lieu : {proposal.place}</div>}
        {proposal.participants.length > 0 && <div>Participants : {proposal.participants.join(", ")}</div>}
        {proposal.recipient && <div>Destinataire : {proposal.recipient}</div>}
      </div>
      {decided ? (
        <div style={{ fontSize: 13, fontWeight: 600, color: proposal.status === "succeeded" ? "var(--success)" : "var(--ink-soft)" }}>
          {STATUS_LABEL[proposal.status]}
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8 }}>
          <Button loading={decide.pending} onClick={() => decide.run({ proposalId: proposal.proposalId, decision: "validate" })}>Valider</Button>
          <Button variant="secondary" disabled={decide.pending} onClick={() => decide.run({ proposalId: proposal.proposalId, decision: "refuse" })}>Refuser</Button>
        </div>
      )}
      {decide.error && <RetryNotice message={decide.error.message} onRetry={decide.reset} />}
    </div>
  );
}
