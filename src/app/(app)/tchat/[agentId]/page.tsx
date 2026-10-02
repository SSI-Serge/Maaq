"use client";

import { useParams } from "next/navigation";
import { ChatScreen } from "@/components/chat/ChatScreen";

/** Tchat avec un agent (US-37). */
export default function ChatPage() {
  const { agentId } = useParams<{ agentId: string }>();
  return <ChatScreen key={agentId} agentId={agentId} />;
}
