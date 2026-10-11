"use client";

import { BackLink, PageHead, adminStyles as s } from "@/components/admin/AdminShell";
import { SupportForm } from "@/components/settings/SupportForm";

/** Aide et support de l'administrateur (US-62, US-63) : même contenu que pour les autres profils, sur ordinateur. */
export default function AdminSupportPage() {
  return (
    <>
      <BackLink href="/admin/reglages">Réglages</BackLink>
      <PageHead title="Aide et support" />
      <section className={s.panel} style={{ maxWidth: 620 }}>
        <SupportForm />
      </section>
    </>
  );
}
