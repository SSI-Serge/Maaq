"use client";

import Link from "next/link";
import { PageHead, adminStyles as s } from "@/components/admin/AdminShell";
import { useSessionUser } from "@/components/auth/AuthGate";
import { LogoutButton } from "@/components/auth/LogoutButton";

/** Réglages de l'administrateur : aide et support, profil et déconnexion (US-49 RF4, US-9). */
export default function AdminSettingsAccountPage() {
  const user = useSessionUser();
  return (
    <>
      <PageHead title="Réglages" />
      <section className={s.panel} style={{ maxWidth: 520 }}>
        <div className={s.panelTitle}>Mon profil</div>
        <dl className={s.dl}>
          <dt>Prénom</dt>
          <dd>{user.firstName}</dd>
          <dt>Email</dt>
          <dd>{user.maskedEmail}</dd>
          <dt>Rôle</dt>
          <dd>Administrateur</dd>
        </dl>
        <div style={{ marginTop: 20, maxWidth: 260, display: "flex", flexDirection: "column", gap: 10 }}>
          <Link href="/admin/support" className={s.linkButton}>
            Aide et support
          </Link>
          <LogoutButton isAdmin />
        </div>
      </section>
    </>
  );
}
