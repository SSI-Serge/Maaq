"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AgentInfoList } from "@/components/app/AgentInfoList";
import { AppShell, Section, appStyles as s } from "@/components/app/AppShell";
import { useSessionReload, useSessionUser } from "@/components/auth/AuthGate";
import { LogoutButton } from "@/components/auth/LogoutButton";
import { ConfirmDialog, ErrorLine } from "@/components/auth/parts";
import { Button, Field, Loading, Notice } from "@/components/ui";

interface Profile {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: "primary_user" | "guest" | "admin";
  guestRank: "core" | "secondary" | null;
}

interface GuestSummary {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  rank: "core" | "secondary";
}

/** Réglages de l'utilisateur principal et de l'invité (US-12, US-9), maquettes U-Réglages et I-Réglages. */
export default function SettingsPage() {
  const user = useSessionUser();
  const router = useRouter();
  const profile = useApiQuery<Profile>("/api/profile");

  // L'administrateur a ses propres réglages dans la console.
  useEffect(() => {
    if (user.role === "admin") router.replace("/admin/reglages");
  }, [user.role, router]);

  const roleLabel = user.role === "primary_user" ? "Utilisateur principal" : profile.data?.guestRank === "core" ? "Invité 1" : "Invité";

  return (
    <AppShell
      title="Réglages"
      subtitle={
        profile.data && (
          <>
            Connecté en tant que <b>{`${profile.data.firstName} ${profile.data.lastName}`}</b> — {roleLabel}
          </>
        )
      }
    >
      {profile.loading && !profile.data && <Loading slow={profile.slow} />}
      <ErrorLine error={profile.error} onRetry={profile.reload} />
      {profile.data && <MyInformation profile={profile.data} />}

      <Section title="Mes informations par agent">
        <p className={s.muted}>Chaque agent demande ses propres informations, au moment où vous l&apos;ajoutez.</p>
        <AgentInfoList emptyText="Aucun agent sur votre dashboard pour l'instant." />
      </Section>

      {user.role === "primary_user" && <GuestsInformation />}

      {/* Rubriques dans l'ordre retenu (US-49 RF2, RF3, RF5) ; le menu reste accessible même si les informations ne chargent pas (RF7). */}
      <Section title="Mon compte">
        <div className={s.navList}>
          {user.role === "primary_user" && (
            <Link href="/invites" className={s.navItem}>
              Invités <span aria-hidden>›</span>
            </Link>
          )}
          <Link href="/connecteurs" className={s.navItem}>
            {user.role === "primary_user" ? "Connecteurs" : "Mes connecteurs"} <span aria-hidden>›</span>
          </Link>
          {user.role === "primary_user" && (
            <Link href="/reglages/appareils" className={s.navItem}>
              <span>
                Appareils
                <span className={s.muted} style={{ display: "block", fontWeight: 400, fontSize: 12 }}>
                  Schéma tactile activé · verrouillage après 5 min
                </span>
              </span>
              <span aria-hidden>›</span>
            </Link>
          )}
          <Link href="/reglages/support" className={s.navItem}>
            Aide et support <span aria-hidden>›</span>
          </Link>
          <Link href="/reglages/carnet" className={s.navItem}>
            <span>
              Carnet
              <span className={s.muted} style={{ display: "block", fontWeight: 400, fontSize: 12 }}>
                Historique des demandes, agent par agent
              </span>
            </span>
            <span aria-hidden>›</span>
          </Link>
        </div>
      </Section>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8 }}>
        <LogoutButton isAdmin={false} />
        <p className={s.muted} style={{ textAlign: "center" }}>
          La déconnexion efface l&apos;historique de vos conversations avec les agents.
        </p>
      </div>
    </AppShell>
  );
}

/** « Mes informations » : consultation, puis édition par « Modifier » (US-12 RF2 à RF5). */
function MyInformation({ profile }: { profile: Profile }) {
  const reloadSession = useSessionReload();
  const [current, setCurrent] = useState(profile);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ firstName: profile.firstName, lastName: profile.lastName });
  const [abandoning, setAbandoning] = useState(false);
  const [saved, setSaved] = useState(false);
  const mutation = useApiMutation();
  const errors = mutation.error?.body?.code === "invalid_info" ? (mutation.error.body.details as Record<string, string>) : {};
  const dirty = form.firstName !== current.firstName || form.lastName !== current.lastName;

  async function save() {
    const result = await mutation.run<Profile>("/api/profile", { method: "PATCH", body: form });
    if (result) {
      setCurrent(result);
      setEditing(false);
      setSaved(true);
      await reloadSession();
    }
  }

  return (
    <Section
      title="Mes informations"
      action={
        !editing && (
          <button
            className={s.smallButton}
            onClick={() => {
              setSaved(false);
              setEditing(true);
            }}
          >
            Modifier
          </button>
        )
      }
    >
      {editing ? (
        <div className={s.form}>
          <Field label="Prénom" value={form.firstName} error={errors.firstName} maxLength={100} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
          <Field label="Nom" value={form.lastName} error={errors.lastName} maxLength={100} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
          <Field label="Email de connexion" value={current.email} disabled readOnly hint="L'email de connexion n'est pas modifiable ici." />
          {mutation.error?.body?.code !== "invalid_info" && <ErrorLine error={mutation.error} onRetry={save} />}
          <div className={s.row}>
            <Button variant="secondary" disabled={mutation.pending} onClick={() => (dirty ? setAbandoning(true) : setEditing(false))}>
              Annuler
            </Button>
            <Button loading={mutation.pending} disabled={!dirty || !form.firstName.trim() || !form.lastName.trim()} onClick={save}>
              Enregistrer
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className={s.text}>
            {current.firstName} {current.lastName} · {current.email}
          </p>
          {saved && <Notice tone="success">✓ Informations mises à jour</Notice>}
        </>
      )}
      {abandoning && (
        <ConfirmDialog
          title="Abandonner vos modifications ?"
          confirmLabel="Abandonner"
          onConfirm={() => {
            setAbandoning(false);
            setForm({ firstName: current.firstName, lastName: current.lastName });
            setEditing(false);
          }}
          onCancel={() => setAbandoning(false)}
        />
      )}
    </Section>
  );
}

/** « Informations de mes invités » : une fiche par invité, informations par agent (US-11 RF2, RF4). */
function GuestsInformation() {
  const guests = useApiQuery<{ guests: GuestSummary[] }>("/api/guests");
  return (
    <Section title="Informations de mes invités">
      {guests.loading && !guests.data && <Loading slow={guests.slow} />}
      <ErrorLine error={guests.error} onRetry={guests.reload} />
      {guests.data?.guests.length === 0 && (
        <p className={s.muted}>
          Aucun invité pour l&apos;instant. <Link href="/invites" className={s.smallButton}>Ajouter un invité</Link>
        </p>
      )}
      {guests.data?.guests.map((guest) => (
        <div key={guest.id} style={{ borderTop: "1px solid var(--line)", paddingTop: 10 }}>
          <div className={s.text} style={{ fontWeight: 700 }}>
            {guest.firstName} {guest.lastName}
            <span className={s.rank}>{guest.rank === "core" ? "Invité 1" : "Invité secondaire"}</span>
          </div>
          <p className={s.muted}>{guest.email}</p>
          <AgentInfoList profileId={guest.id} emptyText="Aucun agent sur son dashboard pour l'instant." />
        </div>
      ))}
    </Section>
  );
}
