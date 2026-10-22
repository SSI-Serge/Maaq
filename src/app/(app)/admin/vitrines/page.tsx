"use client";

import { useState } from "react";
import { useApiMutation, useApiQuery, useDebounced } from "@/client/hooks";
import { AdminDialog, PageHead, adminStyles as s, formatDate } from "@/components/admin/AdminShell";
import { ErrorLine } from "@/components/auth/parts";
import { Button, Loading, Notice } from "@/components/ui";
import type { Counters, StorefrontDetail, StorefrontFilter, StorefrontRow } from "@/server/admin/storefronts";

const FILTERS: { value: StorefrontFilter; label: string }[] = [
  { value: "all", label: "Toutes" },
  { value: "reported", label: "Signalées" },
  { value: "published", label: "Publiées" },
  { value: "draft", label: "Brouillons" },
  { value: "paused", label: "En pause" },
  { value: "suspended", label: "Suspendues" },
];

const STATUS_TEXT = { draft: "Brouillon", published: "Publiée", paused: "En pause" } as const;
const SUGGESTION_STATUS: Record<string, string> = { shown: "proposée", interested: "intéressé", dismissed: "écartée", muted: "catégorie coupée", expired: "expirée" };
const INTRO_STATUS: Record<string, string> = { requested: "demandée", question: "question posée", accepted: "acceptée", connected: "faite", declined: "refusée", expired: "expirée" };
const AUDIT_TEXT: Record<string, string> = { storefront_paused: "Suspendue", storefront_resumed: "Suspension levée", storefront_category_changed: "Catégorie corrigée", report_reviewed: "Signalement traité" };

/** Admin › Vitrines : liste par statut (signalées d'abord), suspension, catégorie, signalements, raisons internes, compteurs (US-16, US-17). */
export default function AdminStorefrontsPage() {
  const [filter, setFilter] = useState<StorefrontFilter>("all");
  const [search, setSearch] = useState("");
  const query = useDebounced(search);
  const list = useApiQuery<{ storefronts: StorefrontRow[]; counters: Counters }>(`/api/admin/vitrines?filtre=${filter}&q=${encodeURIComponent(query)}`);
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <>
      <PageHead title="Vitrines" lead="Vitrines du marketplace silencieux : signalements à traiter en premier, suspension, correction de catégorie, et pourquoi chaque suggestion a été faite ou retenue." />

      {list.data && <CountersPanel counters={list.data.counters} />}

      <div className={s.chips} style={{ marginBottom: 12 }}>
        {FILTERS.map((f) => (
          <button key={f.value} type="button" className={`${s.chip} ${filter === f.value ? s.chipOn : ""}`} onClick={() => setFilter(f.value)}>
            {f.label}
          </button>
        ))}
      </div>
      <input className={s.search} type="search" placeholder="Rechercher (nom affiché, email, nom du fournisseur, catégorie)…" aria-label="Rechercher une vitrine" value={search} onChange={(e) => setSearch(e.target.value)} />

      {list.loading && !list.data && <Loading slow={list.slow} />}
      <ErrorLine error={list.error} onRetry={list.reload} />

      {list.data && list.data.storefronts.length === 0 && <p className={s.empty}>Aucune vitrine pour ce filtre.</p>}
      {list.data && list.data.storefronts.length > 0 && (
        <table className={s.table}>
          <thead>
            <tr>
              <th>Vitrine</th>
              <th>Catégorie</th>
              <th>Statut</th>
              <th>Activité</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.data.storefronts.map((row) => (
              <tr key={row.id}>
                <td>
                  <div style={{ fontWeight: 700 }}>{row.displayName ?? "Sans nom"}</div>
                  <div className={`${s.muted} ${s.small}`}>
                    {row.supplier.name} · {row.supplier.email}
                  </div>
                  {row.openReports > 0 && (
                    <div className={s.small} style={{ marginTop: 4, color: "var(--error)", fontWeight: 600 }}>
                      {row.openReports} signalement{row.openReports > 1 ? "s" : ""} à traiter
                    </div>
                  )}
                </td>
                <td>{row.categoryLabel ?? "—"}</td>
                <td>
                  <StatusBadge row={row} />
                </td>
                <td className={s.small}>
                  {row.suggestionsShown} suggestion{row.suggestionsShown > 1 ? "s" : ""} · {row.introductions} mise{row.introductions > 1 ? "s" : ""} en relation
                </td>
                <td className={s.cellRight}>
                  <Button variant="secondary" onClick={() => setOpenId(row.id)}>
                    Ouvrir
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {openId && <DetailDialog id={openId} onClose={() => setOpenId(null)} onChanged={list.reload} />}
    </>
  );
}

function StatusBadge({ row }: { row: Pick<StorefrontRow, "status" | "adminPaused" | "pausedUntil"> }) {
  if (row.adminPaused) return <span className={`${s.badge} ${s.badgeError}`}>Suspendue par MAAQ</span>;
  const tone = row.status === "published" ? s.badgeOk : row.status === "paused" ? s.badgeWarn : s.badgeNeutral;
  return (
    <span className={`${s.badge} ${tone}`}>
      {STATUS_TEXT[row.status]}
      {row.pausedUntil ? ` · indispo. jusqu'au ${formatDate(row.pausedUntil, false)}` : ""}
    </span>
  );
}

function CountersPanel({ counters }: { counters: Counters }) {
  const line = (items: [string, number][]) => items.map(([label, n]) => `${label} ${n}`).join(" · ");
  return (
    <div className={s.panel} style={{ marginBottom: 16 }}>
      <div className={s.panelTitle}>Compteurs</div>
      <dl className={s.dl}>
        <dt>Vitrines</dt>
        <dd>
          {line([
            ["publiées", counters.storefronts.published],
            ["brouillons", counters.storefronts.draft],
            ["en pause", counters.storefronts.paused],
            ["suspendues", counters.storefronts.suspended],
          ])}
        </dd>
        <dt>Éligibles par catégorie</dt>
        <dd>{counters.eligibleByCategory.length ? counters.eligibleByCategory.map((c) => `${c.label} ${c.count}`).join(" · ") : "aucune"}</dd>
        <dt>Éligibles par département</dt>
        <dd>{counters.eligibleByDepartement.length ? counters.eligibleByDepartement.map((d) => `${d.departement} ${d.count}`).join(" · ") : "aucune"}</dd>
        <dt>Suggestions</dt>
        <dd>
          {line([
            ["montrées", counters.suggestions.shown + counters.suggestions.interested + counters.suggestions.dismissed + counters.suggestions.muted + counters.suggestions.expired],
            ["intérêt", counters.suggestions.interested],
            ["écartées", counters.suggestions.dismissed],
          ])}
        </dd>
        <dt>Mises en relation</dt>
        <dd>
          {line([
            ["demandées", counters.introductions.requested],
            ["en question", counters.introductions.question],
            ["faites", counters.introductions.connected],
            ["refusées", counters.introductions.declined],
            ["expirées", counters.introductions.expired],
          ])}
        </dd>
        <dt>Signalements</dt>
        <dd>{line([["à traiter", counters.reports.open], ["traités", counters.reports.reviewed], ["sans suite", counters.reports.dismissed]])}</dd>
      </dl>
    </div>
  );
}

function DetailDialog({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const detail = useApiQuery<StorefrontDetail>(`/api/admin/vitrines/${id}`);
  const act = useApiMutation();
  const [reason, setReason] = useState("");
  const [category, setCategory] = useState<string | null>(null);
  const [decision, setDecision] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);

  async function run(path: string, body: unknown, message: string) {
    setDone(null);
    const result = await act.run(path, { method: "POST", body });
    if (result !== undefined) {
      setDone(message);
      detail.reload();
      onChanged();
    }
  }

  const d = detail.data;
  return (
    <AdminDialog title={d ? (d.storefront.displayName ?? "Sans nom") : "Vitrine"} onClose={onClose}>
      {detail.loading && !d && <Loading slow={detail.slow} />}
      <ErrorLine error={detail.error} onRetry={detail.reload} />
      {d && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16, maxHeight: "70vh", overflowY: "auto" }}>
          {done && <Notice tone="success">✓ {done}</Notice>}
          <ErrorLine error={act.error} />

          <div>
            <div className={s.small} style={{ marginBottom: 6 }}>
              {d.storefront.supplier.name} · {d.storefront.supplier.email} · <StatusBadge row={d.storefront} />
            </div>
            <dl className={s.dl}>
              <dt>Catégorie</dt>
              <dd>{d.preview.category}</dd>
              <dt>Services</dt>
              <dd>{d.preview.services.join(", ") || "—"}</dd>
              <dt>Description</dt>
              <dd>{d.preview.description || "—"}</dd>
              <dt>Zone</dt>
              <dd>{d.preview.area}</dd>
              <dt>Disponibilité</dt>
              <dd>{d.preview.availability}</dd>
              <dt>Tarif</dt>
              <dd>{d.preview.price}</dd>
              <dt>Publiée le</dt>
              <dd>{d.storefront.publishedAt ? formatDate(d.storefront.publishedAt) : "—"}</dd>
              <dt>Confirmée le</dt>
              <dd>{d.storefront.lastConfirmedAt ? formatDate(d.storefront.lastConfirmedAt) : "—"}</dd>
            </dl>
          </div>

          <div className={s.panel}>
            <div className={s.panelTitle}>{d.storefront.adminPaused ? "Suspension" : "Suspendre"}</div>
            {d.storefront.adminPaused ? (
              <>
                <p className={s.small}>Suspendue : « {d.storefront.adminPauseReason} ». La vitrine ne sort plus en suggestion.</p>
                <Button variant="secondary" loading={act.pending} onClick={() => run(`/api/admin/vitrines/${id}/pause`, { paused: false }, "Suspension levée")}>
                  Lever la suspension
                </Button>
              </>
            ) : (
              <div className={s.row}>
                <input className={s.input} placeholder="Raison montrée au fournisseur (obligatoire)" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
                <Button variant="secondary" loading={act.pending} disabled={!reason.trim()} onClick={() => run(`/api/admin/vitrines/${id}/pause`, { paused: true, reason: reason.trim() }, "Vitrine suspendue")}>
                  Suspendre
                </Button>
              </div>
            )}
          </div>

          <div className={s.panel}>
            <div className={s.panelTitle}>Corriger la catégorie</div>
            <div className={s.row}>
              <select className={s.select} value={category ?? d.storefront.categoryCode ?? ""} onChange={(e) => setCategory(e.target.value)}>
                {d.categories.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.label}
                  </option>
                ))}
              </select>
              <Button variant="secondary" loading={act.pending} disabled={!category || category === d.storefront.categoryCode} onClick={() => run(`/api/admin/vitrines/${id}/category`, { categoryCode: category }, "Catégorie corrigée")}>
                Enregistrer
              </Button>
            </div>
          </div>

          <div className={s.panel}>
            <div className={s.panelTitle}>Signalements ({d.reports.length})</div>
            {d.reports.length === 0 && <p className={s.small}>Aucun signalement.</p>}
            {d.reports.map((r) => (
              <div key={r.id} className={s.listItem}>
                <div>
                  <b>{r.reasonLabel}</b> — {r.reporterFirstName ?? "membre supprimé"}, le {formatDate(r.createdAt)}
                  {r.comment && <div className={s.small}>« {r.comment} »</div>}
                </div>
                {r.status === "open" ? (
                  <div className={s.row} style={{ marginTop: 6 }}>
                    <input className={s.input} placeholder="Suite donnée (facultatif)" value={decision[r.id] ?? ""} maxLength={300} onChange={(e) => setDecision({ ...decision, [r.id]: e.target.value })} />
                    <Button variant="secondary" loading={act.pending} onClick={() => run(`/api/admin/vitrines/reports/${r.id}`, { status: "reviewed", decision: decision[r.id] ?? null }, "Signalement traité")}>
                      Traité
                    </Button>
                    <Button variant="secondary" loading={act.pending} onClick={() => run(`/api/admin/vitrines/reports/${r.id}`, { status: "dismissed", decision: decision[r.id] ?? null }, "Signalement classé sans suite")}>
                      Sans suite
                    </Button>
                  </div>
                ) : (
                  <div className={s.small}>
                    {r.status === "reviewed" ? "Traité" : "Sans suite"} par {r.adminName ?? "—"} le {r.reviewedAt ? formatDate(r.reviewedAt) : "—"}
                    {r.adminDecision && ` : ${r.adminDecision}`}
                  </div>
                )}
              </div>
            ))}
          </div>

          <div className={s.panel}>
            <div className={s.panelTitle}>Suggestions ({d.suggestions.length}) — pourquoi, pour l&apos;opérateur</div>
            {d.suggestions.length === 0 && <p className={s.small}>Jamais suggérée.</p>}
            {d.suggestions.map((g) => (
              <div key={g.id} className={s.listItem}>
                <div>
                  <b>{g.buyerFirstName ?? "membre"}</b> · {formatDate(g.shownAt)} · {SUGGESTION_STATUS[g.status] ?? g.status} · score {g.score ?? "—"} ({g.fit === "strong" ? "affirmée" : "en question"})
                  {g.requestText && <div className={s.small}>Besoin : « {g.requestText} »</div>}
                  <div className={s.small}>Raison montrée : {g.reason}</div>
                </div>
                <pre className={s.small} style={{ whiteSpace: "pre-wrap", margin: "6px 0 0" }}>
                  {g.internalReason}
                </pre>
              </div>
            ))}
          </div>

          {d.matchLog.length > 0 && (
            <div className={s.panel}>
              <div className={s.panelTitle}>Journal de mise en relation ({d.matchLog.length}) — y compris les fois où elle n&apos;a pas été montrée</div>
              {d.matchLog.map((l, i) => (
                <div key={`${l.requestId}-${i}`} className={s.listItem}>
                  <div>
                    <b>{l.buyerFirstName ?? "membre"}</b> · {l.at ? formatDate(l.at) : "—"} · {l.entry.decision === "shown" ? "montrée" : l.entry.decision === "withheld" ? "retenue" : "inéligible"}
                  </div>
                  <pre className={s.small} style={{ whiteSpace: "pre-wrap", margin: "6px 0 0" }}>
                    {l.entry.lines.join("\n")}
                  </pre>
                </div>
              ))}
            </div>
          )}

          <div className={s.panel}>
            <div className={s.panelTitle}>Mises en relation ({d.introductions.length})</div>
            {d.introductions.length === 0 && <p className={s.small}>Aucune.</p>}
            {d.introductions.map((i) => (
              <div key={i.id} className={s.small}>
                {i.buyerFirstName ?? "membre"} · demandée le {formatDate(i.requestedAt)} · {INTRO_STATUS[i.status] ?? i.status}
                {i.answeredAt && ` (réponse le ${formatDate(i.answeredAt)})`}
              </div>
            ))}
          </div>

          {d.audit.length > 0 && (
            <div className={s.panel}>
              <div className={s.panelTitle}>Actions d&apos;administration</div>
              {d.audit.map((a, i) => (
                <div key={i} className={s.small}>
                  {formatDate(a.at)} · {AUDIT_TEXT[a.action] ?? a.action} · {a.admin ?? "—"}
                  {a.details ? ` · ${JSON.stringify(a.details)}` : ""}
                </div>
              ))}
            </div>
          )}

          <div className={s.actions}>
            <Button variant="secondary" onClick={onClose}>
              Fermer
            </Button>
          </div>
        </div>
      )}
    </AdminDialog>
  );
}
