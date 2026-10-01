"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { ApiError, apiRequest } from "@/client/api";
import { deviceTimezone } from "@/client/auth";
import { useApiQuery } from "@/client/hooks";
import { AuthScreen, ErrorLine, Heading } from "@/components/auth/parts";
import { Button, Field, Loading, Notice } from "@/components/ui";
import styles from "@/components/auth/auth.module.css";

interface LegalVersion {
  id: string;
  type: "privacy_policy" | "terms_of_use";
  label: string;
  content: string;
}

const STRONG = (value: string) => value.length >= 10 && /\p{L}/u.test(value) && /\d/.test(value);
const TITLES = { privacy_policy: "Politique de confidentialité", terms_of_use: "Conditions d'utilisation" };

/**
 * Activation du compte depuis le lien reçu par email (US-64 RF5, RF6) : acceptation de la politique
 * de confidentialité et des conditions d'utilisation (maquette Acceptation), puis mot de passe.
 */
export default function ActivationPage() {
  return (
    <Suspense>
      <Activation />
    </Suspense>
  );
}

function Activation() {
  const token = useSearchParams().get("jeton") ?? "";
  const info = useApiQuery<{ firstName: string; legal: LegalVersion[] }>(`/api/activation?jeton=${encodeURIComponent(token)}`);
  const [accepted, setAccepted] = useState(false);
  const [step, setStep] = useState<"legal" | "password">("legal");

  if (info.loading) {
    return (
      <AuthScreen>
        <Loading slow={info.slow} />
      </AuthScreen>
    );
  }

  if (info.error) {
    const linkProblem = info.error.body?.code === "link_expired" || info.error.body?.code === "link_invalid";
    return (
      <AuthScreen>
        <Heading eyebrow="Activation du compte" title={linkProblem ? "Lien non valable" : "Activation impossible"} />
        {linkProblem ? <Notice tone="error">{info.error.message}</Notice> : <ErrorLine error={info.error} onRetry={info.reload} />}
      </AuthScreen>
    );
  }

  if (!info.data) return null;

  return (
    <AuthScreen>
      {step === "legal" ? (
        <div className={styles.form}>
          <Heading
            eyebrow="Activation du compte"
            title={`Bienvenue ${info.data.firstName}`}
            lead="Avant de continuer, merci de consulter la politique de confidentialité et les conditions d'utilisation de MAAQ."
          />
          {info.data.legal.map((doc) => (
            <details key={doc.id} style={{ background: "var(--bg-raised)", border: "1px solid var(--line)", borderRadius: 10, padding: "12px 14px" }}>
              <summary style={{ fontWeight: 600, fontSize: 14, cursor: "pointer" }}>
                {TITLES[doc.type]} <span style={{ color: "var(--ink-soft)", fontWeight: 400 }}>· version {doc.label}</span>
              </summary>
              <p style={{ fontSize: 13, lineHeight: 1.6, color: "var(--ink-soft)", whiteSpace: "pre-wrap", margin: "10px 0 0" }}>{doc.content}</p>
            </details>
          ))}
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 13, lineHeight: 1.5 }}>
            <input type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} style={{ marginTop: 3 }} />
            J&apos;ai lu et j&apos;accepte la politique de confidentialité et les conditions d&apos;utilisation de MAAQ.
          </label>
          <Button block disabled={!accepted} onClick={() => setStep("password")}>
            Continuer
          </Button>
          <p className={styles.note}>Cette acceptation vous sera redemandée si ces documents sont à nouveau mis à jour.</p>
        </div>
      ) : (
        <PasswordStep token={token} />
      )}
    </AuthScreen>
  );
}

function PasswordStep({ token }: { token: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState<string>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError>();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setMessage(undefined);
    setError(undefined);
    if (!STRONG(password)) return setMessage("Le mot de passe doit comporter au moins 10 caractères, dont une lettre et un chiffre.");
    if (password !== confirmation) return setMessage("Les deux mots de passe ne correspondent pas.");
    setPending(true);
    try {
      const result = await apiRequest<{ next: string }>("/api/activation", {
        method: "POST",
        body: { token, accepted: true, password, confirmation, timezone: deviceTimezone() },
      });
      router.replace(result.next);
    } catch (err) {
      setPassword("");
      setConfirmation("");
      setError(err as ApiError);
    } finally {
      setPending(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <Heading eyebrow="Activation du compte" title="Choisissez votre mot de passe" lead="Au moins 10 caractères, avec une lettre et un chiffre." />
      <Field label="Mot de passe" type="password" autoComplete="new-password" placeholder="••••••••••" value={password} onChange={(e) => setPassword(e.target.value)} />
      <Field label="Confirmer le mot de passe" type="password" autoComplete="new-password" placeholder="••••••••••" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
      {message && <Notice tone="error">{message}</Notice>}
      <ErrorLine error={error} />
      <Button type="submit" block loading={pending} disabled={!password || !confirmation}>
        Activer mon compte
      </Button>
    </form>
  );
}
