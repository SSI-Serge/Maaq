"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { apiRequest, newIdempotencyKey } from "@/client/api";
import { fetchAuthState } from "@/client/auth";
import { useApiQuery } from "@/client/hooks";
import { PresentationPage } from "@/components/presentation/PresentationPlayer";
import type { PresentationView } from "@/server/presentation/service";

/**
 * « Découvrir MAAQ » (US-140) : écran plein proposé UNE fois par profil, après l'activation, le schéma, les conditions et le guidage d'installation, avant le premier écran de
 * l'application ou la configuration initiale. « Passer », la fin de la vidéo et « Continuer » (après la fin ou un échec de chargement) l'enregistrent comme vu ; l'échec ne bloque jamais
 * l'inscription (RF8).
 */
export default function DiscoverPage() {
  const router = useRouter();
  const query = useApiQuery<{ presentation: PresentationView | null; secondaryGuest: boolean }>("/api/presentation");
  const [leaving, setLeaving] = useState(false);
  const data = query.data;
  const marked = useRef<Promise<unknown> | null>(null);
  const going = useRef(false);

  /** Enregistre « vu » (une seule fois par passage sur l'écran). Une erreur réseau n'empêche pas de continuer. */
  function markSeen() {
    marked.current ??= apiRequest("/api/presentation/seen", { method: "POST", idempotencyKey: newIdempotencyKey() }).catch(() => undefined);
    return marked.current;
  }

  /** Va où le parcours le demande (configuration initiale ou application). */
  async function go() {
    if (going.current) return;
    going.current = true;
    await markSeen();
    const state = await fetchAuthState().catch(() => null);
    router.replace(state?.authenticated && state.home !== "/decouvrir" ? state.home : "/accueil");
  }
  function proceed() {
    setLeaving(true);
    void go();
  }

  // Aucune vidéo configurée : rien à montrer, on ne bloque personne.
  const nothingToShow = data !== undefined && !data.presentation;
  useEffect(() => {
    if (nothingToShow) void go();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nothingToShow]);

  return (
    <PresentationPage
      origin="onboarding"
      presentation={data?.presentation}
      secondaryGuest={data?.secondaryGuest}
      loading={query.loading && !data}
      error={Boolean(query.error && !data)}
      onSeen={() => void markSeen()}
      onContinue={proceed}
      busy={leaving}
    />
  );
}
