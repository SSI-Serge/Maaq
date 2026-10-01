"use client";

import { PageHead, adminStyles as s } from "@/components/admin/AdminShell";
import { useSessionUser } from "@/components/auth/AuthGate";
import { LogoutButton } from "@/components/auth/LogoutButton";

/** Réglages de l'administrateur : profil et déconnexion (US-9). La boîte du support arrive au lot 8. */
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
        <div style={{ marginTop: 20, maxWidth: 260 }}>
          <LogoutButton isAdmin />
        </div>
      </section>
    </>
  );
}
