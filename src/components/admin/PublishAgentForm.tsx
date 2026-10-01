"use client";

import { useState } from "react";
import { useApiAction, useApiQuery } from "@/client/hooks";
import { ErrorLine } from "@/components/auth/parts";
import { Button, Loading, Notice } from "@/components/ui";
import { adminStyles as s } from "./AdminShell";

type Category = "pro" | "perso" | "contracts";
type Scope = "each_profile" | "primary_user" | "account";
type DataType = "text" | "phone" | "postal_code" | "past_date" | "email";
type ConnectorCode = "google_drive" | "google_calendar" | "validation_mailbox";

const CATEGORIES: { code: Category; label: string }[] = [
  { code: "pro", label: "Pro" },
  { code: "perso", label: "Perso" },
  { code: "contracts", label: "Agents des Contrats" },
];

const CONNECTORS: { code: ConnectorCode; label: string }[] = [
  { code: "google_drive", label: "Google Drive" },
  { code: "google_calendar", label: "Google Agenda" },
  { code: "validation_mailbox", label: "Boîte mail de validation" },
];

const SCOPES: { code: Scope; label: string }[] = [
  { code: "each_profile", label: "Chaque profil" },
  { code: "primary_user", label: "Utilisateur principal" },
  { code: "account", label: "Connexion unique du compte" },
];

const DATA_TYPES: { code: DataType; label: string }[] = [
  { code: "text", label: "Texte" },
  { code: "phone", label: "Téléphone" },
  { code: "postal_code", label: "Code postal" },
  { code: "past_date", label: "Date passée" },
  { code: "email", label: "Email" },
];

interface InfoField {
  label: string;
  dataType: DataType;
  required: boolean;
  maxItems: number;
  sharedKey: string | null;
}

const toLines = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * Formulaire de mise à disposition d'un agent (US-45 RF2, RF10) : agent Digitorn, rubrique unique,
 * descriptions, exemples et suggestions, connecteurs et leur portée, informations à demander,
 * adresses en copie, actions soumises à validation.
 */
export function PublishAgentForm({ onCancel, onPublished }: { onCancel: () => void; onPublished: (categoryLabel: string) => void }) {
  const hosted = useApiQuery<{ agents: { ref: string; name: string }[] }>("/api/admin/agents/publishable");
  const publish = useApiAction<unknown, { id: string }>("/api/admin/agents");

  const [ref, setRef] = useState("");
  const [name, setName] = useState("");
  const [category, setCategory] = useState<Category | null>(null);
  const [shortDescription, setShortDescription] = useState("");
  const [fullDescription, setFullDescription] = useState("");
  const [examples, setExamples] = useState("");
  const [suggestions, setSuggestions] = useState("");
  const [connectors, setConnectors] = useState<Partial<Record<ConnectorCode, Scope>>>({});
  const [fields, setFields] = useState<InfoField[]>([]);
  const [ccMax, setCcMax] = useState("0");
  const [actions, setActions] = useState("");
  const [problems, setProblems] = useState<string[]>([]);

  const [newField, setNewField] = useState<InfoField>({ label: "", dataType: "text", required: true, maxItems: 1, sharedKey: null });
  const [fieldError, setFieldError] = useState<string>();

  function addField() {
    const label = newField.label.trim();
    if (!label) return setFieldError("Le libellé est obligatoire.");
    if (fields.some((f) => f.label.toLowerCase() === label.toLowerCase())) return setFieldError("Ce libellé existe déjà.");
    const key = newField.sharedKey?.trim() || null;
    if (key && !/^[a-z0-9_]+$/.test(key)) return setFieldError("Clé commune : minuscules, chiffres et _ uniquement (ex. telephone).");
    if (!Number.isInteger(newField.maxItems) || newField.maxItems < 1 || newField.maxItems > 100) {
      return setFieldError("Le nombre maximal d'éléments va de 1 à 100.");
    }
    setFields([...fields, { ...newField, label, sharedKey: key }]);
    setNewField({ label: "", dataType: "text", required: true, maxItems: 1, sharedKey: null });
    setFieldError(undefined);
  }

  async function submit() {
    const missing: string[] = [];
    if (!ref) missing.push("Choisissez l'agent Digitorn à publier.");
    if (!name.trim()) missing.push("Le nom de l'agent est obligatoire.");
    if (!category) missing.push("Choisissez une rubrique.");
    if (!shortDescription.trim()) missing.push("La description courte est obligatoire.");
    if (!fullDescription.trim()) missing.push("La description complète est obligatoire.");
    const cc = Number(ccMax);
    if (!Number.isInteger(cc) || cc < 0 || cc > 50) missing.push("Le nombre d'adresses en copie va de 0 à 50.");
    setProblems(missing);
    if (missing.length) return;

    const result = await publish.run({
      digitornRef: ref,
      name: name.trim(),
      category,
      shortDescription: shortDescription.trim(),
      fullDescription: fullDescription.trim(),
      examples: toLines(examples),
      suggestions: toLines(suggestions),
      connectors: Object.entries(connectors).map(([code, scope]) => ({ code, scope })),
      infoFields: fields,
      ccMaxCount: cc,
      validatedActions: toLines(actions),
    });
    if (result) onPublished(CATEGORIES.find((c) => c.code === category)!.label);
  }

  return (
    <section className={s.panel}>
      <div className={s.panelTitle}>Nouvel agent</div>
      <div className={s.grid2}>
        <div>
          <label className={s.label} htmlFor="agent-ref">
            Agent hébergé chez Digitorn
          </label>
          {hosted.loading && <Loading slow={hosted.slow} />}
          <ErrorLine error={hosted.error} onRetry={hosted.reload} />
          {hosted.data && (
            <select
              id="agent-ref"
              className={s.select}
              value={ref}
              onChange={(e) => {
                setRef(e.target.value);
                const picked = hosted.data?.agents.find((a) => a.ref === e.target.value);
                if (picked && !name.trim()) setName(picked.name);
              }}
            >
              <option value="">{hosted.data.agents.length ? "Choisir un agent…" : "Aucun agent à publier"}</option>
              {hosted.data.agents.map((a) => (
                <option key={a.ref} value={a.ref}>
                  {a.name}
                </option>
              ))}
            </select>
          )}
        </div>
        <div>
          <label className={s.label} htmlFor="agent-name">
            Nom affiché de l&apos;agent
          </label>
          <input id="agent-name" className={s.input} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex. Admin_RDV" />
        </div>

        <div className={s.full}>
          <span className={s.label}>Rubrique du catalogue (un agent n&apos;appartient qu&apos;à une seule)</span>
          <div className={s.chips} role="radiogroup" aria-label="Rubrique">
            {CATEGORIES.map((c) => (
              <button
                key={c.code}
                type="button"
                role="radio"
                aria-checked={category === c.code}
                className={`${s.chip} ${category === c.code ? s.chipOn : ""}`}
                onClick={() => setCategory(c.code)}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className={s.hint}>La rubrique ne pourra pas être changée après la publication.</div>
        </div>

        <div className={s.full}>
          <label className={s.label} htmlFor="short">
            Description courte pour les utilisateurs
          </label>
          <input
            id="short"
            className={s.input}
            maxLength={200}
            value={shortDescription}
            onChange={(e) => setShortDescription(e.target.value)}
            placeholder="Ex. Prise de rendez-vous santé et assurance emprunteur"
          />
        </div>
        <div className={s.full}>
          <label className={s.label} htmlFor="full">
            Description complète (fiche de l&apos;agent)
          </label>
          <textarea id="full" className={s.textarea} maxLength={5000} value={fullDescription} onChange={(e) => setFullDescription(e.target.value)} />
        </div>

        <div>
          <label className={s.label} htmlFor="examples">
            Exemples de demandes (un par ligne)
          </label>
          <textarea
            id="examples"
            className={s.textarea}
            value={examples}
            onChange={(e) => setExamples(e.target.value)}
            placeholder={"Prends-moi un rendez-vous chez le dentiste\nRenouvelle mon contrat d'assurance auto"}
          />
        </div>
        <div>
          <label className={s.label} htmlFor="suggestions">
            Suggestions affichées dans le tchat (une par ligne)
          </label>
          <textarea
            id="suggestions"
            className={s.textarea}
            value={suggestions}
            onChange={(e) => setSuggestions(e.target.value)}
            placeholder={"Prendre un rendez-vous\nVoir mes contrats en cours"}
          />
        </div>

        <div className={s.full}>
          <span className={s.label}>Connecteurs requis, et leur portée</span>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {CONNECTORS.map((c) => {
              const scope = connectors[c.code];
              return (
                <div key={c.code} className={s.row}>
                  <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13, minWidth: 220 }}>
                    <input
                      type="checkbox"
                      checked={scope !== undefined}
                      onChange={(e) => {
                        const next = { ...connectors };
                        if (e.target.checked) next[c.code] = "each_profile";
                        else delete next[c.code];
                        setConnectors(next);
                      }}
                    />
                    {c.label}
                  </label>
                  {scope && (
                    <select
                      className={s.select}
                      style={{ width: 240 }}
                      aria-label={`Portée de ${c.label}`}
                      value={scope}
                      onChange={(e) => setConnectors({ ...connectors, [c.code]: e.target.value as Scope })}
                    >
                      {SCOPES.map((sc) => (
                        <option key={sc.code} value={sc.code}>
                          {sc.label}
                        </option>
                      ))}
                    </select>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className={s.full}>
          <span className={s.label}>Informations que l&apos;utilisateur devra renseigner pour cet agent</span>
          {fields.length > 0 && (
            <table className={s.table} style={{ marginBottom: 10 }}>
              <thead>
                <tr>
                  <th>Libellé</th>
                  <th>Type</th>
                  <th>Oblig.</th>
                  <th>Max</th>
                  <th>Clé commune</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {fields.map((f, i) => (
                  <tr key={f.label}>
                    <td>{f.label}</td>
                    <td>{DATA_TYPES.find((t) => t.code === f.dataType)!.label}</td>
                    <td>{f.required ? "Oui" : "Non"}</td>
                    <td>{f.maxItems}</td>
                    <td>{f.sharedKey ?? "—"}</td>
                    <td className={s.cellRight}>
                      <button type="button" className={`${s.linkButton} ${s.dangerLink}`} onClick={() => setFields(fields.filter((_, j) => j !== i))}>
                        Retirer
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className={s.row}>
            <input
              className={s.input}
              style={{ width: 220 }}
              aria-label="Libellé du champ"
              placeholder="Libellé (ex. Numéro fiscal)"
              maxLength={150}
              value={newField.label}
              onChange={(e) => setNewField({ ...newField, label: e.target.value })}
            />
            <select
              className={s.select}
              style={{ width: 150 }}
              aria-label="Type du champ"
              value={newField.dataType}
              onChange={(e) => setNewField({ ...newField, dataType: e.target.value as DataType })}
            >
              {DATA_TYPES.map((t) => (
                <option key={t.code} value={t.code}>
                  {t.label}
                </option>
              ))}
            </select>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
              <input type="checkbox" checked={newField.required} onChange={(e) => setNewField({ ...newField, required: e.target.checked })} />
              Obligatoire
            </label>
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
              Max éléments
              <input
                className={s.input}
                style={{ width: 70 }}
                type="number"
                min={1}
                max={100}
                value={newField.maxItems}
                onChange={(e) => setNewField({ ...newField, maxItems: Number(e.target.value) })}
              />
            </label>
            <input
              className={s.input}
              style={{ width: 200 }}
              aria-label="Clé commune"
              placeholder="Clé commune (facultatif)"
              value={newField.sharedKey ?? ""}
              onChange={(e) => setNewField({ ...newField, sharedKey: e.target.value })}
            />
            <Button type="button" variant="secondary" onClick={addField}>
              + Ajouter ce champ
            </Button>
          </div>
          {fieldError && <div className={s.fieldError}>{fieldError}</div>}
          <div className={s.hint}>
            La clé commune (ex. telephone) pré-remplit la valeur déjà saisie pour un autre agent ayant un champ de même clé.
          </div>
        </div>

        <div>
          <label className={s.label} htmlFor="cc">
            Adresses en copie — nombre maximal par profil (0 = pas de section)
          </label>
          <input id="cc" className={s.input} type="number" min={0} max={50} value={ccMax} onChange={(e) => setCcMax(e.target.value)} />
        </div>
        <div>
          <label className={s.label} htmlFor="actions">
            Actions soumises à validation de l&apos;utilisateur (une par ligne)
          </label>
          <textarea
            id="actions"
            className={s.textarea}
            value={actions}
            onChange={(e) => setActions(e.target.value)}
            placeholder={"Créer un rendez-vous\nEnvoyer un email"}
          />
        </div>
      </div>

      {problems.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <Notice tone="error">
            {problems.map((p) => (
              <div key={p}>{p}</div>
            ))}
          </Notice>
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <ErrorLine error={publish.error} onRetry={submit} />
      </div>
      <div className={s.actions}>
        <Button variant="secondary" disabled={publish.pending} onClick={onCancel}>
          Annuler
        </Button>
        <Button loading={publish.pending} onClick={submit}>
          Publier
        </Button>
      </div>
    </section>
  );
}
