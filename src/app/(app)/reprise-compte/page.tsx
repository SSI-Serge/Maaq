"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { signOut } from "@/client/auth";
import { useApiQuery } from "@/client/hooks";
import { ErrorLine } from "@/components/auth/parts";
import { Button, Card, Eyebrow, Loading, Logo, Screen } from "@/components/ui";

type Grace = { role: "primary_user" | "guest" | "admin"; deleteDate: string | null; origin: "in_app_request" | "billing_unsubscribe" | null };

/**
 * Compte en délai de grâce (US-3 RF11), maquette Reprise de compte. Ce lot affiche la date de
 * suppression ; l'annulation de la suppression (US-59) arrive au lot 9.
 */
export default function GracePeriodPage() {
  const router = useRouter();
  const grace = useApiQuery<Grace>("/api/account/grace");
  const [leaving, setLeaving] = useState(false);

  const date = grace.data?.deleteDate
    ? new Intl.DateTimeFormat("fr-FR", { dateStyle: "long" }).format(new Date(grace.data.deleteDate))
    : null;

  return (
    <Screen>
      <Logo />
      <div style={{ marginTop: 36, display: "flex", flexDirection: "column", gap: 14 }}>
        {grace.loading && <Loading slow={grace.slow} />}
        <ErrorLine error={grace.error} onRetry={grace.reload} />
        {grace.data && (
          <>
            <Eyebrow>Délai de grâce</Eyebrow>
            <h1 style={{ fontSize: 24, lineHeight: 1.3 }}>
              {grace.data.role === "guest" ? "Votre compte invité" : "Votre compte"} sera supprimé{date ? ` le ${date}` : " prochainement"}.
            </h1>
            <p style={{ fontSize: 14, color: "var(--ink-soft)", lineHeight: 1.5, margin: 0 }}>
              {grace.data.origin === "billing_unsubscribe"
                ? "Après un désabonnement, la reprise du compte suppose un nouvel abonnement, souscrit hors de l'application. Contactez MAAQ pour vous réabonner."
                : "Vous avez demandé la suppression de votre compte et de vos données depuis les Réglages."}
            </p>
            <Card>
              <p style={{ fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.5, margin: 0 }}>
                Passé ce délai, le compte n&apos;existe plus : une connexion renverra le message « Email ou mot de passe incorrect ».
              </p>
            </Card>
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
