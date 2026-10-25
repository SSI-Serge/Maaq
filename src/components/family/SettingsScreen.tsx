"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { usePush } from "@/client/push";
import { AppShell, Section } from "@/components/app/AppShell";
import { Loading, Notice, RetryNotice } from "@/components/ui";
import type { EventType } from "@/server/assistant/calendar";
import type { ReminderKind } from "@/server/assistant/reminders";
import { TYPE_LABEL, TYPE_PLURAL } from "./format";
import styles from "./family.module.css";

interface Setting {
  type: EventType;
  d7: boolean;
  d1: boolean;
  d0: boolean;
}

const KINDS: { kind: ReminderKind; label: string }[] = [
  { kind: "d7", label: "J-7" },
  { kind: "d1", label: "J-1" },
  { kind: "d0", label: "Jour J" },
];

/**
 * Réglages de l'Assistant Famille. Pour l'instant : les délais de rappel par type de rendez-vous (US-82) et l'accès aux membres de la famille.
 * Chaque interrupteur est enregistré dès qu'on le touche ; il garde sa position précédente tant que le serveur n'a pas répondu, et en cas d'échec.
 * Les interrupteurs sont tous désactivés pendant un enregistrement : un seul à la fois, aucun toucher n'est perdu en silence.
 */
export function SettingsScreen() {
  const query = useApiQuery<{ settings: Setting[]; canEdit: boolean }>("/api/family/reminder-settings");
  const { state: push } = usePush();
  const mutation = useApiMutation();
  // Valeurs confirmées par le serveur depuis le chargement : elles remplacent celles de la liste chargée.
  const [confirmed, setConfirmed] = useState<Partial<Record<EventType, Setting>>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [last, setLast] = useState<{ type: EventType; kind: ReminderKind; enabled: boolean } | null>(null);

  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 3000);
    return () => clearTimeout(timer);
  }, [saved]);

  async function toggle(type: EventType, kind: ReminderKind, enabled: boolean) {
    setLast({ type, kind, enabled });
    setSaving(`${type}:${kind}`);
    setSaved(false);
    const result = await mutation.run<{ setting: Setting }>("/api/family/reminder-settings", { method: "PATCH", body: { type, kind, enabled } });
    setSaving(null);
    if (result) {
      setConfirmed((current) => ({ ...current, [type]: result.setting }));
      setSaved(true);
    }
  }

  const values = query.data?.settings.map((s) => confirmed[s.type] ?? s) ?? null;
  const forbidden = query.error?.body?.code === "forbidden";
  const editable = query.data?.canEdit ?? false;
  const error = mutation.error;

  return (
    <AppShell title="Réglages" subtitle="Assistant Famille" back={{ href: "/assistant", label: "Assistant Famille" }}>
      <Section title="Délais de rappel par type de RDV">
        <p className={styles.hint}>Les rappels et les relances sont envoyés par email aux deux parents du foyer. Ces réglages valent pour toute la famille.</p>
        {query.loading && !values && <Loading slow={query.slow} />}
        {query.error && !forbidden && <RetryNotice message={query.error.kind === "server" ? "Les réglages n'ont pas pu être chargés." : query.error.message} onRetry={query.reload} />}
        {forbidden && <Notice tone="info">L&apos;Assistant Famille est réservé aux deux parents du foyer.</Notice>}
        {values && !editable && <Notice tone="info">Lecture seule — seuls les parents peuvent modifier ces réglages.</Notice>}
        {saved && <Notice tone="success">Réglage enregistré</Notice>}
        {error && !error.body?.code && last && (
          <RetryNotice message={error.kind === "server" ? "Le réglage n'a pas pu être enregistré." : error.message} onRetry={() => void toggle(last.type, last.kind, last.enabled)} />
        )}
        {error && error.body?.code && <Notice tone="error">{error.message}</Notice>}

        {values?.map((setting) => {
          const none = !setting.d7 && !setting.d1 && !setting.d0;
          return (
            <div key={setting.type} className={styles.settingRow} role="group" aria-label={`Rappels des RDV ${TYPE_PLURAL[setting.type]}`}>
              <div className={styles.settingType}>{TYPE_LABEL[setting.type]}</div>
              <div className={styles.switches}>
                {KINDS.map(({ kind, label }) => (
                  <button
                    key={kind}
                    type="button"
                    role="switch"
                    aria-checked={setting[kind]}
                    aria-label={`${label}, ${TYPE_LABEL[setting.type].toLowerCase()}`}
                    className={styles.switch}
                    disabled={!editable || saving !== null}
                    onClick={() => void toggle(setting.type, kind, !setting[kind])}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {none && <span className={styles.hint}>Aucun rappel ne sera envoyé pour les RDV {TYPE_PLURAL[setting.type]}.</span>}
            </div>
          );
        })}
      </Section>

      <Section title="Notifications">
        <Link href="/assistant/rappels" className={styles.linkRow}>
          <span>
            Activer mes rappels
            <span className={styles.linkRowSub}>{push === "enabled" ? "✓ Activés sur cet appareil" : "Recevoir les rappels par notification sur ce téléphone"}</span>
          </span>
          <span aria-hidden>›</span>
        </Link>
      </Section>

      <Section title="Famille">
        <Link href="/assistant/membres" className={styles.linkRow}>
          <span>
            Membres de la famille
            <span className={styles.linkRowSub}>Personnes concernées par les RDV et tâches</span>
          </span>
          <span aria-hidden>›</span>
        </Link>
      </Section>
    </AppShell>
  );
}
