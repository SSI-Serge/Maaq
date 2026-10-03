"use client";

import { AppShell } from "@/components/app/AppShell";
import { useSessionUser } from "@/components/auth/AuthGate";
import { SupportForm } from "@/components/settings/SupportForm";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Aide et support (US-62, US-63), maquette Support. */
export default function SupportPage() {
  const user = useSessionUser();
  const router = useRouter();
  // L'administrateur a son propre écran dans la console.
  useEffect(() => {
    if (user.role === "admin") router.replace("/admin/support");
  }, [user.role, router]);
  if (user.role === "admin") return null;
  return (
    <AppShell title="Contacter le support" back={{ href: "/reglages", label: "Réglages" }}>
      <SupportForm />
    </AppShell>
  );
}
