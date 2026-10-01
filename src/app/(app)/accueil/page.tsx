"use client";

import Link from "next/link";
import { useSessionUser } from "@/components/auth/AuthGate";
import { Card, Eyebrow, Logo, Screen } from "@/components/ui";

/** Accueil du profil connecté. Le dashboard Pro / Perso (US-22) le remplacera au lot 4. */
export default function HomePage() {
  const user = useSessionUser();
  return (
    <Screen>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <Logo />
        <Link href="/reglages" style={{ fontSize: 13, color: "var(--secondary-strong)", fontWeight: 600 }}>
          Réglages
        </Link>
      </div>
      <h1 style={{ fontSize: 26, margin: "32px 0 12px" }}>Bonjour {user.firstName}</h1>
      <Card>
        <Eyebrow>{user.role === "guest" ? "Invité" : "Utilisateur principal"}</Eyebrow>
        <p style={{ fontSize: 14, lineHeight: 1.5, margin: "8px 0 0", color: "var(--ink-soft)" }}>
          Vous êtes connecté. Votre dashboard d&apos;agents arrive avec le lot 4.
        </p>
      </Card>
    </Screen>
  );
}
