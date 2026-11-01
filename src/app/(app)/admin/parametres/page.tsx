"use client";

import { useState } from "react";
import { ApiError, apiRequest, newIdempotencyKey } from "@/client/api";
import { useApiQuery } from "@/client/hooks";
import { PageHead, adminStyles as s, formatDate } from "@/components/admin/AdminShell";
import { ErrorLine } from "@/components/auth/parts";
import { Button, Loading, Notice } from "@/components/ui";

interface Setting {
  key: string;
  type: "integer" | "email" | "free_text";
  value: string | null;
  min: number | null;
  max: number | null;
}

interface SettingsData {
  settings: Setting[];
  history: { key: string; before: string | null; after: string | null; admin: string; at: string }[];
}

/** Libellés et regroupement des réglages, d'après la maquette Paramètres (US-65 RF1). */
const SECTIONS: { title: string; items: { key: string; label: string; note?: string }[] }[] = [
  {
    title: "Carnet de bord",
    items: [
      { key: "logbook_sync_interval_hours", label: "Fréquence de synchronisation (heures, 1 à 24)" },
      { key: "logbook_retention_months", label: "Durée de conservation (mois)" },
    ],
  },
  {
    title: "Contrats",
    items: [
      { key: "max_document_size_mb", label: "Taille maximale d'un document (Mo)" },
      { key: "max_contracts_per_category", label: "Contrats au plus par catégorie et par famille", note: "Plafond technique, contrat de base compris : invisible en usage normal." },
      { key: "contract_document_retention_days", label: "Conservation d'un document sans transmission (jours)", note: "Après une transmission, les documents sont supprimés au bout de 48 h dans tous les cas." },
      { key: "contract_read_confidence_threshold_pct", label: "Seuil de confiance de lecture (%)", note: "En dessous, la lecture d'un document est incertaine et l'analyse attend la décision d'un administrateur." },
    ],
  },
  {
    title: "Challenge des contrats",
    items: [
      { key: "contract_broker_name", label: "Nom du courtier partenaire", note: "Tant que le nom et l'adresse du courtier ne sont pas renseignés, le challenge est bloqué pour toutes les familles." },
      { key: "contract_broker_email", label: "Adresse de la boîte du courtier" },
    ],
  },
  {
    title: "Comptes et invités",
    items: [
      { key: "guest_data_retention_days", label: "Délai de suppression des données d'un invité supprimé (jours)" },
      { key: "unactivated_purge_days", label: "Délai de suppression — comptes et invités jamais activés (jours)" },
    ],
  },
  {
    title: "Agents et conformité",
    items: [
      {
        key: "max_agents_per_category",
        label: "Agents maximum par rubrique du catalogue",
        note: "S'applique aux ajouts suivants : les profils déjà au-dessus de la limite conservent leurs agents.",
      },
      { key: "error_report_retention_months", label: "Durée de conservation des signalements d'erreur (mois)" },
      { key: "security_event_retention_months", label: "Durée de conservation du journal de sécurité (mois)" },
    ],
  },
  {
    title: "Alertes et support",
    items: [
      { key: "alert_email", label: "Adresse email d'alerte (échecs de synchronisation, d'effacement et de suppression)" },
      { key: "support_email", label: "Adresse email de la boîte du support" },
    ],
  },
];

const LABELS = Object.fromEntries(SECTIONS.flatMap((section) => section.items.map((item) => [item.key, item.label])));
const EMAIL_FORMAT = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function check(setting: Setting, raw: string): string | null {
  const value = raw.trim();
  if (setting.type === "free_text") return value.length <= 120 ? null : "120 caractères au plus.";
  if (setting.type === "email") return value === "" || EMAIL_FORMAT.test(value) ? null : "Adresse email invalide";
  if (!/^\d+$/.test(value)) return "Indiquez un nombre entier.";
  const n = Number(value);
  if (setting.min !== null && n < setting.min) return `La valeur doit être au moins ${setting.min}.`;
  if (setting.max !== null && n > setting.max) return `La valeur doit être au plus ${setting.max}.`;
  return null;
}

/** Délais et limites de la plateforme, avec l'historique des modifications (US-65). */
export default function AdminSettingsPage() {
  const query = useApiQuery<SettingsData>("/api/admin/settings");
  return (
    <>
      <PageHead
        title="Paramètres — délais et limites de la plateforme"
        lead="Une nouvelle valeur s'applique à partir du cycle de traitement suivant ; elle ne modifie pas les traitements déjà programmés."
      />
      {query.loading && !query.data && <Loading slow={query.slow} />}
      <ErrorLine error={query.error} onRetry={query.reload} />
      {query.data && <SettingsForm initial={query.data} />}
    </>
  );
}

function SettingsForm({ initial }: { initial: SettingsData }) {
  const [data, setData] = useState(initial);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(initial.settings.map((setting) => [setting.key, setting.value ?? ""])),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiError>();
  const [saved, setSaved] = useState(false);

  const byKey = Object.fromEntries(data.settings.map((setting) => [setting.key, setting]));
  const changed = Object.fromEntries(Object.entries(values).filter(([key, value]) => (byKey[key]?.value ?? "") !== value.trim()));

  async function save() {
    setSaved(false);
    const found: Record<string, string> = {};
    for (const [key, value] of Object.entries(changed)) {
      const problem = check(byKey[key], value);
      if (problem) found[key] = problem;
    }
    setErrors(found);
    if (Object.keys(found).length) return;

    setSaving(true);
    setError(undefined);
    try {
      // Enregistrement rejouable sans risque : renvoyer les mêmes valeurs ne change rien.
      const result = await apiRequest<SettingsData & { changed: number }>("/api/admin/settings", {
        method: "PUT",
        body: { values: changed },
        idempotencyKey: newIdempotencyKey(),
      });
      setData(result);
      setValues(Object.fromEntries(result.settings.map((setting) => [setting.key, setting.value ?? ""])));
      setSaved(true);
    } catch (err) {
      const apiError = err as ApiError;
      if (apiError.body?.code === "invalid_settings") setErrors(apiError.body.details as Record<string, string>);
      else setError(apiError);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <section className={s.panel} style={{ maxWidth: 880 }}>
        {SECTIONS.map((section) => (
          <div key={section.title} style={{ marginBottom: 22 }}>
            <div className={s.panelTitle}>{section.title}</div>
            <div className={s.grid2}>
              {section.items.map((item) => {
                const setting = byKey[item.key];
                if (!setting) return null;
                return (
                  <div key={item.key}>
                    <label className={s.label} htmlFor={item.key}>
                      {item.label}
                    </label>
                    <input
                      id={item.key}
                      className={`${s.input} ${errors[item.key] ? s.inputError : ""}`}
                      type={setting.type === "email" ? "email" : setting.type === "free_text" ? "text" : "number"}
                      maxLength={setting.type === "free_text" ? 120 : undefined}
                      min={setting.min ?? undefined}
                      max={setting.max ?? undefined}
                      value={values[item.key] ?? ""}
                      onChange={(e) => {
                        setValues({ ...values, [item.key]: e.target.value });
                        setErrors({ ...errors, [item.key]: "" });
                        setSaved(false);
                      }}
                    />
                    {errors[item.key] && <div className={s.fieldError}>{errors[item.key]}</div>}
                    {item.note && <div className={s.hint}>{item.note}</div>}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
        <ErrorLine error={error} onRetry={save} />
        {saved && <Notice tone="success">✓ Paramètres enregistrés</Notice>}
        <div className={s.actions}>
          <Button loading={saving} disabled={Object.keys(changed).length === 0} onClick={save}>
            Enregistrer
          </Button>
        </div>
      </section>

      <div className={s.panelTitle} style={{ marginTop: 26 }}>
        Historique des modifications
      </div>
      <table className={s.table} style={{ maxWidth: 880 }}>
        <thead>
          <tr>
            <th>Paramètre</th>
            <th>Ancien</th>
            <th>Nouveau</th>
            <th>Administrateur</th>
            <th>Date</th>
          </tr>
        </thead>
        <tbody>
          {data.history.map((h, i) => (
            <tr key={`${h.key}-${h.at}-${i}`}>
              <td>{LABELS[h.key] ?? h.key}</td>
              <td>{h.before ?? "—"}</td>
              <td>{h.after ?? "—"}</td>
              <td>{h.admin}</td>
              <td>{formatDate(h.at)}</td>
            </tr>
          ))}
          {data.history.length === 0 && (
            <tr>
              <td colSpan={5} className={s.empty}>
                Aucune modification pour l&apos;instant.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </>
  );
}
