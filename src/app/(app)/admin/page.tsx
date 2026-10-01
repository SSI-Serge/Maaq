"use client";

import Link from "next/link";
import { useSessionUser } from "@/components/auth/AuthGate";
import { LogoutButton } from "@/components/auth/LogoutButton";
import { Card, Eyebrow, Logo, Screen } from "@/components/ui";

/** Accueil de la console d'administration. L'administration des agents (US-45) arrive au lot 2. */
export default function AdminHomePage() {
  const user = useSessionUser();
  return (
    <Screen>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Logo />
        <Link href="/reglages" style={{ fontSize: 13, color: "var(--secondary-strong)", fontWeight: 600 }}>
          Réglages
        </Link>
      </div>
      <h1 style={{ fontSize: 26, margin: "32px 0 12px" }}>Console d&apos;administration</h1>
      <Card>
        <Eyebrow>Administrateur</Eyebrow>
        <p style={{ fontSize: 14, lineHeight: 1.5, margin: "8px 0 0", color: "var(--ink-soft)" }}>
          Bonjour {user.firstName}. La gestion des agents, des comptes et des paramètres arrive avec le lot 2.
        </p>
      </Card>
      <div style={{ marginTop: "auto", paddingTop: 24 }}>
        <LogoutButton isAdmin />
      </div>
    </Screen>
  );
}
