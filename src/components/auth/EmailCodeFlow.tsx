"use client";

import Link from "next/link";
import { useState, type ReactNode } from "react";
import { ApiError, apiRequest } from "@/client/api";
import { useRememberedEmail } from "@/client/auth";
import { Button, Field } from "@/components/ui";
import styles from "./auth.module.css";
import { CodeEntry, ErrorLine, Heading } from "./parts";

const EMAIL_FORMAT = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const RESEND_SECONDS = 60;

export interface EmailCodeFlowProps {
  eyebrow: string;
  title: string;
  intro: ReactNode;
  sendLabel: string;
  /** Routes d'envoi et de vérification du code. */
  sendPath: string;
  verifyPath: string;
  onVerified: (response: unknown) => void;
}

/**
 * Parcours commun « email puis code à 6 chiffres » de la récupération du schéma (US-8) et du
 * mot de passe oublié (US-66). Le message affiché après l'envoi est toujours le même (RF3).
 */
export function EmailCodeFlow(props: EmailCodeFlowProps) {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useRememberedEmail();
  const [emailError, setEmailError] = useState<string>();
  const [code, setCode] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<ApiError>();
  const [resendAt, setResendAt] = useState<Date | null>(null);
  const [resent, setResent] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<ApiError>();

  async function send(isResend: boolean) {
    if (!EMAIL_FORMAT.test(email.trim())) return setEmailError("Adresse email invalide");
    setSending(true);
    setSendError(undefined);
    setError(undefined);
    try {
      await apiRequest(props.sendPath, { method: "POST", body: { email: email.trim() } });
      setResendAt(new Date(Date.now() + RESEND_SECONDS * 1000));
      setResent(isResend);
      setStep("code");
    } catch (err) {
      setSendError(err as ApiError);
    } finally {
      setSending(false);
    }
  }

  async function confirm() {
    setConfirming(true);
    setError(undefined);
    try {
      const response = await apiRequest(props.verifyPath, { method: "POST", body: { email: email.trim(), code } });
      props.onVerified(response);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setConfirming(false);
    }
  }

  if (step === "email") {
    return (
      <form
        className={styles.form}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void send(false);
        }}
      >
        <Heading eyebrow={props.eyebrow} title={props.title} lead={props.intro} />
        <Field
          label="Adresse email de connexion"
          type="email"
          autoComplete="username"
          placeholder="vous@exemple.fr"
          value={email}
          error={emailError}
          onChange={(event) => {
            setEmail(event.target.value);
            setEmailError(undefined);
          }}
        />
        <ErrorLine error={sendError} onRetry={() => send(false)} />
        <Button type="submit" block loading={sending} disabled={!email.trim()}>
          {props.sendLabel}
        </Button>
        <Link href="/connexion" className={styles.link} style={{ alignSelf: "center" }}>
          Retour à la connexion
        </Link>
      </form>
    );
  }

  return (
    <>
      <Heading
        eyebrow={props.eyebrow}
        title="Saisissez le code reçu"
        lead="Si un compte existe pour cette adresse, un code vient de vous être envoyé par email."
      />
      {sendError && <ErrorLine error={sendError} onRetry={() => send(true)} />}
      <CodeEntry
        code={code}
        onCode={setCode}
        onConfirm={confirm}
        confirming={confirming}
        onResend={() => send(true)}
        resending={sending}
        resendAvailableAt={resendAt}
        error={error}
        resent={resent}
      />
      <button type="button" className={styles.link} style={{ alignSelf: "center", marginTop: 16 }} onClick={() => setStep("email")}>
        Changer d&apos;adresse email
      </button>
    </>
  );
}
