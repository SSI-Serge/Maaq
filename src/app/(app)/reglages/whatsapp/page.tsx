"use client";

import { useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell, Section, appStyles as s } from "@/components/app/AppShell";
import { ConfirmDialog, ErrorLine } from "@/components/auth/parts";
import { Button, Field, Loading, Notice } from "@/components/ui";
import type { ChannelsView, LinkOffer } from "@/server/channels/linking";

type Prefs = ChannelsView["prefs"];

/**
 * WhatsApp et rappels : relier son numéro (code à envoyer depuis WhatsApp, consentement explicite), le délier,
 * et régler les rappels d'occasions de kdo_help (canal, heures calmes).
 */
export default function WhatsAppSettingsPage() {
  const channels = useApiQuery<ChannelsView>("/api/channels");

  return (
    <AppShell title="WhatsApp et rappels" back={{ href: "/reglages", label: "Réglages" }} subtitle="Écrivez à kdo_help depuis WhatsApp et recevez-y les rappels d'anniversaires et d'occasions. Même conversation que dans l'application.">
      {channels.loading && !channels.data && <Loading slow={channels.slow} />}
      <ErrorLine error={channels.error} onRetry={channels.reload} />
      {channels.data && (
        <>
          <WhatsAppSection view={channels.data} onChanged={channels.reload} />
          <RemindersSection prefs={channels.data.prefs} linked={channels.data.whatsapp.linked} />
        </>
      )}
    </AppShell>
  );
}

function WhatsAppSection({ view, onChanged }: { view: ChannelsView; onChanged: () => void }) {
  const [consent, setConsent] = useState(false);
  const [offer, setOffer] = useState<LinkOffer | null>(null);
  const [unlinking, setUnlinking] = useState(false);
  const link = useApiMutation();
  const unlink = useApiMutation();

  async function requestCode() {
    const result = await link.run<LinkOffer>("/api/channels/whatsapp/link", { method: "POST", body: { consent: true } });
    if (result) setOffer(result);
  }

  async function confirmUnlink() {
    const result = await unlink.run("/api/channels/whatsapp", { method: "DELETE" });
    if (result) {
      setUnlinking(false);
      setOffer(null);
      onChanged();
    }
  }

  if (view.whatsapp.linked) {
    const w = view.whatsapp;
    return (
      <Section title="WhatsApp">
        <p>
          Numéro relié : <b>{w.numberMasked}</b>
          <span className={s.muted} style={{ display: "block", fontSize: 12 }}>
            {w.optIn ? "Rappels WhatsApp activés" : "Rappels WhatsApp arrêtés (vous avez répondu STOP) — répondez REPRENDRE pour les réactiver"} · relié le {new Date(w.linkedAt).toLocaleDateString("fr-FR")}
          </span>
        </p>
        <p className={s.muted}>Écrivez simplement à ce numéro WhatsApp : kdo_help vous répond, et l&apos;échange apparaît aussi dans son tchat ici.</p>
        <ErrorLine error={unlink.error} />
        <Button variant="secondary" type="button" onClick={() => setUnlinking(true)}>
          Délier ce numéro
        </Button>
        {unlinking && (
          <ConfirmDialog title="Délier WhatsApp ?" text="Vous ne pourrez plus écrire à kdo_help depuis WhatsApp et n'y recevrez plus de rappel. Vous pourrez relier un numéro à tout moment." confirmLabel="Délier" onConfirm={confirmUnlink} onCancel={() => setUnlinking(false)} confirming={unlink.pending} />
        )}
      </Section>
    );
  }

  return (
    <Section title="WhatsApp">
      {!offer ? (
        <>
          <p className={s.muted}>Pour relier votre numéro, vous enverrez un code depuis votre WhatsApp au numéro de MAAQ. Le code est valable 10 minutes.</p>
          <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 14, lineHeight: 1.45, margin: "10px 0" }}>
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 3 }} />
            <span>{view.consentText}</span>
          </label>
          <ErrorLine error={link.error} />
          <Button type="button" disabled={!consent} loading={link.pending} onClick={requestCode}>
            Connecter WhatsApp
          </Button>
        </>
      ) : (
        <>
          <Notice tone="info">
            Depuis votre téléphone, envoyez ce code au numéro WhatsApp de MAAQ (+{view.businessNumber}) :
          </Notice>
          <p style={{ fontSize: 28, fontWeight: 700, letterSpacing: 2, textAlign: "center", margin: "12px 0" }}>{offer.code}</p>
          <p className={s.muted} style={{ textAlign: "center" }}>
            Valable jusqu&apos;à {new Date(offer.expiresAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <a href={offer.url} target="_blank" rel="noreferrer" style={{ textAlign: "center", fontWeight: 600, color: "var(--secondary-strong)" }}>
              Ouvrir WhatsApp avec le code prérempli ›
            </a>
            <Button variant="secondary" type="button" onClick={onChanged}>
              J&apos;ai envoyé le code
            </Button>
            <Button variant="secondary" type="button" loading={link.pending} onClick={requestCode}>
              Nouveau code
            </Button>
          </div>
        </>
      )}
    </Section>
  );
}

function RemindersSection({ prefs: initial, linked }: { prefs: Prefs; linked: boolean }) {
  const [prefs, setPrefs] = useState<Prefs>(initial);
  const [saved, setSaved] = useState(false);
  const save = useApiMutation();

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const result = await save.run<Prefs>("/api/me/notification-prefs", { method: "PATCH", body: { reminderChannel: prefs.reminderChannel, quietHoursStart: prefs.quietHoursStart, quietHoursEnd: prefs.quietHoursEnd } });
    if (result) {
      setPrefs(result);
      setSaved(true);
    }
  }

  const channelOptions: { value: Prefs["reminderChannel"]; label: string; hint: string }[] = [
    { value: "app", label: "Dans l'application", hint: "Un message de kdo_help dans son tchat" },
    { value: "whatsapp", label: "Sur WhatsApp", hint: linked ? "Un message WhatsApp, 21, 7 et 2 jours avant" : "Reliez d'abord votre numéro" },
    { value: "both", label: "Les deux", hint: "" },
  ];

  return (
    <Section title="Rappels d'occasions">
      <p className={s.muted}>kdo_help vous prévient 21, 7 et 2 jours avant un anniversaire ou une occasion enregistrés, sauf si vous avez marqué le cadeau comme réglé.</p>
      <form onSubmit={submit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <fieldset style={{ border: 0, padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: 8 }}>
          <legend style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>Où recevoir les rappels</legend>
          {channelOptions.map((option) => (
            <label key={option.value} style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 14 }}>
              <input type="radio" name="channel" value={option.value} checked={prefs.reminderChannel === option.value} disabled={option.value !== "app" && !linked} onChange={() => setPrefs({ ...prefs, reminderChannel: option.value })} style={{ marginTop: 3 }} />
              <span>
                {option.label}
                {option.hint && <span className={s.muted} style={{ display: "block", fontSize: 12 }}>{option.hint}</span>}
              </span>
            </label>
          ))}
        </fieldset>
        <div style={{ display: "flex", gap: 10 }}>
          <Field label="Heures calmes, début" type="time" value={prefs.quietHoursStart} onChange={(e) => setPrefs({ ...prefs, quietHoursStart: e.target.value })} />
          <Field label="Heures calmes, fin" type="time" value={prefs.quietHoursEnd} onChange={(e) => setPrefs({ ...prefs, quietHoursEnd: e.target.value })} />
        </div>
        <p className={s.muted} style={{ fontSize: 12 }}>Aucun rappel pendant les heures calmes (fuseau {prefs.timezone}) : il part après.</p>
        <ErrorLine error={save.error} />
        {saved && !save.pending && <Notice tone="success">Réglages enregistrés.</Notice>}
        <Button type="submit" loading={save.pending}>
          Enregistrer
        </Button>
      </form>
    </Section>
  );
}
