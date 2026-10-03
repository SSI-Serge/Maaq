"use client";

import { useState } from "react";
import { useApiMutation } from "@/client/hooks";
import { Section, appStyles as s } from "@/components/app/AppShell";
import { ConfirmDialog, ErrorLine, useCountdown } from "@/components/auth/parts";
import { Button, Field, Notice } from "@/components/ui";
import { EMAIL_FORMAT, type ConnectorView } from "./types";

interface MailboxResult {
  status: string;
  resendAvailableAt: string | null;
}

const STATUS = {
  none: { label: "Non configurée", tone: s.neutral },
  pending: { label: "À vérifier", tone: s.warn },
  connected: { label: "Active", tone: s.ok },
} as const;

/**
 * Boîte mail de validation d'un agent (US-15) : adresse, vérification par un code reçu dans cette
 * boîte, puis activation. La validation d'un envoi se fait dans le tchat, par une carte dédiée.
 */
export function MailboxCard({ agent, connector, onChanged }: { agent: { id: string; name: string }; connector: ConnectorView; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [email, setEmail] = useState(connector.email ?? "");
  const [emailError, setEmailError] = useState<string>();
  const [code, setCode] = useState("");
  const [resendAt, setResendAt] = useState<Date | null>(null);
  const [removing, setRemoving] = useState(false);
  const mutation = useApiMutation();
  const wait = useCountdown(resendAt);

  const status = STATUS[connector.status === "connected" ? "connected" : connector.status === "none" ? "none" : "pending"];
  const verifying = connector.status === "pending" && !editing;

  async function save() {
    if (!EMAIL_FORMAT.test(email.trim())) return setEmailError("Adresse email invalide");
    setEmailError(undefined);
    const result = await mutation.run<MailboxResult>("/api/connectors/mailbox", { method: "POST", body: { agentId: agent.id, email: email.trim() } });
    if (!result) return;
    setEditing(false);
    setCode("");
    if (result.resendAvailableAt) setResendAt(new Date(result.resendAvailableAt));
    onChanged();
  }

  async function verify() {
    const result = await mutation.run<MailboxResult>("/api/connectors/mailbox/verify", { method: "POST", body: { agentId: agent.id, code } });
    if (result) {
      setCode("");
      onChanged();
    }
  }

  async function resend() {
    const result = await mutation.run<MailboxResult>("/api/connectors/mailbox/code", { method: "POST", body: { agentId: agent.id } });
    if (result?.resendAvailableAt) setResendAt(new Date(result.resendAvailableAt));
  }

  async function remove() {
    const result = await mutation.run<null>("/api/connectors/disconnect", { method: "POST", body: { agentId: agent.id, connector: "validation_mailbox" } });
    if (result !== undefined) {
      setRemoving(false);
      setEmail("");
      onChanged();
    }
  }

  const needsNewCode = ["code_expired", "code_invalidated", "code_missing"].includes(mutation.error?.body?.code ?? "");
  const cooldown = mutation.error?.body?.code === "code_cooldown" || mutation.error?.body?.code === "code_rate_limited";

  return (
    <Section title="Boîte mail de validation" action={<span className={`${s.badge} ${status.tone}`}>{status.label}</span>}>
      <p className={s.muted}>
        Cette boîte reçoit en parallèle le brouillon d&apos;un email que {agent.name} prépare en votre nom. La validation de l&apos;envoi se fait dans le tchat de l&apos;agent, via une
        carte dédiée. Elle peut être la même que votre email de connexion.
      </p>

      {!connector.editable ? (
        <p className={s.text}>
          {connector.status === "connected"
            ? `Boîte de validation active, configurée par ${connector.ownerFirstName}.`
            : `${connector.ownerFirstName} doit configurer la boîte de validation. Aucune action n'est possible pour vous.`}
        </p>
      ) : connector.status === "none" || editing ? (
        <div className={s.form}>
          <Field
            label="Adresse email de validation"
            type="email"
            placeholder="camille.validation@exemple.fr"
            value={email}
            error={emailError ?? (mutation.error?.body?.code === "invalid_email" ? "Adresse email invalide" : undefined)}
            onChange={(e) => {
              setEmail(e.target.value);
              setEmailError(undefined);
            }}
          />
          {mutation.error?.body?.code !== "invalid_email" && <ErrorLine error={mutation.error} onRetry={save} />}
          <div className={s.row}>
            {editing && (
              <Button variant="secondary" onClick={() => setEditing(false)}>
                Annuler
              </Button>
            )}
            <Button loading={mutation.pending} disabled={!email.trim()} onClick={save}>
              Enregistrer
            </Button>
          </div>
        </div>
      ) : verifying ? (
        <div className={s.form}>
          <p className={s.text}>
            Un code de vérification a été envoyé à <b>{connector.email}</b>.
          </p>
          <Field
            label="Code de vérification"
            inputMode="numeric"
            maxLength={6}
            placeholder="123456"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          />
          {cooldown ? <Notice tone="warning">{mutation.error!.message}</Notice> : <ErrorLine error={mutation.error} onRetry={verify} />}
          <Button loading={mutation.pending} disabled={code.length !== 6} onClick={verify}>
            Vérifier
          </Button>
          <div className={s.row}>
            <button className={s.smallButton} disabled={wait > 0 || mutation.pending} onClick={resend}>
              {wait > 0 ? `Renvoyer dans ${wait} s` : needsNewCode ? "Recevoir un nouveau code" : "Renvoyer le code"}
            </button>
            <button
              className={s.smallButton}
              onClick={() => {
                mutation.reset();
                setEditing(true);
              }}
            >
              Changer d&apos;adresse
            </button>
          </div>
        </div>
      ) : (
        <>
          <Notice tone="success">✓ Boîte de validation active</Notice>
          <p className={s.text}>
            Les brouillons à valider seront envoyés à <b>{connector.email}</b>.
          </p>
          <div className={s.row}>
            <button
              className={s.smallButton}
              onClick={() => {
                mutation.reset();
                setEditing(true);
              }}
            >
              Modifier
            </button>
            <button className={`${s.smallButton} ${s.danger}`} onClick={() => setRemoving(true)}>
              Supprimer
            </button>
          </div>
        </>
      )}

      {removing && (
        <ConfirmDialog
          title="Supprimer la boîte de validation ?"
          text={`Sans boîte de validation, les actions d'envoi d'email d'${agent.name} deviennent indisponibles et l'agent repasse « À configurer ».`}
          confirmLabel="Supprimer"
          confirming={mutation.pending}
          onConfirm={remove}
          onCancel={() => {
            mutation.reset();
            setRemoving(false);
          }}
        >
          <ErrorLine error={mutation.error} onRetry={remove} />
        </ConfirmDialog>
      )}
    </Section>
  );
}
