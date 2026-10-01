"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ApiError, apiRequest, newIdempotencyKey } from "@/client/api";
import { useApiQuery } from "@/client/hooks";
import { appStyles as s } from "@/components/app/AppShell";
import { useSessionReload } from "@/components/auth/AuthGate";
import { ErrorLine } from "@/components/auth/parts";
import { Button, Field, Loading, Notice, Screen } from "@/components/ui";

interface Setup {
  step: "step_1_my_info" | "step_2_guest_info" | "completed";
  me: { firstName: string; lastName: string; email: string };
  coreGuest: { firstName: string; lastName: string; email: string; phone: string | null; invited: boolean } | null;
}

const EMAIL_FORMAT = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Configuration initiale de l'utilisateur principal, en deux étapes (US-10, US-11), maquette Onboarding. */
export default function InitialSetupPage() {
  const setup = useApiQuery<Setup>("/api/setup");
  if (setup.loading && !setup.data) {
    return (
      <Screen>
        <Loading slow={setup.slow} />
      </Screen>
    );
  }
  if (!setup.data) {
    return (
      <Screen>
        <ErrorLine error={setup.error} onRetry={setup.reload} />
      </Screen>
    );
  }
  return <SetupFlow initial={setup.data} />;
}

function SetupFlow({ initial }: { initial: Setup }) {
  const router = useRouter();
  const reloadSession = useSessionReload();
  const [step, setStep] = useState<1 | 2>(initial.step === "step_1_my_info" ? 1 : 2);
  const [me, setMe] = useState({ firstName: initial.me.firstName, lastName: initial.me.lastName });
  const [guest, setGuest] = useState({
    firstName: initial.coreGuest?.firstName ?? "",
    lastName: initial.coreGuest?.lastName ?? "",
    email: initial.coreGuest?.email ?? "",
    phone: initial.coreGuest?.phone ?? "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError>();

  const step1Valid = me.firstName.trim() !== "" && me.lastName.trim() !== "";

  async function saveStep1() {
    setPending(true);
    setError(undefined);
    try {
      await apiRequest("/api/setup/me", { method: "POST", body: me, idempotencyKey: newIdempotencyKey() });
      setStep(2);
    } catch (err) {
      const apiError = err as ApiError;
      if (apiError.body?.code === "invalid_info") setErrors(apiError.body.details as Record<string, string>);
      else setError(apiError);
    } finally {
      setPending(false);
    }
  }

  async function finish(withGuest: boolean) {
    if (withGuest) {
      const found: Record<string, string> = {};
      if (!guest.firstName.trim()) found.firstName = "Ce champ est obligatoire";
      if (!guest.lastName.trim()) found.lastName = "Ce champ est obligatoire";
      if (!EMAIL_FORMAT.test(guest.email.trim())) found.email = "Adresse email invalide";
      setErrors(found);
      if (Object.keys(found).length) return;
    }
    setPending(true);
    setError(undefined);
    try {
      await apiRequest("/api/setup/complete", { method: "POST", body: { guest: withGuest ? guest : null }, idempotencyKey: newIdempotencyKey() });
      await reloadSession();
      router.replace("/accueil");
    } catch (err) {
      const apiError = err as ApiError;
      if (apiError.body?.code === "invalid_guest") setErrors(apiError.body.details as Record<string, string>);
      else setError(apiError);
    } finally {
      setPending(false);
    }
  }

  return (
    <Screen>
      <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--secondary-strong)", fontWeight: 700 }}>
        Configuration initiale
      </div>
      <h1 style={{ fontSize: 26, margin: "8px 0 4px" }}>{step === 1 ? "Vos informations" : "Votre invité"}</h1>
      <p className={s.muted}>Étape {step} sur 2 — modifiable à tout moment depuis Réglages</p>
      <div className={s.steps} aria-hidden>
        <div className={`${s.stepBar} ${s.stepBarOn}`} />
        <div className={`${s.stepBar} ${step === 2 ? s.stepBarOn : ""}`} />
      </div>

      {step === 1 ? (
        <div className={s.form} style={{ marginTop: 14 }}>
          <Field
            label="Prénom *"
            value={me.firstName}
            error={errors.firstName}
            maxLength={100}
            onChange={(e) => {
              setMe({ ...me, firstName: e.target.value });
              setErrors({ ...errors, firstName: "" });
            }}
            onBlur={() => !me.firstName.trim() && setErrors({ ...errors, firstName: "Ce champ est obligatoire" })}
          />
          <Field
            label="Nom *"
            value={me.lastName}
            error={errors.lastName}
            maxLength={100}
            onChange={(e) => {
              setMe({ ...me, lastName: e.target.value });
              setErrors({ ...errors, lastName: "" });
            }}
            onBlur={() => !me.lastName.trim() && setErrors({ ...errors, lastName: "Ce champ est obligatoire" })}
          />
          <Field label="Email de connexion" type="email" value={initial.me.email} disabled readOnly hint="L'email de connexion n'est pas modifiable." />
          <p className={s.muted}>
            Les autres informations (adresse, téléphone, situation…) vous seront demandées au fil de l&apos;eau, à l&apos;ajout d&apos;un agent qui en a
            besoin.
          </p>
          <ErrorLine error={error} onRetry={saveStep1} />
          <Button block loading={pending} disabled={!step1Valid} onClick={saveStep1}>
            Suivant
          </Button>
        </div>
      ) : (
        <div className={s.form} style={{ marginTop: 14 }}>
          {initial.coreGuest?.invited ? (
            <Notice tone="info">
              Votre invité 1, {initial.coreGuest.firstName} {initial.coreGuest.lastName}, est déjà enregistré. Vous pourrez gérer vos invités depuis
              l&apos;onglet Invités.
            </Notice>
          ) : (
            <>
              <Field label="Prénom de votre invité" value={guest.firstName} error={errors.firstName} maxLength={100} onChange={(e) => setGuest({ ...guest, firstName: e.target.value })} />
              <Field label="Nom de votre invité" value={guest.lastName} error={errors.lastName} maxLength={100} onChange={(e) => setGuest({ ...guest, lastName: e.target.value })} />
              <Field label="Email de l'invité" type="email" value={guest.email} error={errors.email} placeholder="julien@exemple.fr" onChange={(e) => setGuest({ ...guest, email: e.target.value })} />
              <Field label="Téléphone de l'invité (facultatif)" type="tel" value={guest.phone} error={errors.phone} placeholder="06 98 76 54 32" onChange={(e) => setGuest({ ...guest, phone: e.target.value })} />
              <Notice tone="info">
                Optionnel à cette étape — votre invité deviendra votre « Invité 1 ». L&apos;invitation lui sera envoyée depuis l&apos;onglet Invités.
              </Notice>
            </>
          )}
          <ErrorLine error={error} onRetry={() => finish(!initial.coreGuest?.invited)} />
          <Button block loading={pending} onClick={() => finish(!initial.coreGuest?.invited)}>
            Terminer
          </Button>
          <div className={s.row}>
            <button type="button" className={s.smallButton} disabled={pending} onClick={() => setStep(1)}>
              ‹ Retour
            </button>
            {!initial.coreGuest?.invited && (
              <button type="button" className={s.smallButton} disabled={pending} onClick={() => finish(false)}>
                Passer cette étape
              </button>
            )}
          </div>
        </div>
      )}
    </Screen>
  );
}
