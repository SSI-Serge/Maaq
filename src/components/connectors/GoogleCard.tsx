"use client";

import { useState } from "react";
import { useApiMutation } from "@/client/hooks";
import { Section, appStyles as s } from "@/components/app/AppShell";
import { ConfirmDialog, ErrorLine } from "@/components/auth/parts";
import { Button, Field, Notice } from "@/components/ui";
import { EMAIL_FORMAT, type ConnectorView, type Status } from "./types";

const STATUS: Record<Status, { label: string; tone: string }> = {
  none: { label: "Non configuré", tone: s.neutral },
  pending: { label: "Autorisation en attente", tone: s.warn },
  connected: { label: "Connecté", tone: s.ok },
  refused: { label: "Autorisation refusée", tone: s.error },
  partial: { label: "Autorisation partielle", tone: s.error },
  reconnect_required: { label: "À reconnecter", tone: s.error },
};

const SERVICE: Record<string, string> = { google_drive: "Google Drive", google_calendar: "Google Agenda" };
/** Ce que l'agent ne pourra pas faire sans l'autorisation (US-14 RF4). */
const CANNOT: Record<string, string> = { google_drive: "accéder à vos documents", google_calendar: "gérer votre agenda" };

export interface GoogleCardProps {
  agent: { id: string; name: string };
  connector: ConnectorView;
  suggestedEmail: string | null;
  onChanged: () => void;
}

/**
 * Connecteur Google (Drive ou Agenda) d'un agent, ou Drive unique du compte (US-13, US-14, US-67) :
 * saisie du compte, panneau des permissions, consentement Google (simulé en développement), statut.
 */
export function GoogleCard({ agent, connector, suggestedEmail, onChanged }: GoogleCardProps) {
  const [step, setStep] = useState<"idle" | "choosing" | "requesting">("idle");
  const [email, setEmail] = useState(connector.email ?? "");
  const [emailError, setEmailError] = useState<string>();
  const [disconnecting, setDisconnecting] = useState(false);
  const mutation = useApiMutation();

  const service = SERVICE[connector.code];
  const isAccount = connector.scope === "account";
  const status = STATUS[connector.status];
  const title = isAccount ? connector.label : `Connecteur — ${service}`;
  const subject = isAccount ? "les agents du compte" : agent.name;
  const serverEmailError = mutation.error?.body?.code === "invalid_email" ? "Adresse email invalide" : undefined;

  function begin() {
    mutation.reset();
    setEmail(connector.email ?? email);
    setEmailError(undefined);
    setStep("choosing");
  }

  function continueToPermissions() {
    if (!EMAIL_FORMAT.test(email.trim())) return setEmailError("Adresse email invalide");
    setEmailError(undefined);
    setStep("requesting");
  }

  /** Envoie vers la page de consentement ; sans adresse, reprend avec celle déjà enregistrée (US-14 RF11). */
  async function authorize(withEmail: boolean) {
    const result = await mutation.run<{ consentUrl: string | null }>("/api/connectors/authorize", {
      method: "POST",
      body: { agentId: agent.id, connector: connector.code, ...(withEmail ? { email: email.trim() } : {}) },
    });
    if (!result) return;
    if (result.consentUrl) window.location.assign(result.consentUrl);
    else {
      setStep("idle");
      onChanged();
    }
  }

  async function refuse() {
    const result = await mutation.run<null>("/api/connectors/refuse", { method: "POST", body: { agentId: agent.id, connector: connector.code, email: email.trim() } });
    if (result !== undefined) {
      setStep("idle");
      onChanged();
    }
  }

  async function confirmDisconnect() {
    const result = await mutation.run<null>("/api/connectors/disconnect", { method: "POST", body: { agentId: agent.id, connector: connector.code } });
    if (result !== undefined) {
      setDisconnecting(false);
      onChanged();
    }
  }

  return (
    <Section title={title} action={<span className={`${s.badge} ${status.tone}`}>{status.label}</span>}>
      {isAccount && (
        <p className={s.muted}>
          Une connexion unique pour tout le compte, partagée par les agents qui en ont besoin — à la différence des autres connecteurs, propres à chaque profil.
        </p>
      )}

      {!connector.editable ? (
        <ReadOnly connector={connector} service={service} />
      ) : step === "choosing" ? (
        <div className={s.form}>
          {suggestedEmail && suggestedEmail.toLowerCase() !== email.trim().toLowerCase() && (
            <div className={s.row} style={{ background: "var(--secondary-soft)", borderRadius: 8, padding: "8px 10px" }}>
              <span className={s.muted}>
                Une adresse est déjà connectée pour un autre agent : <b>{suggestedEmail}</b>
              </span>
              <button className={s.smallButton} onClick={() => setEmail(suggestedEmail)}>
                Utiliser
              </button>
            </div>
          )}
          <Field
            label="Adresse email de connexion"
            type="email"
            placeholder="camille@exemple.fr"
            value={email}
            error={emailError ?? serverEmailError}
            onChange={(e) => {
              setEmail(e.target.value);
              setEmailError(undefined);
            }}
            onBlur={() => email.trim() && !EMAIL_FORMAT.test(email.trim()) && setEmailError("Adresse email invalide")}
          />
          <div className={s.row}>
            <Button variant="secondary" onClick={() => setStep("idle")}>
              Annuler
            </Button>
            <Button disabled={!email.trim()} onClick={continueToPermissions}>
              Continuer
            </Button>
          </div>
        </div>
      ) : step === "requesting" ? (
        <div className={s.form}>
          <div style={{ border: "1px solid var(--secondary)", borderRadius: 12, padding: 14, display: "flex", flexDirection: "column", gap: 10, background: "var(--bg)" }}>
            <div className={s.text} style={{ fontWeight: 700 }}>
              {isAccount ? "MAAQ" : agent.name} demande l&apos;accès {isAccount ? "au" : "à votre"} {service}
              {isAccount ? " du compte" : ""}
            </div>
            <p className={s.muted}>Compte Google visé : {email.trim()}</p>
            {connector.permissions.map((permission) => (
              <div key={permission} className={s.listLine}>
                <span aria-hidden style={{ color: "var(--secondary-strong)" }}>●</span>
                <span>{permission}</span>
              </div>
            ))}
          </div>
          <ErrorLine error={mutation.error} onRetry={() => authorize(true)} />
          <div className={s.row}>
            <Button variant="secondary" disabled={mutation.pending} onClick={refuse}>
              Refuser
            </Button>
            <Button loading={mutation.pending} onClick={() => authorize(true)}>
              Autoriser
            </Button>
          </div>
          <p className={s.muted}>Vous allez être redirigé vers la page de consentement de Google, puis ramené ici. MAAQ ne voit jamais votre mot de passe Google.</p>
        </div>
      ) : (
        <>
          {connector.status === "none" && (
            <>
              <p className={s.text}>
                {isAccount
                  ? "Connectez le compte Google Drive à utiliser pour classer les documents de tout le compte."
                  : `Connectez le compte ${service} qu'${agent.name} doit utiliser${connector.code === "google_calendar" ? " pour vos rendez-vous" : ""}.`}
              </p>
              <Button onClick={begin}>Connecter</Button>
            </>
          )}
          {connector.status === "pending" && (
            <>
              <p className={s.text}>
                La connexion de <b>{connector.email}</b> n&apos;est pas terminée.
              </p>
              <ErrorLine error={mutation.error} onRetry={() => authorize(false)} />
              <Button loading={mutation.pending} onClick={() => authorize(false)}>
                Reprendre la connexion
              </Button>
            </>
          )}
          {connector.status === "connected" && (
            <>
              <Notice tone="success">✓ Connecteur actif</Notice>
              <p className={s.text}>
                {isAccount ? "Les agents du compte peuvent désormais" : `${agent.name} peut désormais`}{" "}
                {connector.code === "google_calendar" ? "gérer vos rendez-vous dans Google Agenda" : "classer des documents dans Google Drive"}, via <b>{connector.email}</b>.
              </p>
              <div className={s.row}>
                <button className={s.smallButton} onClick={begin}>
                  Changer de compte
                </button>
                <button className={`${s.smallButton} ${s.danger}`} onClick={() => setDisconnecting(true)}>
                  Déconnecter
                </button>
              </div>
            </>
          )}
          {connector.status === "refused" && (
            <>
              <Notice tone="error">Sans cette autorisation, {subject} ne pourr{isAccount ? "ont" : "a"} pas {CANNOT[connector.code]}.</Notice>
              <Button onClick={begin}>Réessayer</Button>
            </>
          )}
          {connector.status === "partial" && (
            <>
              <Notice tone="error">
                Certaines permissions nécessaires n&apos;ont pas été accordées : {subject} ne pourr{isAccount ? "ont" : "a"} pas fonctionner correctement.
              </Notice>
              <Button onClick={begin}>Réessayer</Button>
            </>
          )}
          {connector.status === "reconnect_required" && (
            <>
              <Notice tone="error">La connexion à {service}{isAccount ? " du compte" : ""} a expiré et doit être renouvelée.</Notice>
              <ErrorLine error={mutation.error} onRetry={() => authorize(false)} />
              <Button loading={mutation.pending} onClick={() => authorize(false)}>
                Reprendre la connexion
              </Button>
            </>
          )}
        </>
      )}

      {disconnecting && (
        <ConfirmDialog
          title={`Déconnecter ${isAccount ? "le Google Drive du compte" : service} ?`}
          text={
            isAccount
              ? "Les agents qui utilisent cette connexion redeviendront « À configurer ». Les documents déjà classés resteront dans le Google Drive."
              : `Les actions d'${agent.name} qui en dépendent deviendront indisponibles.`
          }
          confirmLabel="Déconnecter"
          confirming={mutation.pending}
          onConfirm={confirmDisconnect}
          onCancel={() => {
            mutation.reset();
            setDisconnecting(false);
          }}
        >
          <ErrorLine error={mutation.error} onRetry={confirmDisconnect} />
        </ConfirmDialog>
      )}
    </Section>
  );
}

/** Connexion détenue par l'utilisateur principal : l'invité en voit l'état, sans pouvoir la modifier (US-13 RF3, US-67 RF8). */
function ReadOnly({ connector, service }: { connector: ConnectorView; service: string }) {
  return (
    <>
      {connector.status === "connected" ? (
        <p className={s.text}>
          {service} connecté par {connector.ownerFirstName}.
        </p>
      ) : (
        <p className={s.text}>
          {connector.ownerFirstName} doit connecter {connector.scope === "account" ? "le Google Drive du compte" : service}. Aucune action n&apos;est possible pour vous.
        </p>
      )}
    </>
  );
}
