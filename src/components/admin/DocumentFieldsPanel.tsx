"use client";

import Link from "next/link";
import { useState } from "react";
import { ApiError, apiRequest, newIdempotencyKey } from "@/client/api";
import { adminStyles as s } from "@/components/admin/AdminShell";
import { ErrorLine } from "@/components/auth/parts";
import { Button, Notice } from "@/components/ui";

export interface DocumentFieldData {
  id: string;
  name: string;
  help: string | null;
  required: boolean;
  used: number;
}

export interface DocumentFieldsData {
  category: string;
  archived: boolean;
  fields: DocumentFieldData[];
}

const MAX_FIELDS = 10;

const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/**
 * « Documents attendus » d'une catégorie (US-122, US-123) : 1 à 10 champs, chacun avec son nom, son aide, son caractère obligatoire et sa place. Toute modification s'applique
 * aussitôt à toutes les familles ; retirer un champ demande une confirmation qui dit combien de documents seront supprimés.
 */
export function DocumentFieldsPanel({ categoryId, initial }: { categoryId: string; initial: DocumentFieldsData }) {
  const [data, setData] = useState(initial);
  const [saved, setSaved] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<{ id: string | null; message: string } | null>(null);
  const [draft, setDraft] = useState<{ name: string; help: string; required: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError>();
  const base = `/api/admin/contracts/${categoryId}/document-fields`;

  async function run(path: string, method: "POST" | "PATCH" | "DELETE", body: unknown, fieldId: string | null): Promise<boolean> {
    setSaved(false);
    setFieldError(null);
    setError(undefined);
    setPending(true);
    try {
      const result = await apiRequest<DocumentFieldsData>(path, { method, body, idempotencyKey: newIdempotencyKey() });
      setData({ category: result.category, archived: result.archived, fields: result.fields });
      setSaved(true);
      return true;
    } catch (err) {
      const apiError = err instanceof ApiError ? err : new ApiError("server", String(err));
      // Un refus de règle (« au moins un document obligatoire », « nom déjà pris ») s'affiche sous le champ concerné.
      const code = apiError.body?.code;
      if (apiError.kind === "rejected" && ["rule_refused", "duplicate_name", "too_many_fields", "invalid_name", "invalid_help"].includes(String(code))) setFieldError({ id: fieldId, message: apiError.message });
      else setError(apiError);
      return false;
    } finally {
      setPending(false);
    }
  }

  const required = data.fields.filter((f) => f.required).length;
  const full = data.fields.length >= MAX_FIELDS;
  const locked = data.archived;

  return (
    <section className={s.panel} style={{ maxWidth: 820, marginBottom: 18 }}>
      <div className={s.panelTitle}>Documents attendus</div>
      <p className={`${s.muted} ${s.small}`} style={{ marginTop: 0 }}>
        Les champs valent pour tous les contrats de la catégorie, de base comme complémentaires. Toute modification s&apos;applique immédiatement à toutes les familles.
      </p>
      {locked && <Notice tone="info">Cette catégorie est archivée : ses champs ne se modifient plus.</Notice>}
      <div className={`${s.small} ${s.muted}`} style={{ marginBottom: 10 }}>
        {data.fields.length === 0 ? "Aucun champ" : `${plural(data.fields.length, "champ", "champs")} · ${plural(required, "obligatoire", "obligatoires")}`}
      </div>

      <ul className={s.list} style={{ marginBottom: 12 }}>
        {data.fields.map((field, index) => (
          <li key={field.id} className={s.listItem}>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <label className={s.label} htmlFor={`name-${field.id}`}>
                Nom du champ
              </label>
              <input
                id={`name-${field.id}`}
                className={s.input}
                maxLength={80}
                defaultValue={field.name}
                disabled={locked || pending}
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (next !== field.name) void run(`${base}/${field.id}`, "PATCH", { name: next }, field.id).then((ok) => !ok && (e.target.value = field.name));
                }}
              />
              <label className={s.label} htmlFor={`help-${field.id}`}>
                Aide pour la famille (facultative)
              </label>
              <input
                id={`help-${field.id}`}
                className={s.input}
                maxLength={200}
                defaultValue={field.help ?? ""}
                disabled={locked || pending}
                onBlur={(e) => {
                  const next = e.target.value.trim();
                  if (next !== (field.help ?? "")) void run(`${base}/${field.id}`, "PATCH", { help: next }, field.id);
                }}
              />
              <div className={s.row} style={{ justifyContent: "space-between" }}>
                <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={field.required}
                    disabled={locked || pending}
                    onChange={(e) => void run(`${base}/${field.id}`, "PATCH", { required: e.target.checked }, field.id)}
                  />
                  Obligatoire
                </label>
                <div className={s.row}>
                  <span className={`${s.muted} ${s.small}`}>Ordre {index + 1}</span>
                  <button className={s.linkButton} aria-label={`Monter ${field.name}`} disabled={locked || index === 0 || pending} onClick={() => void run(`${base}/${field.id}`, "PATCH", { move: "up" }, field.id)}>
                    ↑
                  </button>
                  <button
                    className={s.linkButton}
                    aria-label={`Descendre ${field.name}`}
                    disabled={locked || index === data.fields.length - 1 || pending}
                    onClick={() => void run(`${base}/${field.id}`, "PATCH", { move: "down" }, field.id)}
                  >
                    ↓
                  </button>
                  <button className={`${s.linkButton} ${s.dangerLink}`} disabled={locked || pending} onClick={() => setRemoving(field.id)}>
                    Retirer ce champ
                  </button>
                </div>
              </div>
              {fieldError?.id === field.id && (
                <div role="alert" style={{ color: "var(--error)", fontSize: 12 }}>
                  {fieldError.message}
                </div>
              )}
              {removing === field.id && (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  <Notice tone="warning">
                    Retirer « {field.name} » ?{" "}
                    {field.used > 0 ? `Un document y est déposé dans ${plural(field.used, "contrat", "contrats")} : ces documents seront supprimés.` : "Aucun document n'y est déposé."}
                  </Notice>
                  <div className={s.row}>
                    <Button variant="secondary" onClick={() => setRemoving(null)}>
                      Annuler
                    </Button>
                    <Button
                      variant="danger"
                      loading={pending}
                      onClick={async () => {
                        if (await run(`${base}/${field.id}`, "DELETE", undefined, field.id)) setRemoving(null);
                      }}
                    >
                      {field.used > 0 ? "Retirer et supprimer les documents" : "Retirer"}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </li>
        ))}
        {data.fields.length === 0 && (
          <li className={s.empty}>Aucun champ : les familles ne peuvent pas déposer de documents ni transmettre leurs contrats de cette catégorie.</li>
        )}
      </ul>

      {!locked && draft === null && (
        <Button variant="secondary" disabled={full || pending} onClick={() => setDraft({ name: "", help: "", required: true })}>
          + Ajouter un champ
        </Button>
      )}
      {full && <div className={`${s.small} ${s.muted}`}>10 champs au plus par catégorie.</div>}
      {draft && (
        <form
          style={{ display: "flex", flexDirection: "column", gap: 8 }}
          onSubmit={async (e) => {
            e.preventDefault();
            if (await run(base, "POST", { name: draft.name, help: draft.help || null, required: draft.required }, null)) setDraft(null);
          }}
        >
          <label className={s.label} htmlFor="new-field-name">
            Nom du champ
          </label>
          <input id="new-field-name" className={s.input} maxLength={80} autoFocus value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Ex. Conditions particulières" />
          <label className={s.label} htmlFor="new-field-help">
            Aide pour la famille (facultative)
          </label>
          <input id="new-field-help" className={s.input} maxLength={200} value={draft.help} onChange={(e) => setDraft({ ...draft, help: e.target.value })} placeholder="Ex. La page qui indique vos garanties et votre franchise" />
          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
            <input type="checkbox" checked={draft.required} onChange={(e) => setDraft({ ...draft, required: e.target.checked })} />
            Obligatoire
          </label>
          {fieldError?.id === null && (
            <div role="alert" style={{ color: "var(--error)", fontSize: 12 }}>
              {fieldError.message}
            </div>
          )}
          <div className={s.row}>
            <Button type="button" variant="secondary" onClick={() => setDraft(null)}>
              Annuler
            </Button>
            <Button type="submit" loading={pending} disabled={!draft.name.trim()}>
              Ajouter le champ
            </Button>
          </div>
        </form>
      )}

      <ErrorLine error={error} />
      {saved && !error && <Notice tone="success">✓ Modification appliquée à toutes les familles</Notice>}
      <p className={`${s.muted} ${s.small}`} style={{ marginBottom: 0 }}>
        Formats et taille : ceux des réglages (jpeg, jpg, gif, pdf). Un champ reçoit un PDF ou jusqu&apos;à 10 photos. Partenaire du challenge et limites : <Link href="/admin/parametres">Réglages ›</Link>
      </p>
    </section>
  );
}
