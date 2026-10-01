"use client";

import Link from "next/link";
import { useSessionUser } from "@/components/auth/AuthGate";
import { LogoutButton } from "@/components/auth/LogoutButton";
import { Card, Eyebrow, Screen } from "@/components/ui";

/** Réglages (US-49). Ce lot n'y place que la déconnexion (US-9) ; le reste arrive au lot 8. */
export default function SettingsPage() {
  const user = useSessionUser();
  return (
    <Screen>
      <Link href={user.role === "admin" ? "/admin" : "/accueil"} style={{ fontSize: 13, color: "var(--secondary-strong)", fontWeight: 600 }}>
        ← Retour
      </Link>
      <h1 style={{ fontSize: 26, margin: "16px 0 20px" }}>Réglages</h1>
      <Card>
        <Eyebrow>Mon profil</Eyebrow>
        <div style={{ fontSize: 15, fontWeight: 600, marginTop: 8 }}>{user.firstName}</div>
        <div style={{ fontSize: 13, color: "var(--ink-soft)" }}>{user.maskedEmail}</div>
      </Card>
      <div style={{ marginTop: "auto", paddingTop: 24, display: "flex", flexDirection: "column", gap: 8 }}>
        <LogoutButton isAdmin={user.role === "admin"} />
        {user.role !== "admin" && (
          <p style={{ fontSize: 12, color: "var(--ink-soft)", textAlign: "center", margin: 0, lineHeight: 1.5 }}>
            La déconnexion efface l&apos;historique de vos conversations avec les agents.
          </p>
        )}
      </div>
    </Screen>
  );
}
