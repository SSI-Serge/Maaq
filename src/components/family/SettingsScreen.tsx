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

interface PersonalSettings {
  notifyEventsAdded: boolean;
  audience: "parent" | "guest";
}

/**
 * Carte « Mes notifications » (US-113 RF14, D58) : l'interrupteur « Être prévenu des RDV ajoutés » est propre à chaque profil, invités secondaires compris.
 * Pendant l'enregistrement il est grisé avec un indicateur ; en cas d'échec il garde sa position précédente et le message s'affiche (RF15).
 */
function MyNotifications({ pushState }: { pushState: string }) {
  const query = useApiQuery<{ settings: PersonalSettings }>("/api/family/personal-settings");
  const mutation = useApiMutation();
  const [confirmed, setConfirmed] = useState<boolean | null>(null);
  const [pending, setPending] = useState(false);
  const current = confirmed ?? query.data?.settings.notifyEventsAdded ?? null;
  const guest = query.data?.settings.audience === "guest";

  async function toggle(next: boolean) {
    setPending(true);
    const result = await mutation.run<{ settings: PersonalSettings }>("/api/family/personal-settings", { method: "PATCH", body: { notifyEventsAdded: next } });
    setPending(false);
    if (result) setConfirmed(result.settings.notifyEventsAdded);
  }

  const error = mutation.error;
  return (
    <Section title="Mes notifications">
      {query.loading && current === null && <Loading slow={query.slow} />}
      {query.error && <RetryNotice message={query.error.kind === "server" ? "Vos notifications n'ont pas pu être chargées." : query.error.message} onRetry={query.reload} />}
      {current !== null && (
        <div className={styles.settingRow} role="group" aria-label="Notification des RDV ajoutés">
          <div className={styles.settingType}>{guest ? "Être prévenu des RDV ajoutés qui me concernent" : "Être prévenu des RDV ajoutés par l'autre parent"}</div>
          <div className={styles.switches}>
            <button type="button" role="switch" aria-checked={current} aria-busy={pending} aria-label={guest ? "Être prévenu des RDV ajoutés qui me concernent" : "Être prévenu des RDV ajoutés par l'autre parent"} className={styles.switch} disabled={pending} onClick={() => void toggle(!current)}>
              {pending ? "Enregistrement…" : current ? "Oui" : "Non"}
            </button>
          </div>
          <span className={styles.hint}>Une seule notification par RDV, pour vous seul·e. Les relances et rappels ne changent pas.</span>
        </div>
      )}
      {error && !error.body?.code && <RetryNotice message={error.kind === "server" ? "Le réglage n'a pas pu être enregistré." : error.message} onRetry={() => void toggle(!(current ?? true))} />}
      {error && error.body?.code && <Notice tone="error">{error.message}</Notice>}
      <Link href="/assistant/rappels" className={styles.linkRow}>
        <span>
          Activer mes notifications
          <span className={styles.linkRowSub}>{pushState === "enabled" ? "✓ Activées sur cet appareil" : "Recevoir les notifications sur ce téléphone"}</span>
        </span>
        <span aria-hidden>›</span>
      </Link>
    </Section>
  );
}

interface ZoneSetting {
  zone: "A" | "B" | "C" | null;
  canEdit: boolean;
  holidaysLoaded: boolean;
}

/** Zone scolaire de la famille, pour « Sauf vacances scolaires » des RDV récurrents (US-109 RF4) : lue par tous, réglée par les parents. */
function SchoolZone() {
  const query = useApiQuery<{ setting: ZoneSetting }>("/api/family/school-zone");
  const mutation = useApiMutation();
  const [confirmed, setConfirmed] = useState<ZoneSetting | null>(null);
  const [pending, setPending] = useState(false);
  const setting = confirmed ?? query.data?.setting ?? null;

  async function change(zone: string) {
    setPending(true);
    const result = await mutation.run<{ setting: ZoneSetting }>("/api/family/school-zone", { method: "PATCH", body: { zone: zone || null } });
    setPending(false);
    if (result) setConfirmed(result.setting);
  }

  return (
    <Section title="Zone scolaire">
      <p className={styles.hint}>Sert à l&apos;option « Sauf vacances scolaires » des rendez-vous qui se répètent. Sans zone choisie, l&apos;option n&apos;est pas proposée.</p>
      {query.loading && !setting && <Loading slow={query.slow} />}
      {query.error && <RetryNotice message={query.error.kind === "server" ? "La zone scolaire n'a pas pu être chargée." : query.error.message} onRetry={query.reload} />}
      {setting && (
        <div className={styles.settingRow}>
          <label className={styles.settingType} htmlFor="school-zone">
            Zone de la famille
          </label>
          <select id="school-zone" className={styles.select} value={setting.zone ?? ""} disabled={!setting.canEdit || pending} onChange={(e) => void change(e.target.value)}>
            <option value="">Non réglée</option>
            <option value="A">Zone A</option>
            <option value="B">Zone B</option>
            <option value="C">Zone C</option>
          </select>
          {!setting.canEdit && <span className={styles.hint}>Lecture seule — seuls les parents peuvent la modifier.</span>}
          {setting.zone && !setting.holidaysLoaded && <span className={styles.hint}>Les dates de vacances de cette zone ne sont pas encore chargées : l&apos;option ne retirerait aucune séance.</span>}
        </div>
      )}
      {mutation.error && <Notice tone="error">{mutation.error.kind === "server" ? "La zone n'a pas pu être enregistrée." : mutation.error.message}</Notice>}
    </Section>
  );
}

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
      <MyNotifications pushState={push} />

      <SchoolZone />

      <Section title="Délais de rappel par type de RDV">
        <p className={styles.hint}>Les rappels et les relances sont envoyés par email aux deux parents du foyer. Ces réglages valent pour toute la famille.</p>
        {query.loading && !values && <Loading slow={query.slow} />}
        {query.error && !forbidden && <RetryNotice message={query.error.kind === "server" ? "Les réglages n'ont pas pu être chargés." : query.error.message} onRetry={query.reload} />}
        {forbidden && <Notice tone="info">Ces réglages sont réservés aux profils d&apos;un foyer.</Notice>}
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

      {editable && (
        <Section title="Famille">
          <Link href="/assistant/membres" className={styles.linkRow}>
            <span>
              Membres de la famille
              <span className={styles.linkRowSub}>Personnes concernées par les RDV et tâches</span>
            </span>
            <span aria-hidden>›</span>
          </Link>
        </Section>
      )}
    </AppShell>
  );
}
