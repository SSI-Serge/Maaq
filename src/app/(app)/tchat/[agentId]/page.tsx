"use client";

import { useParams, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { ChatScreen } from "@/components/chat/ChatScreen";

/** Adresse de retour proposée par l'écran d'origine : seulement un chemin interne (US-37 RF4). */
function safeBack(value: string | null): string {
  return value && /^\/[A-Za-z0-9_\-/?=&%]*$/.test(value) && !value.startsWith("//") ? value : "/accueil";
}

/** Tchat avec un agent (US-37). */
export default function ChatPage() {
  return (
    <Suspense>
      <Chat />
    </Suspense>
  );
}

function Chat() {
  const { agentId } = useParams<{ agentId: string }>();
  const back = safeBack(useSearchParams().get("retour"));
  return <ChatScreen key={agentId} agentId={agentId} backHref={back} />;
}
