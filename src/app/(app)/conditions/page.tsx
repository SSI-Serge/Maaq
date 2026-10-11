"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { signOut } from "@/client/auth";
import { useApiAction } from "@/client/hooks";
import { useSessionReload } from "@/components/auth/AuthGate";
import { ErrorLine } from "@/components/auth/parts";
import { LegalViewer } from "@/components/legal/LegalViewer";
import styles from "@/components/legal/legal.module.css";
import { Button, Logo, Screen } from "@/components/ui";

/**
 * Acceptation des textes en vigueur avant tout accès : à la première connexion, ou quand une nouvelle version a
 * été publiée (US-54 RF3, RF4).
 */
export default function AcceptTermsPage() {
  const router = useRouter();
  const reload = useSessionReload();
  const [checked, setChecked] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const accept = useApiAction<Record<string, never>, { accepted: boolean }>("/api/legal/accept");

  async function submit() {
    const result = await accept.run({});
    if (!result) return;
    await reload();
    router.replace("/accueil");
  }

  return (
    <Screen>
      <Logo />
      <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <h1 style={{ fontSize: 24 }}>Avant de continuer</h1>
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5, color: "var(--ink-soft)" }}>
          Pour utiliser MAAQ, merci de lire et d&apos;accepter la politique de confidentialité et les conditions d&apos;utilisation en vigueur.
        </p>
        <LegalViewer />
        <label className={styles.checkbox}>
          <input type="checkbox" checked={checked} onChange={(event) => setChecked(event.target.checked)} />
          <span>J&apos;ai lu et j&apos;accepte la politique de confidentialité et les conditions d&apos;utilisation de MAAQ.</span>
        </label>
        <ErrorLine error={accept.error} onRetry={submit} />
        <Button block loading={accept.pending} disabled={!checked} onClick={submit}>
          Accepter et continuer
        </Button>
        <Button
          variant="secondary"
          block
          loading={leaving}
          onClick={async () => {
            setLeaving(true);
            await signOut();
            router.replace("/connexion");
          }}
        >
          Se déconnecter
        </Button>
      </div>
    </Screen>
  );
}
