"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { LegalViewer } from "@/components/legal/LegalViewer";
import { Logo, Screen } from "@/components/ui";

/** Adresse de retour proposée par l'écran d'origine : seulement un chemin interne. */
function safeBack(value: string | null): string {
  return value && /^\/[A-Za-z0-9_\-/]*$/.test(value) && !value.startsWith("//") ? value : "/connexion";
}

/** Confidentialité et conditions d'utilisation (US-54), consultables sans être connecté (RF1), maquette Confidentialité. */
export default function PrivacyPage() {
  return (
    <Suspense>
      <Privacy />
    </Suspense>
  );
}

function Privacy() {
  const params = useSearchParams();
  const back = safeBack(params.get("retour"));
  return (
    <Screen>
      <Logo />
      <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 14 }}>
        <Link href={back} style={{ fontSize: 13, fontWeight: 600, color: "var(--secondary-strong)" }}>
          ‹ Retour
        </Link>
        <h1 style={{ fontSize: 26 }}>Confidentialité et conditions d&apos;utilisation</h1>
        <LegalViewer initial={params.get("document") === "conditions" ? "terms_of_use" : "privacy_policy"} />
      </div>
    </Screen>
  );
}
