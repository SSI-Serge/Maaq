"use client";

import Link from "next/link";
import { useApiQuery } from "@/client/hooks";
import { AppShell, Section } from "@/components/app/AppShell";
import { Loading, Notice, RetryNotice } from "@/components/ui";
import type { HomeworkSetting } from "@/server/assistant/homework/settings";
import type { WeekSummary } from "@/server/assistant/homework/weeks";
import { shortDate } from "./format";
import styles from "./family.module.css";

/**
 * Écran « Devoirs » (S-52) : l'historique des semaines préparées, passées comprises. On ne prépare plus de semaine ici : « Préparer les devoirs » est sur l'écran de la tâche.
 * Il s'ouvre depuis Réglages › Aide Devoirs et depuis la tâche (« Semaines passées › ») ; le retour mène à l'écran d'où l'on vient. Réservé aux parents, aide activée.
 */
export function HomeworkListScreen({ from }: { from: "tache" | "reglages" }) {
  const list = useApiQuery<{ weeks: WeekSummary[]; today: string }>("/api/family/homework/weeks");
  const setting = useApiQuery<{ setting: HomeworkSetting }>("/api/family/homework");
  const data = list.data;
  const enabled = setting.data?.setting.enabled;
  const back = from === "tache" ? { href: "/assistant/devoirs/tache", label: "Préparer les devoirs" } : { href: "/assistant/reglages", label: "Réglages" };
  return (
    <AppShell title="Semaines de devoirs" back={back}>
      {list.error && <RetryNotice message={list.error.kind === "server" ? "Les semaines de devoirs n'ont pas pu être chargées." : list.error.message} onRetry={list.reload} />}
      {list.loading && !data && <Loading slow={list.slow} />}
      {enabled === false && (
        <Notice tone="info">
          L&apos;aide Devoirs est désactivée. <Link href="/assistant/reglages">Réglages</Link>
        </Notice>
      )}
      {data && enabled !== false && (
        <Section title="Semaines préparées">
          <p className={styles.hint}>Toutes les semaines préparées, de la plus récente à la plus ancienne. Pour en préparer une, ouvrez la tâche « Préparer les devoirs ».</p>
          {data.weeks.length === 0 && <p className={styles.hint}>Aucune semaine préparée pour le moment.</p>}
          <div className={styles.taskList}>
            {data.weeks.map((w) => (
              <Link key={w.id} href={`/assistant/devoirs/${w.id}`} className={styles.linkRow}>
                <span>
                  Semaine du {shortDate(w.weekStart)}
                  <span className={styles.linkRowSub}>
                    {w.children.join(", ")} · {w.items} {w.items > 1 ? "éléments" : "élément"}
                    {w.weekEnd < data.today ? " · passée" : ""}
                  </span>
                </span>
                <span aria-hidden>›</span>
              </Link>
            ))}
          </div>
        </Section>
      )}
    </AppShell>
  );
}

export { HomeworkWeekScreen } from "./HomeworkWeekScreen";
export { HomeworkPrintScreen } from "./HomeworkPrint";
