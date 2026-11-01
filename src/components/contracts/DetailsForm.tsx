"use client";

import { useState } from "react";
import { useApiMutation } from "@/client/hooks";
import { appStyles as s } from "@/components/app/AppShell";
import { ErrorLine } from "@/components/auth/parts";
import { Button } from "@/components/ui";
import type { ContractView, FieldView } from "@/server/contracts/service";
import styles from "./contracts.module.css";

/** « 2026-12-31 » → « 31/12/2026 » (saisie des dates en JJ/MM/AAAA, comme sur la maquette). */
function isoToFr(iso: string | null): string {
  const match = iso ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  return match ? `${match[3]}/${match[2]}/${match[1]}` : "";
}

function frToIso(text: string): string {
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text.trim());
  return match ? `${match[3]}-${match[2].padStart(2, "0")}-${match[1].padStart(2, "0")}` : text.trim();
}

function displayValue(field: FieldView): string {
  if (field.value === null) return "";
  if (field.type === "date") return isoToFr(field.value);
  if (field.type === "amount") return field.value.replace(".", ",");
  return field.value;
}

/** Contrôle de format affiché à la sortie du champ (US-33 RF3). */
function checkField(field: FieldView, text: string): string | null {
  const value = text.trim();
  if (!value) return field.required ? "Ce champ est obligatoire" : null;
  if (field.type === "amount" && !/^\d{1,10}([.,]\d{1,2})?$/.test(value.replace(/[\s€]/g, ""))) return "Montant invalide";
  if (field.type === "date") {
    const iso = frToIso(value);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
    if (!date || date.toISOString().slice(0, 10) !== iso) return "Date invalide";
  }
  return null;
}

/** Détails texte d'un contrat (US-33) : champs définis par l'administrateur, contrôle de format à la sortie du champ. */
export function DetailsForm({
  contract,
  onChanged,
  onSaved,
  onEdit,
}: {
  contract: ContractView;
  onChanged: (contract: ContractView) => void;
  onSaved: () => void;
  onEdit: () => void;
}) {
  const initial = Object.fromEntries(contract.fields.map((f) => [f.id, displayValue(f)]));
  const [values, setValues] = useState<Record<string, string>>(initial);
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const save = useApiMutation();

  const serverErrors = save.error?.body?.code === "invalid_details" ? (save.error.body.details as Record<string, string>) : {};
  const errors = Object.fromEntries(contract.fields.map((f) => [f.id, touched[f.id] ? checkField(f, values[f.id]) : null]));
  const missingRequired = contract.fields.some((f) => f.required && !values[f.id].trim());
  const hasError = contract.fields.some((f) => checkField(f, values[f.id]) !== null);
  const dirty = contract.fields.some((f) => values[f.id] !== initial[f.id]);

  async function submit() {
    const body: Record<string, string> = {};
    for (const f of contract.fields) body[f.id] = f.type === "date" ? frToIso(values[f.id]) : values[f.id];
    const result = await save.run<ContractView>(`/api/contracts/${contract.id}`, { method: "PUT", body: { values: body } });
    if (result) {
      onSaved();
      onChanged(result);
    }
  }

  return (
    <form
      className={s.form}
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {contract.fields.map((field) => {
        const error = serverErrors[field.id] ?? errors[field.id];
        return (
          <div key={field.id} className={styles.field}>
            <label className={styles.label} htmlFor={`f-${field.id}`}>
              {field.label}
              {field.required && " *"}
            </label>
            {field.type === "choice" ? (
              <select
                id={`f-${field.id}`}
                className={styles.input}
                value={values[field.id]}
                onChange={(e) => {
                  setValues({ ...values, [field.id]: e.target.value });
                  onEdit();
                }}
              >
                <option value="">Choisir…</option>
                {field.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={`f-${field.id}`}
                className={`${styles.input} ${error ? styles.inputError : ""}`}
                type="text"
                inputMode={field.type === "amount" ? "decimal" : undefined}
                placeholder={field.type === "date" ? "JJ/MM/AAAA" : field.type === "amount" ? "0,00 €" : undefined}
                maxLength={field.type === "text" ? 500 : 40}
                value={values[field.id]}
                onChange={(e) => {
                  setValues({ ...values, [field.id]: e.target.value });
                  onEdit();
                  if (save.error) save.reset();
                }}
                onBlur={() => setTouched({ ...touched, [field.id]: true })}
              />
            )}
            {error && <span className={styles.error}>{error}</span>}
          </div>
        );
      })}
      {save.error?.body?.code !== "invalid_details" && <ErrorLine error={save.error} onRetry={submit} />}
      <Button type="submit" loading={save.pending} disabled={!dirty || missingRequired || hasError}>
        Enregistrer
      </Button>
    </form>
  );
}
