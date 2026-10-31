"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { usePush } from "@/client/push";
import { AppShell, Section } from "@/components/app/AppShell";
import { Loading, Notice, RetryNotice } from "@/components/ui";
import type { EventType } from "@/server/assistant/calendar";
import type { AnticipationView } from "@/server/assistant/anticipation";
import type { ReminderKind } from "@/server/assistant/reminders";
import { TYPE_LABEL, TYPE_PLURAL } from "./format";
import { HomeworkSettings } from "./HomeworkSettings";
import { MyPosition } from "./LocationConsent";
import { OutingsAccessRow } from "./OutingsCriteria";
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
  taskDaily: boolean;
  weeklyDigest: { enabled: boolean; weekday: number; hour: number };
  audience: "parent" | "guest";
}

const WEEKDAY_NAMES = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
const DIGEST_HOURS = [8, 12, 18, 19, 20, 21];

/**
 * Carte « Mes notifications » (US-113 RF14, D58) : l'interrupteur « Être prévenu des RDV ajoutés » est propre à chaque profil, invités secondaires compris.
 * Pendant l'enregistrement il est grisé avec un indicateur ; en cas d'échec il garde sa position précédente et le message s'affiche (RF15).
 */
function MyNotifications({ pushState }: { pushState: string }) {
  const query = useApiQuery<{ settings: PersonalSettings }>("/api/family/personal-settings");
  const mutation = useApiMutation();
  const [confirmed, setConfirmed] = useState<PersonalSettings | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [last, setLast] = useState<{ key: string; patch: Record<string, unknown> } | null>(null);
  const current = confirmed ?? query.data?.settings ?? null;
  const guest = current?.audience === "guest";

  async function save(key: string, patch: Record<string, unknown>) {
    setPending(key);
    setLast({ key, patch });
    const result = await mutation.run<{ settings: PersonalSettings }>("/api/family/personal-settings", { method: "PATCH", body: patch });
    setPending(null);
    if (result) setConfirmed(result.settings);
  }

  const error = mutation.error;
  const eventsLabel = guest ? "Être prévenu des RDV ajoutés qui me concernent" : "Être prévenu des RDV ajoutés par l'autre parent";
  const toggle = (key: string, label: string, value: boolean, patch: (next: boolean) => Record<string, unknown>, hint?: string) => (
    <div className={styles.settingRow} role="group" aria-label={label}>
      <div className={styles.settingType}>{label}</div>
      <div className={styles.switches}>
        <button type="button" role="switch" aria-checked={value} aria-busy={pending === key} aria-label={label} className={styles.switch} disabled={pending !== null} onClick={() => void save(key, patch(!value))}>
          {pending === key ? "Enregistrement…" : value ? "Oui" : "Non"}
        </button>
      </div>
      {hint && <span className={styles.hint}>{hint}</span>}
    </div>
  );
  return (
    <Section title="Mes notifications">
      {query.loading && current === null && <Loading slow={query.slow} />}
      {query.error && <RetryNotice message={query.error.kind === "server" ? "Vos notifications n'ont pas pu être chargées." : query.error.message} onRetry={query.reload} />}
      {current !== null && (
        <>
          {toggle("events", eventsLabel, current.notifyEventsAdded, (next) => ({ notifyEventsAdded: next }), `Une seule notification par RDV, pour vous seul·e. Les relances et rappels ne changent pas.${pushState === "enabled" ? "" : " Ce téléphone n'est pas autorisé à recevoir les notifications : vous ne recevrez rien tant que vous ne les avez pas activées (lien ci-dessous)."}`)}
          {toggle("tasks", "Rappel quotidien des tâches", current.taskDaily, (next) => ({ taskDaily: next }), "À 8 h : vos tâches du jour, et celles des jours passés à faire quand vous pouvez. Rien si vous n'en avez pas.")}
          {toggle("digest", "Point de la semaine", current.weeklyDigest.enabled, (next) => ({ weeklyDigest: { enabled: next } }), "Un résumé de la semaine qui vient : RDV, tâches, qui fait quoi.")}
          {current.weeklyDigest.enabled && (
            <div className={styles.two}>
              <label className={styles.field}>
                <span className={styles.label}>Jour du point</span>
                <select className={styles.select} value={current.weeklyDigest.weekday} disabled={pending !== null} onChange={(e) => void save("weekday", { weeklyDigest: { weekday: Number(e.target.value) } })}>
                  {WEEKDAY_NAMES.map((name, i) => (
                    <option key={name} value={i + 1}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <label className={styles.field}>
                <span className={styles.label}>Heure</span>
                <select className={styles.select} value={current.weeklyDigest.hour} disabled={pending !== null} onChange={(e) => void save("hour", { weeklyDigest: { hour: Number(e.target.value) } })}>
                  {DIGEST_HOURS.map((h) => (
                    <option key={h} value={h}>
                      {h} h
                    </option>
                  ))}
                </select>
              </label>
            </div>
          )}
        </>
      )}
      {error && !error.body?.code && last && <RetryNotice message={error.kind === "server" ? "Le réglage n'a pas pu être enregistré." : error.message} onRetry={() => void save(last.key, last.patch)} />}
      {error && error.body?.code && <Notice tone="error">{error.message}</Notice>}
      <OutingsAccessRow />
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

/**
 * Anticipation (US-102 RF2, RF9) : le catalogue d'échéances se désactive pour la famille, et le court questionnaire « Situation de la famille » (facultatif) précise lesquelles
 * s'appliquent. Réservé aux parents : un profil sans ce droit ne voit pas la carte.
 */
function Anticipation() {
  const query = useApiQuery<{ anticipation: AnticipationView }>("/api/family/anticipation");
  const mutation = useApiMutation();
  const [pending, setPending] = useState<string | null>(null);
  const [override, setOverride] = useState<Partial<Pick<AnticipationView, "enabled" | "situation">>>({});
  const data = query.data?.anticipation;
  if (query.error?.body?.code === "forbidden") return null;
  const enabled = override.enabled ?? data?.enabled;
  const situation = override.situation ?? data?.situation ?? [];

  async function save(key: string, body: Record<string, unknown>) {
    setPending(key);
    const result = await mutation.run<{ enabled?: boolean; situation?: AnticipationView["situation"] }>("/api/family/anticipation/settings", { method: "PATCH", body });
    setPending(null);
    if (result) setOverride((cur) => ({ ...cur, ...(result.enabled !== undefined ? { enabled: result.enabled } : {}), ...(result.situation ? { situation: result.situation } : {}) }));
  }

  return (
    <Section title="Anticipation">
      <p className={styles.hint}>Des questions sur les échéances à prévoir (impôts, rentrée, entretien…), au plus cinq par semaine. Réservé aux parents.</p>
      {query.loading && !data && <Loading slow={query.slow} />}
      {query.error && <RetryNotice message={query.error.kind === "server" ? "Les réglages n'ont pas pu être chargés." : query.error.message} onRetry={query.reload} />}
      {data && enabled !== undefined && (
        <>
          <div className={styles.settingRow} role="group" aria-label="Catalogue d'anticipation">
            <div className={styles.settingType}>Catalogue d&apos;anticipation</div>
            <div className={styles.switches}>
              <button type="button" role="switch" aria-checked={enabled} aria-label="Catalogue d'anticipation" className={styles.switch} disabled={pending !== null} onClick={() => void save("enabled", { enabled: !enabled })}>
                {pending === "enabled" ? "Enregistrement…" : enabled ? "Oui" : "Non"}
              </button>
            </div>
          </div>
          {enabled && (
            <>
              <div className={styles.label}>Situation de la famille (facultatif)</div>
              {situation.map((q) => (
                <div key={q.key} className={styles.settingRow} role="group" aria-label={q.label}>
                  <div className={styles.settingType}>{q.label}</div>
                  <div className={styles.switches}>
                    {([[true, "Oui"], [false, "Non"]] as const).map(([value, label]) => (
                      <button key={label} type="button" className={styles.chipToggle} aria-pressed={q.answer === value} disabled={pending !== null} onClick={() => void save(q.key, { situation: { key: q.key, answer: q.answer === value ? null : value } })}>
                        {label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              <span className={styles.hint}>Sans réponse, seules les échéances sans condition de situation sont proposées.</span>
            </>
          )}
        </>
      )}
      {mutation.error && <Notice tone="error">{mutation.error.kind === "server" ? "Le réglage n'a pas pu être enregistré." : mutation.error.message}</Notice>}
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

      <MyPosition />

      <SchoolZone />
      <HomeworkSettings />
      <Anticipation />

      <Section title="Délais de rappel par type de RDV">
        <p className={styles.hint}>Les rappels et les relances partent par notification sur les appareils autorisés de chaque parent ; un email n&apos;est envoyé qu&apos;à défaut de notification (aucun appareil autorisé, ou envoi échoué). Ces réglages valent pour toute la famille.</p>
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
