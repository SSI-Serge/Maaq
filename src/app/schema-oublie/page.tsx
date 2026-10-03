"use client";

import { useState } from "react";
import { AuthScreen } from "@/components/auth/parts";
import { EmailCodeFlow } from "@/components/auth/EmailCodeFlow";
import { ButtonLink } from "@/components/ui";
import styles from "@/components/auth/auth.module.css";

/** Récupération de l'accès après un schéma oublié ou verrouillé (US-8), maquette Récupération. */
export default function PatternRecoveryPage() {
  const [verified, setVerified] = useState(false);

  if (verified) {
    return (
      <AuthScreen>
        <div className={styles.form} style={{ textAlign: "center" }}>
          <div className={styles.lockIcon} style={{ background: "var(--success-bg)", color: "var(--success)" }} aria-hidden>
            ✓
          </div>
          <h1 className={styles.title}>Code confirmé</h1>
          <p className={styles.lead}>Vous pouvez maintenant redéfinir votre schéma tactile pour cet appareil.</p>
          <ButtonLink href="/schema/creer" block>
            Créer mon nouveau schéma
          </ButtonLink>
        </div>
      </AuthScreen>
    );
  }

  return (
    <AuthScreen>
      <EmailCodeFlow
        eyebrow="Schéma tactile oublié"
        title="Recréer mon schéma tactile"
        intro="Ce parcours ne concerne que votre schéma tactile sur cet appareil — votre mot de passe ne change pas. Indiquez l'adresse email de connexion de votre compte MAAQ, nous vous enverrons un code pour redéfinir votre schéma."
        sendLabel="Envoyer le code de récupération"
        sendPath="/api/auth/recovery/code"
        verifyPath="/api/auth/recovery/verify"
        onVerified={() => setVerified(true)}
      />
    </AuthScreen>
  );
}
