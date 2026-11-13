"use client";

import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { ApiError, apiRequest } from "@/client/api";
import { AuthScreen, Heading } from "@/components/auth/parts";
import { Button, ButtonLink, Loading, Notice } from "@/components/ui";

interface View {
  firstName: string;
  newEmail: string;
}

/** Confirmation, par l'invité, de son nouvel email de connexion (US-19) : le lien reçu à la nouvelle adresse mène ici. */
export default function ConfirmEmailPage() {
  return (
    <Suspense>
      <ConfirmEmail />
    </Suspense>
  );
}

function ConfirmEmail() {
  const token = useSearchParams().get("jeton") ?? "";
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, setPending] = useState(false);

  const call = (apply: boolean) => apiRequest<View>("/api/guests/email-confirmation", { method: "POST", body: { token, apply } });
  const message = (err: unknown) => (err instanceof ApiError && err.kind !== "server" ? err.message : "La confirmation n'a pas abouti. Réessayez dans un instant.");

  useEffect(() => {
    let cancelled = false;
    call(false)
      .then((v) => !cancelled && setView(v))
      .catch((err) => !cancelled && setError(message(err)));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      setView(await call(true));
      setDone(true);
    } catch (err) {
      setError(message(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <AuthScreen>
      <Heading title="Nouvel email de connexion" />
      {!view && !error && <Loading />}
      {error && <Notice tone="error">{error}</Notice>}
      {view && !done && (
        <>
          <p>
            Bonjour {view.firstName}. Confirmez-vous que <b>{view.newEmail}</b> devient l&apos;email de connexion de votre accès MAAQ ?
          </p>
          <p>Tant que vous n&apos;avez pas confirmé, votre email de connexion actuel reste le seul valable.</p>
          <Button block loading={pending} onClick={() => void confirm()}>
            Confirmer ce nouvel email
          </Button>
        </>
      )}
      {done && view && (
        <>
          <Notice tone="success">C&apos;est fait. Votre email de connexion est maintenant {view.newEmail}.</Notice>
          <ButtonLink href="/connexion">Se connecter</ButtonLink>
        </>
      )}
    </AuthScreen>
  );
}
