"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { signOut } from "@/client/auth";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { useSessionReload } from "@/components/auth/AuthGate";
import { ErrorLine } from "@/components/auth/parts";
import { Button, Card, Eyebrow, Loading, Logo, Notice, Screen } from "@/components/ui";

type Grace = {
  role: "primary_user" | "guest" | "admin";
  deleteDate: string | null;
  origin: "in_app_request" | "billing_unsubscribe" | null;
  accountSuspended: boolean;
  primaryFirstName: string | null;
};

/**
 * Compte en délai de grâce (US-3 RF11, US-59), maquette Reprise de compte : date de suppression, « Annuler la
 * suppression » et « Se déconnecter ». Un invité ne peut reprendre que son propre compte, jamais celui que
 * l'utilisateur principal a quitté (RF9).
 */
export default function GracePeriodPage() {
  const router = useRouter();
  const reload = useSessionReload();
  const grace = useApiQuery<Grace>("/api/account/grace");
  const cancel = useApiMutation();
  const [leaving, setLeaving] = useState(false);

  const date = grace.data?.deleteDate ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "long" }).format(new Date(grace.data.deleteDate)) : null;
  const canResume = grace.data ? grace.data.role === "primary_user" || !grace.data.accountSuspended : false;

  async function resume() {
    const result = await cancel.run("/api/account/grace/cancel", { method: "POST" });
    if (!result) return;
    await reload();
    router.replace("/accueil");
  }

  return (
    <Screen>
      <Logo />
      <div style={{ marginTop: 36, display: "flex", flexDirection: "column", gap: 14 }}>
        {grace.loading && !grace.data && <Loading slow={grace.slow} />}
        <ErrorLine error={grace.error} onRetry={grace.reload} />
        {grace.data && (
          <>
            <Eyebrow>Délai de grâce</Eyebrow>
            <h1 style={{ fontSize: 24, lineHeight: 1.3 }}>
              Votre compte sera supprimé{date ? ` le ${date}` : " prochainement"}.
            </h1>
            <p style={{ fontSize: 14, color: "var(--ink-soft)", lineHeight: 1.5, margin: 0 }}>
              {grace.data.role === "guest" && grace.data.accountSuspended
                ? `Le compte de ${grace.data.primaryFirstName ?? "l'utilisateur principal"} est en cours de suppression : votre accès est suspendu. Seul ${grace.data.primaryFirstName ?? "l'utilisateur principal"} peut reprendre le compte.`
                : grace.data.origin === "billing_unsubscribe"
                  ? "Après un désabonnement, la reprise du compte suppose un nouvel abonnement, souscrit hors de l'application. Contactez MAAQ pour vous réabonner."
                  : "La suppression de votre compte et de vos données a été demandée depuis les Réglages. Vous pouvez encore l'annuler."}
            </p>
            <Card>
              <p style={{ fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.5, margin: 0 }}>
                Passé ce délai, le compte n&apos;existe plus : une connexion renverra le message « Email ou mot de passe incorrect ».
              </p>
            </Card>
            {canResume &&
              (cancel.error?.body?.code === "resubscribe_required" ? <Notice tone="warning">{cancel.error.message}</Notice> : <ErrorLine error={cancel.error} onRetry={resume} />)}
            {canResume && (
              <Button block loading={cancel.pending} onClick={resume}>
                Annuler la suppression
              </Button>
            )}
          </>
        )}
        <Button
          variant="secondary"
          block
          loading={leaving}
          onClick={async () => {
            setLeaving(true);
            await signOut();
            router.replace("/connexion");
          }}
        >
          Se déconnecter
        </Button>
      </div>
    </Screen>
  );
}
