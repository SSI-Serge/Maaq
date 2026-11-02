"use client";

import { useApiQuery } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import { PresentationPlayer } from "@/components/presentation/PresentationPlayer";
import { Loading, Notice } from "@/components/ui";
import type { PresentationView } from "@/server/presentation/service";

/** « Revoir la présentation » (US-140 RF5), dans Réglages › Aide : le même lecteur, sans rien enregistrer. */
export default function ReplayPresentationPage() {
  const query = useApiQuery<{ presentation: PresentationView | null; secondaryGuest: boolean }>("/api/presentation");
  const data = query.data;
  return (
    <AppShell title="Découvrir MAAQ" subtitle="Tout ce que MAAQ peut faire pour votre famille, en 1 minute." back={{ href: "/reglages", label: "Réglages" }}>
      {query.loading && !data && <Loading slow={query.slow} />}
      {query.error && !data && <Notice tone="warning">La vidéo n&apos;a pas pu être chargée. Réessayez dans un instant.</Notice>}
      {data && !data.presentation && <Notice tone="info">La présentation n&apos;est pas disponible pour le moment.</Notice>}
      {data?.presentation && <PresentationPlayer presentation={data.presentation} secondaryGuest={data.secondaryGuest} />}
    </AppShell>
  );
}
