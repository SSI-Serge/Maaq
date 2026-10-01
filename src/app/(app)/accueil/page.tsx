"use client";

import { useApiQuery } from "@/client/hooks";
import { AppShell, Section, appStyles as s } from "@/components/app/AppShell";
import { useSessionUser } from "@/components/auth/AuthGate";
import { ButtonLink } from "@/components/ui";

/**
 * Accueil du profil connecté. Le dashboard Pro / Perso (US-22) le complétera au lot 4.
 * Après la configuration initiale, on propose d'inviter un proche si personne ne l'est encore (US-11 RF8).
 */
export default function HomePage() {
  const user = useSessionUser();
  return (
    <AppShell title={`Bonjour ${user.firstName}`} subtitle={user.role === "guest" ? "Invité" : "Utilisateur principal"}>
      {user.role === "primary_user" && <InviteSuggestion />}
      <Section title="Mes agents">
        <p className={s.muted}>Votre dashboard d&apos;agents arrive avec le lot 4 : vous pourrez y ajouter des agents depuis le catalogue.</p>
      </Section>
    </AppShell>
  );
}

function InviteSuggestion() {
  const guests = useApiQuery<{ guests: unknown[]; quota: number }>("/api/guests");
  if (!guests.data || guests.data.guests.length > 0 || guests.data.quota === 0) return null;
  return (
    <Section title="Invitez un proche">
      <p className={s.text}>
        Votre plan vous permet d&apos;inviter {guests.data.quota} personne{guests.data.quota > 1 ? "s" : ""} à utiliser vos agents avec vous.
      </p>
      <ButtonLink href="/invites" block>
        Ajouter un invité
      </ButtonLink>
    </Section>
  );
}
