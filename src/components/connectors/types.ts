/** Formes de données renvoyées par /api/connectors (voir src/server/connectors/service.ts). */

export type ConnectorCode = "google_drive" | "google_calendar" | "validation_mailbox";
export type Status = "none" | "pending" | "connected" | "refused" | "partial" | "reconnect_required";

export interface ConnectorView {
  code: ConnectorCode;
  label: string;
  kind: "google" | "mailbox";
  scope: "each_profile" | "primary_user" | "account";
  status: Status;
  email: string | null;
  editable: boolean;
  ownerFirstName: string | null;
  permissions: string[];
}

export interface CcView {
  max: number;
  autoParticipants: { email: string; name: string }[];
  addresses: string[];
}

export interface AgentTab {
  agentId: string;
  name: string;
  connectors: ConnectorView[];
  cc: CcView | null;
}

export interface Overview {
  agents: AgentTab[];
  suggestedEmail: string | null;
}

export const EMAIL_FORMAT = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
