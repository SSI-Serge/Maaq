"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { apiRequest, newIdempotencyKey } from "@/client/api";
import { fetchAuthState } from "@/client/auth";
import { useApiQuery } from "@/client/hooks";
import { PresentationPlayer } from "@/components/presentation/PresentationPlayer";
import { Button, Loading, Screen } from "@/components/ui";
import type { PresentationView } from "@/server/presentation/service";
import styles from "@/components/auth/auth.module.css";

/**
 * « Découvrir MAAQ » (US-140) : écran plein proposé UNE fois par profil, après l'activation, le schéma, les conditions et le guidage d'installation, avant le premier écran de
 * l'application ou la configuration initiale. « Passer », la fin de la vidéo et « Continuer » après un échec de chargement l'enregistrent comme vu puis reprennent le parcours : l'échec
 * ne bloque jamais l'inscription (RF8).
 */
export default function DiscoverPage() {
  const router = useRouter();
  const query = useApiQuery<{ presentation: PresentationView | null; secondaryGuest: boolean }>("/api/presentation");
  const [failed, setFailed] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const data = query.data;

  /** Marque l'écran comme vu, puis va où le parcours le demande (configuration initiale ou application). Une erreur réseau n'empêche pas de continuer. */
  const going = useRef(false);
  async function go() {
    if (going.current) return;
    going.current = true;
    await apiRequest("/api/presentation/seen", { method: "POST", idempotencyKey: newIdempotencyKey() }).catch(() => undefined);
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
    <Screen>
      <div className={styles.eyebrow}>Bienvenue</div>
      <h1 className={styles.title}>Découvrir MAAQ en 1 minute</h1>
      <p className={styles.lead}>Un aperçu de tout ce que MAAQ peut faire pour votre famille.</p>
      {query.loading && !data && <Loading slow={query.slow} />}
      {query.error && !data && (
        <>
          <p className={styles.lead}>La vidéo n&apos;a pas pu être chargée. Vous la retrouverez dans Réglages › Aide.</p>
          <Button block onClick={proceed} loading={leaving}>
            Continuer
          </Button>
        </>
      )}
      {data?.presentation && (
        <PresentationPlayer presentation={data.presentation} secondaryGuest={data.secondaryGuest} onEnded={proceed} onFailed={() => setFailed(true)}>
          <div className={styles.footer}>
            <Button variant={failed ? "primary" : "secondary"} block onClick={proceed} loading={leaving}>
              {failed ? "Continuer" : "Passer"}
            </Button>
          </div>
        </PresentationPlayer>
      )}
    </Screen>
  );
}
