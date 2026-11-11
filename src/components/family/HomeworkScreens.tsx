"use client";

import Link from "next/link";
import { useApiQuery } from "@/client/hooks";
import { AppShell, Section } from "@/components/app/AppShell";
import { Loading, Notice, RetryNotice } from "@/components/ui";
import type { HomeworkSetting } from "@/server/assistant/homework/settings";
import type { WeekSummary } from "@/server/assistant/homework/weeks";
import { shortDate } from "./format";
import styles from "./family.module.css";

/** Écran « Devoirs » : les semaines préparées et les semaines à venir à préparer (US-119 RF9). Réservé aux parents, aide activée. */
export function HomeworkListScreen() {
  const list = useApiQuery<{ weeks: WeekSummary[]; today: string; mondays: { weekStart: string; prepared: boolean; weekId: string | null }[] }>("/api/family/homework/weeks");
  const setting = useApiQuery<{ setting: HomeworkSetting }>("/api/family/homework");
  const data = list.data;
  const enabled = setting.data?.setting.enabled;
  return (
    <AppShell title="Devoirs" back={{ href: "/assistant", label: "Assistant Famille" }}>
      {list.error && <RetryNotice message={list.error.kind === "server" ? "Les semaines de devoirs n'ont pas pu être chargées." : list.error.message} onRetry={list.reload} />}
      {list.loading && !data && <Loading slow={list.slow} />}
      {enabled === false && (
        <Notice tone="info">
          L&apos;aide Devoirs est désactivée. <Link href="/assistant/reglages">Réglages</Link>
        </Notice>
      )}
      {data && enabled !== false && (
        <>
          <Section title="Préparer une semaine">
            <p className={styles.hint}>L&apos;aide vous propose des exercices de maths et des activités pour chaque enfant ; vous choisissez tout.</p>
            <div className={styles.taskList}>
              {data.mondays.map((m) => (
                <Link key={m.weekStart} href={m.prepared && m.weekId ? `/assistant/devoirs/${m.weekId}` : `/assistant/devoirs/preparer?semaine=${m.weekStart}`} className={styles.linkRow}>
                  <span>
                    Semaine du {shortDate(m.weekStart)}
                    <span className={styles.linkRowSub}>{m.prepared ? "Déjà préparée · l'ouvrir pour la modifier" : "Préparer les devoirs"}</span>
                  </span>
                  <span aria-hidden>›</span>
                </Link>
              ))}
            </div>
          </Section>
          <Section title="Semaines préparées">
            {data.weeks.length === 0 && <p className={styles.hint}>Aucune semaine préparée pour le moment.</p>}
            <div className={styles.taskList}>
              {data.weeks.map((w) => (
                <Link key={w.id} href={`/assistant/devoirs/${w.id}`} className={styles.linkRow}>
                  <span>
                    Semaine du {shortDate(w.weekStart)}
                    <span className={styles.linkRowSub}>
                      {w.children.join(", ")} · {w.items} {w.items > 1 ? "éléments" : "élément"}
                    </span>
                  </span>
                  <span aria-hidden>›</span>
                </Link>
              ))}
            </div>
          </Section>
        </>
      )}
    </AppShell>
  );
}

export { HomeworkWeekScreen } from "./HomeworkWeekScreen";
export { HomeworkPrintScreen } from "./HomeworkPrint";
