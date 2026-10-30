"use client";

import Link from "next/link";
import { useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { Section } from "@/components/app/AppShell";
import { Button, Loading, Notice, RetryNotice } from "@/components/ui";
import type { HomeworkSetting } from "@/server/assistant/homework/settings";
import styles from "./family.module.css";

const AGES = [6, 7, 8, 9, 10, 11, 12];

/**
 * Carte « Aide Devoirs » des réglages familiaux (US-118) : un interrupteur commun au foyer, modifiable par les deux parents, lisible par les autres profils ;
 * l'âge des devoirs de chaque enfant (sans lien avec sa date de naissance) ; « Effacer les progrès » après confirmation. Pendant l'enregistrement l'interrupteur
 * est grisé, et il garde sa position précédente en cas d'échec (RF6).
 */
export function HomeworkSettings() {
  const query = useApiQuery<{ setting: HomeworkSetting }>("/api/family/homework");
  const mutation = useApiMutation();
  const [override, setOverride] = useState<HomeworkSetting | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [intro, setIntro] = useState(false);
  const [erasing, setErasing] = useState(false);
  const [erased, setErased] = useState(false);
  const setting = override ?? query.data?.setting ?? null;

  async function patch(key: string, url: string, body: Record<string, unknown>) {
    setPending(key);
    const result = await mutation.run<{ setting: HomeworkSetting }>(url, { method: "PATCH", body });
    setPending(null);
    if (result) {
      setOverride(result.setting);
      setIntro(false);
    }
  }

  async function erase() {
    setPending("erase");
    const result = await mutation.run("/api/family/homework/progress", { method: "DELETE" });
    setPending(null);
    if (result !== undefined) {
      setErasing(false);
      setErased(true);
    }
  }

  function toggle() {
    if (!setting) return;
    // La première activation passe par la présentation en trois lignes (RF3).
    if (!setting.enabled && setting.needsIntro) setIntro(true);
    else void patch("enabled", "/api/family/homework", { enabled: !setting.enabled });
  }

  return (
    <Section title="Aide Devoirs">
      <p className={styles.hint}>Préparez chaque semaine les devoirs et les activités de vos enfants. Un réglage commun à toute la famille.</p>
      {query.loading && !setting && <Loading slow={query.slow} />}
      {query.error && <RetryNotice message={query.error.kind === "server" ? "L'aide Devoirs n'a pas pu être chargée." : query.error.message} onRetry={query.reload} />}
      {setting && !setting.hasChildren && <p className={styles.hint}>Ajoutez vos enfants dans les membres pour utiliser l&apos;aide Devoirs.</p>}
      {setting && setting.hasChildren && (
        <>
          <div className={styles.settingRow} role="group" aria-label="Aide Devoirs">
            <div className={styles.settingType}>Aide Devoirs</div>
            <div className={styles.switches}>
              <button type="button" role="switch" aria-checked={setting.enabled} aria-label="Aide Devoirs" className={styles.switch} disabled={!setting.canEdit || pending !== null} onClick={toggle}>
                {pending === "enabled" ? "Enregistrement…" : setting.enabled ? "Oui" : "Non"}
              </button>
            </div>
            {!setting.canEdit && <span className={styles.hint}>Lecture seule — seuls les parents peuvent la modifier.</span>}
          </div>

          {intro && (
            <div role="alertdialog" aria-label="Présentation de l'aide Devoirs" className={styles.form}>
              <p className={styles.confirmText}>
                Préparez chaque semaine les devoirs et les activités de vos enfants, en maths du CP au CM2 et en activités d&apos;éveil. Vous choisissez tout. Les photos du travail servent à suivre les
                progrès et ne sont pas conservées.
              </p>
              <div className={styles.actionsRow}>
                <Button variant="ghost" onClick={() => setIntro(false)} disabled={pending !== null}>
                  Annuler
                </Button>
                <Button onClick={() => void patch("enabled", "/api/family/homework", { enabled: true, confirmed: true })} loading={pending === "enabled"}>
                  Activer
                </Button>
              </div>
            </div>
          )}

          <div className={styles.label}>Âge des devoirs</div>
          <p className={styles.hint}>L&apos;âge des devoirs est souvent supérieur à l&apos;âge réel de l&apos;enfant : indiquez l&apos;âge correspondant au niveau auquel il travaille.</p>
          {setting.children.map((child) => (
            <div key={child.memberId} className={styles.settingRow}>
              <label className={styles.settingType} htmlFor={`homework-age-${child.memberId}`}>
                {child.firstName}
              </label>
              <select
                id={`homework-age-${child.memberId}`}
                className={styles.select}
                value={child.homeworkAge ?? ""}
                disabled={!setting.canEdit || pending !== null}
                onChange={(e) => e.target.value && void patch(child.memberId, `/api/family/homework/children/${child.memberId}`, { age: Number(e.target.value) })}
              >
                <option value="" disabled>
                  Non indiqué
                </option>
                {AGES.map((age) => (
                  <option key={age} value={age}>
                    {age} ans
                  </option>
                ))}
              </select>
              {child.levelLabel ? <span className={styles.hint}>Maths : {child.levelLabel}</span> : <span className={styles.hint}>Sans âge des devoirs, {child.firstName} n&apos;est pas proposé dans l&apos;aide.</span>}
            </div>
          ))}

          {setting.enabled && (
            <Link href="/assistant/devoirs" className={styles.linkRow}>
              <span>
                Semaines de devoirs
                <span className={styles.linkRowSub}>Préparer ou consulter</span>
              </span>
              <span aria-hidden>›</span>
            </Link>
          )}

          {setting.canEdit && !erasing && (
            <Button variant="ghost" onClick={() => setErasing(true)} disabled={pending !== null}>
              Effacer les progrès de Devoirs
            </Button>
          )}
          {erasing && (
            <div role="alertdialog" aria-label="Effacer les progrès de Devoirs ?" className={styles.form}>
              <div className={styles.confirmTitle}>Effacer les progrès de Devoirs ?</div>
              <p className={styles.confirmText}>Les semaines préparées, leurs tâches et les exercices validés sont supprimés. L&apos;âge des devoirs de chaque enfant est gardé. Cette action est irréversible.</p>
              <div className={styles.actionsRow}>
                <Button variant="ghost" onClick={() => setErasing(false)} disabled={pending !== null}>
                  Annuler
                </Button>
                <Button variant="danger" onClick={() => void erase()} loading={pending === "erase"}>
                  Effacer
                </Button>
              </div>
            </div>
          )}
          {erased && <Notice tone="info">Les progrès de Devoirs ont été effacés.</Notice>}
        </>
      )}
      {mutation.error && <Notice tone="error">{mutation.error.kind === "server" ? "Le réglage n'a pas pu être enregistré." : mutation.error.message}</Notice>}
    </Section>
  );
}
