"use client";

import { useState } from "react";
import { useApiMutation } from "@/client/hooks";
import { Section, appStyles as s } from "@/components/app/AppShell";
import { ErrorLine } from "@/components/auth/parts";
import { Button, Notice } from "@/components/ui";
import ui from "@/components/ui/ui.module.css";
import { EMAIL_FORMAT, type CcView } from "./types";

/**
 * Adresses en copie systématique d'un agent (US-16 pour l'utilisateur principal, US-17 pour l'invité) :
 * participants automatiques en lecture seule selon le rang (décision D2), puis liste propre au profil.
 */
export function CcSection({ agentId, cc, isPrimary, onChanged }: { agentId: string; cc: CcView; isPrimary: boolean; onChanged: () => void }) {
  const [draft, setDraft] = useState("");
  const [formatError, setFormatError] = useState<string>();
  const add = useApiMutation();
  const remove = useApiMutation();

  const serverError = add.error?.body?.details as { email?: string } | undefined;
  const atMax = cc.addresses.length >= cc.max;
  const limitReached = add.error?.body?.code === "cc_limit";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!EMAIL_FORMAT.test(draft.trim())) return setFormatError("Adresse email invalide");
    setFormatError(undefined);
    const result = await add.run<CcView>("/api/connectors/cc", { method: "POST", body: { agentId, email: draft.trim() } });
    if (result) {
      setDraft("");
      onChanged();
    }
  }

  async function removeAddress(email: string) {
    const result = await remove.run<CcView>("/api/connectors/cc", { method: "DELETE", body: { agentId, email } });
    if (result) onChanged();
  }

  return (
    <Section title={isPrimary ? "Adresses en copie systématique" : "Mes adresses en copie"}>
      <p className={s.muted}>
        {isPrimary
          ? "Ajoutées automatiquement à vos rendez-vous, et seulement aux vôtres : vos invités ne les voient pas."
          : "Ajoutées automatiquement aux rendez-vous que vous demandez, en plus des participants automatiques."}
      </p>

      <div className={s.sectionTitle} style={{ marginTop: 4 }}>
        Participants automatiques
      </div>
      {cc.autoParticipants.length === 0 ? (
        <p className={s.muted}>Aucun pour l&apos;instant{isPrimary ? " : l'invité 1 sera ajouté d'office dès qu'il existe." : "."}</p>
      ) : (
        cc.autoParticipants.map((person) => (
          <div key={person.email} className={s.agentRow} style={{ opacity: 0.75 }}>
            <div>
              <div className={s.text}>{person.name}</div>
              <div className={s.muted}>{person.email} · Ajouté automatiquement à vos rendez-vous</div>
            </div>
          </div>
        ))
      )}

      <div className={s.sectionTitle} style={{ marginTop: 8 }}>
        {isPrimary ? "Mes adresses" : "Mes adresses en copie"} ({cc.addresses.length}/{cc.max})
      </div>
      {cc.addresses.length === 0 && <p className={s.muted}>Aucune adresse en copie pour le moment.</p>}
      {cc.addresses.map((address) => (
        <div key={address} className={s.agentRow}>
          <span className={s.text}>{address}</span>
          <button className={`${s.smallButton} ${s.danger}`} aria-label={`Retirer ${address}`} disabled={remove.pending} onClick={() => removeAddress(address)}>
            Retirer
          </button>
        </div>
      ))}
      <ErrorLine error={remove.error} />

      <form onSubmit={submit} noValidate style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <div className={ui.field}>
          <label className={ui.label} htmlFor={`cc-${agentId}`}>
            Ajouter une adresse
          </label>
          <input
            id={`cc-${agentId}`}
            className={`${ui.input} ${formatError || serverError?.email ? ui.inputError : ""}`}
            type="email"
            placeholder="adresse@exemple.fr"
            value={draft}
            disabled={atMax}
            onChange={(e) => {
              setDraft(e.target.value);
              setFormatError(undefined);
              if (add.error) add.reset();
            }}
          />
          {(formatError || serverError?.email) && <span className={ui.fieldError}>{formatError ?? serverError?.email}</span>}
        </div>
        {limitReached || (atMax && !add.error) ? (
          <Notice tone="warning">{limitReached ? add.error!.message : `Vous avez atteint le maximum de ${cc.max} adresses en copie pour cet agent. Retirez une adresse pour en ajouter une nouvelle.`}</Notice>
        ) : (
          !serverError?.email && <ErrorLine error={add.error} />
        )}
        <Button type="submit" loading={add.pending} disabled={!draft.trim() || atMax}>
          Ajouter
        </Button>
      </form>
    </Section>
  );
}
