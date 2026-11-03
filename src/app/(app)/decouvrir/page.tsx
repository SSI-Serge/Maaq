"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { apiRequest, newIdempotencyKey } from "@/client/api";
import { fetchAuthState, presentationSkip, withPresentationSkip } from "@/client/auth";
import { useApiQuery } from "@/client/hooks";
import { useSessionReload } from "@/components/auth/AuthGate";
import { PresentationPage } from "@/components/presentation/PresentationPlayer";
import type { PresentationView } from "@/server/presentation/service";

/**
 * « Découvrir MAAQ » (US-140) : écran plein proposé UNE fois par profil, après l'activation, le schéma, les conditions et le guidage d'installation, avant le premier écran de
 * l'application ou la configuration initiale. « Passer », la fin de la vidéo et « Continuer » (après la fin ou un échec de chargement) l'enregistrent comme vu ; l'échec ne bloque jamais
 * l'inscription (RF8).
 */
export default function DiscoverPage() {
  const router = useRouter();
  const reloadSession = useSessionReload();
  const query = useApiQuery<{ presentation: PresentationView | null; secondaryGuest: boolean }>("/api/presentation");
  const [leaving, setLeaving] = useState(false);
  const data = query.data;
  const marked = useRef<Promise<boolean> | null>(null);
  const going = useRef(false);

  /** Enregistre « vu » (une seule fois par passage sur l'écran) ; faux si l'enregistrement a échoué. */
  function markSeen(): Promise<boolean> {
    marked.current ??= apiRequest("/api/presentation/seen", { method: "POST", idempotencyKey: newIdempotencyKey() }).then(
      () => true,
      () => false,
    );
    return marked.current;
  }

  /**
   * Va où le parcours le demande (configuration initiale ou application). La garde de l'espace connecté garde l'état lu à l'ouverture de l'écran (« Découvrir MAAQ » à faire) : elle est
   * relue avant de partir, sinon elle renverrait aussitôt sur la vidéo. Un enregistrement en échec ne bloque jamais (US-140 RF8) : l'appareil retient de passer et réessaie plus tard.
   */
  async function go(): Promise<boolean> {
    if (going.current) return true;
    going.current = true;
    if (!(await markSeen())) presentationSkip.set();
    const received = await fetchAuthState().catch(() => null);
    if (!received?.authenticated) {
      // État illisible (réseau) : on reste sur l'écran, les boutons restent utilisables.
      going.current = false;
      marked.current = null;
      return false;
    }
    const state = withPresentationSkip(received);
    await reloadSession().catch(() => undefined);
    router.replace(state.authenticated && state.home !== "/decouvrir" ? state.home : "/accueil");
    return true;
  }
  function proceed() {
    setLeaving(true);
    void go().then((left) => {
      if (!left) setLeaving(false);
    });
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
