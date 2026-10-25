"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { apiRequest } from "@/client/api";
import { markRemindersSeen, usePush } from "@/client/push";
import { AppShell } from "@/components/app/AppShell";
import { Button, ButtonLink, Loading, Notice, RetryNotice } from "@/components/ui";
import styles from "./family.module.css";

const IOS_FIRST_SENTENCE = "Sur iPhone, l'autorisation de notification ne peut être demandée qu'après l'installation de l'application.";

/**
 * Activation des rappels (US-94, maquette RDV-Activer-Rappels) : le bouton « Activer mes rappels » déclenche la demande d'autorisation du téléphone,
 * jamais avant l'appui. Selon l'appareil : installer MAAQ d'abord, mise à jour d'iOS nécessaire, autorisation refusée, ou déjà activée.
 * Sans notification, les rappels partent par email.
 */
export function RemindersScreen() {
  const router = useRouter();
  const push = usePush();
  const [test, setTest] = useState<"idle" | "sending" | "sent" | "none" | "failed">("idle");

  // L'écran a été montré : il ne s'ouvrira plus tout seul ; un bandeau de l'accueil prend le relais (US-94 RF6).
  useEffect(() => {
    markRemindersSeen();
  }, []);

  const { state, pending, error } = push;
  const ios = state === "ios_install" || state === "ios_too_old" || /iPhone|iPad|iPod/.test(typeof navigator === "undefined" ? "" : navigator.userAgent);

  async function sendTest() {
    setTest("sending");
    try {
      const { delivered } = await apiRequest<{ delivered: number }>("/api/push/test", { method: "POST" });
      setTest(delivered > 0 ? "sent" : "none");
    } catch {
      setTest("failed");
    }
  }

  return (
    <AppShell title="Activez vos rappels de rendez-vous" back={{ href: "/assistant", label: "Assistant Famille" }}>
      {state === "checking" && !push.loadError && <Loading />}
      {push.loadError && <RetryNotice message="L'état des notifications n'a pas pu être chargé." onRetry={push.reload} />}

      {(state === "ready" || state === "ios_install") && (
        <>
          <p className={styles.reminderText}>
            {ios && `${IOS_FIRST_SENTENCE} `}
            Activez-la maintenant pour recevoir vos rappels à J‑7, J‑1 et le jour J.
          </p>
          {state === "ios_install" ? (
            <ButtonLink href="/installer">Installer MAAQ d&apos;abord</ButtonLink>
          ) : (
            <Button onClick={() => void push.enable()} loading={pending}>
              {pending ? "Activation…" : "Activer mes rappels"}
            </Button>
          )}
          {error === "failed" && <RetryNotice message="Les rappels n'ont pas pu être activés." onRetry={() => void push.enable()} />}
          {error === "slow" && <RetryNotice message="La connexion est lente : l'activation n'a pas abouti." onRetry={() => void push.enable()} />}
          <button type="button" className={styles.link} onClick={() => router.push("/assistant")}>
            Plus tard
          </button>
          <p className={styles.hint}>Sans notification, vos rappels vous sont envoyés par email.</p>
        </>
      )}

      {state === "enabled" && (
        <>
          <Notice tone="success">✓ Rappels activés</Notice>
          <p className={styles.reminderText}>Cet appareil recevra vos rappels de rendez-vous et les relances de confirmation. Le rappel de la veille est aussi envoyé par email.</p>
          <Button variant="secondary" onClick={() => void sendTest()} loading={test === "sending"}>
            Envoyer une notification de test
          </Button>
          {test === "sent" && <Notice tone="success">Notification envoyée : elle doit arriver dans quelques secondes.</Notice>}
          {test === "none" && <Notice tone="warning">Aucun appareil n&apos;a pu être joint. Réessayez dans un instant.</Notice>}
          {test === "failed" && <Notice tone="error">La notification de test n&apos;a pas pu être envoyée.</Notice>}
          <Link href="/assistant" className={styles.link}>
            Retour à l&apos;assistant ›
          </Link>
        </>
      )}

      {state === "denied" && (
        <>
          <Notice tone="warning">
            Les notifications sont bloquées. Vous recevrez vos rappels par email. Pour les réactiver, ouvrez les réglages de votre téléphone, puis MAAQ, puis Notifications.
          </Notice>
          <Link href="/assistant" className={styles.link}>
            Retour à l&apos;assistant ›
          </Link>
        </>
      )}

      {state === "ios_too_old" && (
        <>
          <Notice tone="info">Une mise à jour d&apos;iOS est nécessaire pour recevoir les rappels par notification. Vous les recevrez par email.</Notice>
          <Link href="/assistant" className={styles.link}>
            Retour à l&apos;assistant ›
          </Link>
        </>
      )}

      {state === "unsupported" && (
        <>
          <Notice tone="info">Ce navigateur ne gère pas les notifications. Vous recevrez vos rappels par email.</Notice>
          <Link href="/assistant" className={styles.link}>
            Retour à l&apos;assistant ›
          </Link>
        </>
      )}

      {state === "unavailable" && (
        <>
          <Notice tone="info">Les notifications ne sont pas encore disponibles. Vous recevez vos rappels par email.</Notice>
          <Link href="/assistant" className={styles.link}>
            Retour à l&apos;assistant ›
          </Link>
        </>
      )}
    </AppShell>
  );
}
