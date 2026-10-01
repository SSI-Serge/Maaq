"use client";

import { useState } from "react";
import { ApiError, apiRequest } from "@/client/api";
import { deviceTimezone } from "@/client/auth";
import { AuthScreen, ErrorLine, Heading } from "@/components/auth/parts";
import { EmailCodeFlow } from "@/components/auth/EmailCodeFlow";
import { Button, ButtonLink, Field, Notice } from "@/components/ui";
import styles from "@/components/auth/auth.module.css";

const STRONG = (value: string) => value.length >= 10 && /\p{L}/u.test(value) && /\d/.test(value);

/** Réinitialisation du mot de passe par code (US-66), maquette Mot de passe oublié. */
export default function ForgottenPasswordPage() {
  const [step, setStep] = useState<"code" | "password" | "done">("code");
  const [offerPattern, setOfferPattern] = useState(false);

  return (
    <AuthScreen>
      {step === "code" && (
        <EmailCodeFlow
          eyebrow="Mot de passe oublié"
          title="Réinitialiser mon mot de passe"
          intro="Ce parcours est différent de « Schéma oublié ? » : il réinitialise votre mot de passe de connexion, pas votre schéma tactile."
          sendLabel="Envoyer le code"
          sendPath="/api/auth/password-reset/code"
          verifyPath="/api/auth/password-reset/verify"
          onVerified={() => setStep("password")}
        />
      )}
      {step === "password" && (
        <NewPasswordForm
          onSaved={(offer) => {
            setOfferPattern(offer);
            setStep("done");
          }}
        />
      )}
      {step === "done" && (
        <div className={styles.form}>
          <div className={styles.success}>✓ Mot de passe modifié</div>
          <p className={styles.lead} style={{ margin: 0 }}>
            Un email confirme la modification. Vos sessions ouvertes sur vos autres appareils ont été fermées.
          </p>
          {offerPattern ? (
            <>
              <p className={styles.lead} style={{ margin: 0 }}>
                Voulez-vous créer un schéma tactile pour vous reconnecter plus rapidement sur cet appareil ?
              </p>
              <ButtonLink href="/schema/creer" block>
                Créer mon schéma tactile
              </ButtonLink>
              <ButtonLink href="/connexion" variant="secondary" block>
                Non merci, me connecter par mot de passe
              </ButtonLink>
            </>
          ) : (
            <ButtonLink href="/connexion" block>
              Retour à la connexion
            </ButtonLink>
          )}
        </div>
      )}
    </AuthScreen>
  );
}

function NewPasswordForm({ onSaved }: { onSaved: (offerPattern: boolean) => void }) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [message, setMessage] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError>();

  async function save(event?: React.FormEvent) {
    event?.preventDefault();
    setMessage(undefined);
    setError(undefined);
    if (!STRONG(password)) return setMessage("Le mot de passe doit comporter au moins 10 caractères, dont une lettre et un chiffre.");
    if (password !== confirmation) return setMessage("Les deux mots de passe ne correspondent pas.");
    setSaving(true);
    try {
      const result = await apiRequest<{ offerPattern: boolean }>("/api/auth/password-reset/complete", {
        method: "POST",
        body: { password, confirmation, timezone: deviceTimezone() },
      });
      onSaved(result.offerPattern);
    } catch (err) {
      // Le mot de passe saisi n'est jamais conservé après une erreur (US-66 RF14).
      setPassword("");
      setConfirmation("");
      setError(err as ApiError);
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className={styles.form} onSubmit={save} noValidate>
      <Heading eyebrow="Nouveau mot de passe" title="Choisissez un nouveau mot de passe" lead="Au moins 10 caractères, avec une lettre et un chiffre." />
      <Field label="Nouveau mot de passe" type="password" autoComplete="new-password" placeholder="••••••••••" value={password} onChange={(e) => setPassword(e.target.value)} />
      <Field label="Confirmer le mot de passe" type="password" autoComplete="new-password" placeholder="••••••••••" value={confirmation} onChange={(e) => setConfirmation(e.target.value)} />
      {message && <Notice tone="error">{message}</Notice>}
      <ErrorLine error={error} />
      <Button type="submit" block loading={saving} disabled={!password || !confirmation}>
        Enregistrer le mot de passe
      </Button>
    </form>
  );
}
