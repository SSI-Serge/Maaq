"use client";

import Link from "next/link";
import { useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell, Section, appStyles as s } from "@/components/app/AppShell";
import { ErrorLine } from "@/components/auth/parts";
import { Button, Loading, Notice } from "@/components/ui";
import type { PrefsView } from "@/server/marketplace/buyer-service";

/**
 * Réglages › Suggestions de services (US-09, US-10) : consentement explicite aux suggestions proactives de
 * coup_de_main, interrupteur « utiliser mon agenda » présent mais inactif (phase ultérieure), catégories coupées.
 * Une demande explicite dans le tchat fonctionne sans ce consentement ; seules les suggestions à l'initiative
 * de MAAQ en dépendent.
 */
export default function SuggestionsSettingsPage() {
  const view = useApiQuery<PrefsView>("/api/marketplace/prefs");
  // Le formulaire est remonté à chaque rechargement : l'accusé d'enregistrement vit donc ici.
  const [saved, setSaved] = useState(false);

  return (
    <AppShell title="Suggestions de services" back={{ href: "/reglages", label: "Réglages" }} subtitle="Des vitrines de membres, proposées par coup_de_main au bon moment. Rien n'est transmis à un fournisseur sans votre validation.">
      {view.loading && !view.data && <Loading slow={view.slow} />}
      <ErrorLine error={view.error} onRetry={view.reload} />
      {view.data && (
        <PrefsForm
          key={`${view.data.prefs.optInAt ?? "none"}-${view.data.prefs.agendaOptInAt ?? "none"}-${view.data.prefs.mutedCategories.join(",")}`}
          view={view.data}
          saved={saved}
          onChanged={() => {
            setSaved(true);
            view.reload();
          }}
        />
      )}
    </AppShell>
  );
}

function Switch({ checked, disabled, label, hint, onChange }: { checked: boolean; disabled?: boolean; label: string; hint?: string; onChange?: (next: boolean) => void }) {
  return (
    <label style={{ display: "flex", gap: 12, alignItems: "flex-start", fontSize: 14, lineHeight: 1.45, opacity: disabled ? 0.6 : 1 }}>
      <input type="checkbox" role="switch" aria-checked={checked} checked={checked} disabled={disabled} onChange={(e) => onChange?.(e.target.checked)} style={{ marginTop: 3, width: 18, height: 18 }} />
      <span>
        {label}
        {hint && (
          <span className={s.muted} style={{ display: "block", fontSize: 12 }}>
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}

function PrefsForm({ view, saved, onChanged }: { view: PrefsView; saved: boolean; onChanged: () => void }) {
  const [optIn, setOptIn] = useState(view.prefs.suggestionsOptIn);
  const [consent, setConsent] = useState(view.prefs.suggestionsOptIn);
  const [agenda, setAgenda] = useState(view.prefs.agendaOptIn);
  const [agendaConsent, setAgendaConsent] = useState(view.prefs.agendaOptIn);
  const [muted, setMuted] = useState<string[]>(view.prefs.mutedCategories);
  const save = useApiMutation();

  // L'agenda n'a de sens qu'avec les suggestions : couper celles-ci coupe aussi l'agenda.
  const agendaOn = optIn && agenda;
  const sameMuted = muted.length === view.prefs.mutedCategories.length && muted.every((code) => view.prefs.mutedCategories.includes(code));
  const dirty = optIn !== view.prefs.suggestionsOptIn || agendaOn !== view.prefs.agendaOptIn || !sameMuted;
  // Activer exige d'avoir lu et coché le texte de consentement correspondant ; couper des catégories ou désactiver, non.
  const canSave = dirty && (!optIn || view.prefs.suggestionsOptIn || consent) && (!agendaOn || view.prefs.agendaOptIn || agendaConsent);

  async function submit() {
    const result = await save.run<PrefsView>("/api/marketplace/prefs", { method: "PATCH", body: { suggestionsOptIn: optIn, agendaOptIn: agendaOn, mutedCategories: muted } });
    if (result) onChanged();
  }

  function toggleMuted(code: string, on: boolean) {
    setMuted((current) => (on ? [...new Set([...current, code])] : current.filter((c) => c !== code)));
  }

  return (
    <>
      <Section title="Suggestions proactives">
        <p className={s.muted}>
          Quand vous demandez un service dans le tchat de coup_de_main, il cherche toujours. Avec les suggestions activées, il peut aussi vous prévenir plus tard si une vitrine correspondant à une demande restée sans réponse est publiée.
        </p>
        <div className={s.form}>
          <Switch checked={optIn} label="Recevoir des suggestions de services" hint={view.prefs.optInAt ? `Activées le ${new Date(view.prefs.optInAt).toLocaleDateString("fr-FR")} (texte version ${view.prefs.consentVersion})` : "Désactivées"} onChange={setOptIn} />
          {optIn && !view.prefs.suggestionsOptIn && (
            <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 14, lineHeight: 1.45, padding: 10, background: "var(--primary-soft)", borderRadius: 10 }}>
              <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} style={{ marginTop: 3 }} />
              <span>{view.consentText}</span>
            </label>
          )}
          {view.agendaAvailable ? (
            <>
              <Switch
                checked={agendaOn}
                disabled={!optIn}
                label="Utiliser mon agenda pour trouver le bon moment"
                hint={!optIn ? "Activez d'abord les suggestions." : view.prefs.agendaOptIn ? `Activé le ${new Date(view.prefs.agendaOptInAt!).toLocaleDateString("fr-FR")} (texte version ${view.prefs.agendaConsentVersion})` : "coup_de_main vous demandera d'abord si vous voulez qu'il cherche ; il ne propose jamais quelqu'un sans votre oui."}
                onChange={setAgenda}
              />
              {agendaOn && !view.prefs.agendaOptIn && (
                <label style={{ display: "flex", gap: 10, alignItems: "flex-start", fontSize: 14, lineHeight: 1.45, padding: 10, background: "var(--primary-soft)", borderRadius: 10 }}>
                  <input type="checkbox" checked={agendaConsent} onChange={(e) => setAgendaConsent(e.target.checked)} style={{ marginTop: 3 }} />
                  <span>{view.agendaConsentText}</span>
                </label>
              )}
              {agendaOn && !view.postcode && (
                <p className={s.muted}>
                  Pour chercher près de chez vous, indiquez votre code postal dans{" "}
                  <Link href="/reglages" className={s.smallButton}>
                    Réglages › Mes informations
                  </Link>
                  .
                </p>
              )}
            </>
          ) : (
            <Switch checked={false} disabled label="Utiliser mon agenda pour trouver le bon moment" hint="Bientôt : MAAQ pourra proposer un service à l'approche d'un événement de votre agenda. Rien n'est lu pour l'instant." />
          )}
        </div>
      </Section>

      <Section title="Catégories coupées">
        <p className={s.muted}>Les catégories cochées ne vous seront jamais proposées, ni spontanément ni après une demande. Vous pouvez aussi le dire à coup_de_main dans le tchat.</p>
        <div className={s.form} style={{ gap: 8 }}>
          {view.categories.map((category) => (
            <Switch key={category.code} checked={muted.includes(category.code)} label={category.label} onChange={(on) => toggleMuted(category.code, on)} />
          ))}
        </div>
      </Section>

      <ErrorLine error={save.error} onRetry={submit} />
      {saved && !dirty && <Notice tone="success">✓ Réglages enregistrés</Notice>}
      <Button block loading={save.pending} disabled={!canSave} onClick={submit}>
        Enregistrer
      </Button>
      <p className={s.muted} style={{ marginTop: 12 }}>
        Ce que coup_de_main vous montre d&apos;une vitrine : le nom, les services, la zone approximative, la disponibilité et le tarif tels que le fournisseur les a donnés. Ses coordonnées ne sont révélées qu&apos;après son accord ; les vôtres ne le sont jamais par MAAQ.{" "}
        <Link href="/catalogue" className={s.smallButton}>
          Ajouter coup_de_main depuis le catalogue ›
        </Link>
      </p>
    </>
  );
}
