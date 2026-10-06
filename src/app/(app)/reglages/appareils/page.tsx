"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { clearAllDrafts, useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell, Section, appStyles as s } from "@/components/app/AppShell";
import { useSessionUser } from "@/components/auth/AuthGate";
import { ConfirmDialog, ErrorLine } from "@/components/auth/parts";
import { Loading, RetryNotice } from "@/components/ui";
import type { DeviceView, DevicesView } from "@/server/devices/service";

const TYPE_NAME = { iphone: "iPhone", android: "Android", desktop: "Ordinateur", other: "Appareil" } as const;

const dateTime = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
const day = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" });

/** Appareils connectés de l'utilisateur principal et de ses invités, avec révocation (US-53), maquette Appareils. */
export default function DevicesPage() {
  const user = useSessionUser();
  const router = useRouter();
  const devices = useApiQuery<DevicesView>(user.role === "primary_user" ? "/api/devices" : null);

  // La rubrique n'existe pas pour un invité (US-53 RF6).
  useEffect(() => {
    if (user.role !== "primary_user") router.replace("/reglages");
  }, [user.role, router]);
  if (user.role !== "primary_user") return null;

  return (
    <AppShell title="Appareils connectés" back={{ href: "/reglages", label: "Réglages" }}>
      <p className={s.muted}>
        En cas de perte ou de vol, révoquez l&apos;accès d&apos;un appareil, le vôtre ou celui d&apos;un invité. Un appareil révoqué devra repasser par la vérification d&apos;identité.
      </p>
      {devices.loading && !devices.data && <Loading slow={devices.slow} />}
      {devices.error && !devices.data && <RetryNotice message={devices.error.message} onRetry={devices.reload} />}
      {devices.data && (
        <>
          <Section title="Mes appareils">
            {devices.data.mine.length === 0 && <p className={s.muted}>Aucun appareil.</p>}
            {devices.data.mine.map((device) => (
              <DeviceRow key={device.id} device={device} onRevoked={devices.reload} />
            ))}
          </Section>
          <Section title="Appareils de mes invités">
            {devices.data.guests.length === 0 && <p className={s.muted}>Aucun appareil d&apos;invité pour le moment.</p>}
            {devices.data.guests.map((guest) => (
              <div key={guest.guestId} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {guest.devices.map((device) => (
                  <DeviceRow key={device.id} device={device} guest onRevoked={devices.reload} />
                ))}
              </div>
            ))}
          </Section>
        </>
      )}
    </AppShell>
  );
}

function DeviceRow({ device, guest = false, onRevoked }: { device: DeviceView; guest?: boolean; onRevoked: () => void }) {
  const router = useRouter();
  const [asking, setAsking] = useState(false);
  const revoke = useApiMutation();
  const name = `${TYPE_NAME[device.type]} de ${device.ownerFirstName}`;
  const last = Date.parse(device.lastActivityAt);

  async function confirm() {
    const result = await revoke.run<{ revokedCurrent: boolean }>(`/api/devices/${device.id}/revoke`, { method: "POST" });
    if (!result) return;
    if (result.revokedCurrent) {
      // « Cet appareil » : équivaut à une déconnexion, les brouillons sont effacés (US-53 RF4).
      clearAllDrafts();
      router.replace("/connexion");
      return;
    }
    setAsking(false);
    onRevoked();
  }

  return (
    <div className={s.agentRow}>
      <div>
        <div className={s.text} style={{ fontWeight: 600 }}>
          {name}
        </div>
        <div className={s.muted}>
          {guest && "Invité — "}
          {device.active ? "Actif maintenant" : `Dernière connexion : ${dateTime.format(new Date(last))}`}
        </div>
        <div className={s.muted}>
          {device.browser ? `${device.browser} · ` : ""}Première connexion le {day.format(new Date(device.firstConnectedAt))}
        </div>
      </div>
      {device.current ? (
        <span className={`${s.badge} ${s.ok}`}>Cet appareil</span>
      ) : null}
      <button className={`${s.smallButton} ${s.danger}`} aria-label={`Révoquer ${name}`} onClick={() => setAsking(true)}>
        Révoquer
      </button>
      {asking && (
        <ConfirmDialog
          title="Révoquer l'accès de cet appareil ?"
          text={
            device.current
              ? "Vous serez déconnecté et l'historique de vos tchats sera effacé. La personne devra vérifier à nouveau son identité pour se reconnecter."
              : "La personne devra vérifier à nouveau son identité pour se reconnecter."
          }
          confirmLabel="Révoquer"
          confirming={revoke.pending}
          onConfirm={confirm}
          onCancel={() => {
            revoke.reset();
            setAsking(false);
          }}
        >
          <ErrorLine error={revoke.error} onRetry={confirm} />
        </ConfirmDialog>
      )}
    </div>
  );
}
