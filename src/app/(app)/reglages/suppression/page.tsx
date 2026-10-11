"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { clearAllDrafts, useApiMutation } from "@/client/hooks";
import { AppShell, Section, appStyles as s } from "@/components/app/AppShell";
import { useSessionUser } from "@/components/auth/AuthGate";
import { ErrorLine } from "@/components/auth/parts";
import { Button, Field, Notice } from "@/components/ui";

/**
 * Suppression des données et du compte (US-56) : conséquences, délai de grâce de 30 jours, confirmation par le
 * mot de passe. Pour l'utilisateur principal, la suppression vaut désabonnement et concerne aussi ses invités.
 */
export default function DeleteAccountPage() {
  const user = useSessionUser();
  const router = useRouter();
  const [password, setPassword] = useState("");
  const deletion = useApiMutation();
  const isPrimary = user.role === "primary_user";
  const label = isPrimary ? "Désabonnement et suppression du compte" : "Supprimer mon compte et mes données";

  // L'administrateur n'a pas cette rubrique (US-49 RF4).
  useEffect(() => {
    if (user.role === "admin") router.replace("/admin/reglages");
  }, [user.role, router]);
  if (user.role === "admin") return null;

  async function confirm() {
    const result = await deletion.run<{ purgeAt: string }>("/api/account/delete", { method: "POST", body: { password } });
    if (!result) return;
    // Toutes les sessions sont fermées, celle-ci comprise : brouillons effacés, retour à la connexion.
    clearAllDrafts();
    router.replace("/connexion");
  }

  return (
    <AppShell title={label} back={{ href: "/reglages", label: "Réglages" }}>
      <Section title="Ce qui sera supprimé">
        <p className={s.text}>
          {isPrimary
            ? "Votre compte et vos données : informations de configuration des agents, contrats et documents, adresses des connecteurs, carnet de bord. Cela vaut désabonnement."
            : "Votre profil et vos données : vos informations, vos adresses en copie et votre configuration."}
        </p>
        {isPrimary ? (
          <p className={s.text}>
            <b>Les comptes de tous vos invités seront aussi supprimés</b> ; leur accès est coupé dès votre confirmation et ils en sont informés par email.
          </p>
        ) : (
          <p className={s.text}>
            Vos demandes resteront dans le carnet de bord partagé, <b>sans votre nom</b>. Les informations de contrats que vous avez renseignées restent, car elles appartiennent au compte partagé.
          </p>
        )}
      </Section>

      <Section title="Délai de grâce de 30 jours">
        <p className={s.text}>
          La suppression n&apos;est pas immédiate : vous êtes déconnecté de tous vos appareils et un email vous indique la date de suppression définitive. Pendant 30 jours, vous pouvez vous reconnecter et annuler la
          suppression.
          {isPrimary && " Après un désabonnement fait hors de l'application, la reprise suppose un nouvel abonnement."}
        </p>
      </Section>

      <form
        className={s.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (password) void confirm();
        }}
      >
        <Field
          label="Confirmez avec votre mot de passe"
          type="password"
          autoComplete="current-password"
          placeholder="••••••••"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
            if (deletion.error) deletion.reset();
          }}
        />
        {deletion.error?.body?.code === "wrong_password" ? <Notice tone="error">{deletion.error.message}</Notice> : <ErrorLine error={deletion.error} onRetry={confirm} />}
        <Button type="submit" variant="danger" block loading={deletion.pending} disabled={!password}>
          Confirmer la suppression
        </Button>
        <Button type="button" variant="secondary" block disabled={deletion.pending} onClick={() => router.push("/reglages")}>
          Annuler
        </Button>
      </form>
    </AppShell>
  );
}
