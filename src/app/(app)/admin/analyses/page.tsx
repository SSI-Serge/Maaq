"use client";

import Link from "next/link";
import { useApiQuery } from "@/client/hooks";
import { PageHead, adminStyles as s } from "@/components/admin/AdminShell";
import { ErrorLine } from "@/components/auth/parts";
import { Loading } from "@/components/ui";
import type { ReviewSummary } from "@/server/admin/reviews";

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
const when = (iso: string) => `${new Date(iso).toLocaleDateString("fr-FR")} à ${new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}`;

/**
 * « Analyses à valider » (US-138) : les contrats transmis pour analyse dont la lecture est incertaine, de la plus ancienne à la plus récente. L'administrateur ne voit que la
 * catégorie, le texte masqué, le score de lecture et la date limite.
 */
export default function AdminReviewsPage() {
  const list = useApiQuery<{ reviews: ReviewSummary[]; count: number }>("/api/admin/reviews");
  return (
    <>
      <PageHead title="Analyses à valider" lead="Quand la lecture d'un document est peu fiable, vous décidez si l'analyse continue. Vous ne voyez que le texte masqué : jamais le document d'origine, le nom du contrat ni la famille." />
      {list.loading && !list.data && <Loading slow={list.slow} />}
      <ErrorLine error={list.error} onRetry={list.reload} />
      {list.data && (
        <ul className={s.list} style={{ maxWidth: 820 }}>
          {list.data.reviews.map((r) => (
            <li key={r.id} className={s.listItem}>
              <div className={s.row} style={{ justifyContent: "space-between" }}>
                <div>
                  <span style={{ fontWeight: 700 }}>{r.category}</span>
                  <div className={`${s.muted} ${s.small}`}>
                    {plural(r.documents, "document", "documents")} · lecture la plus faible : {r.lowestConfidencePct === null ? "inconnue" : `${r.lowestConfidencePct} %`} · demandée le {when(r.createdAt)} · documents supprimés le {when(r.expiresAt)}
                  </div>
                </div>
                <Link href={`/admin/analyses/${r.id}`} className={s.linkButton}>
                  Ouvrir
                </Link>
              </div>
            </li>
          ))}
          {list.data.reviews.length === 0 && <li className={s.empty}>Aucune analyse à valider.</li>}
        </ul>
      )}
    </>
  );
}
