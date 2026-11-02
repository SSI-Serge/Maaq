"use client";

import { useApiQuery } from "@/client/hooks";
import { PresentationPage } from "@/components/presentation/PresentationPlayer";
import type { PresentationView } from "@/server/presentation/service";

/** « Revoir la présentation » (US-140 RF5), dans Réglages › Aide : le même écran, sans rien enregistrer ; « Retour aux réglages » à la fin. */
export default function ReplayPresentationPage() {
  const query = useApiQuery<{ presentation: PresentationView | null; secondaryGuest: boolean }>("/api/presentation");
  const data = query.data;
  return (
    <PresentationPage
      origin="settings"
      presentation={data?.presentation}
      secondaryGuest={data?.secondaryGuest}
      loading={query.loading && !data}
      error={Boolean(query.error && !data)}
    />
  );
}
