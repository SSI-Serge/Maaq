"use client";

import Link from "next/link";
import { useSessionUser } from "@/components/auth/AuthGate";
import { Card, Eyebrow, Logo, Screen } from "@/components/ui";

/** Configuration initiale de l'utilisateur principal (US-10, US-11), construite au lot 3. */
export default function InitialSetupPage() {
  const user = useSessionUser();
  return (
    <Screen>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Logo />
        <Link href="/reglages" style={{ fontSize: 13, color: "var(--secondary-strong)", fontWeight: 600 }}>
          Réglages
        </Link>
      </div>
      <h1 style={{ fontSize: 26, margin: "32px 0 12px" }}>Bienvenue {user.firstName}</h1>
      <Card>
        <Eyebrow>Premier accès</Eyebrow>
        <p style={{ fontSize: 14, lineHeight: 1.5, margin: "8px 0 0", color: "var(--ink-soft)" }}>
          Votre configuration initiale n&apos;est pas terminée. Ces écrans arrivent avec le lot 3.
        </p>
      </Card>
    </Screen>
  );
}
