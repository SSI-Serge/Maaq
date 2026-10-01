"use client";

import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { appStyles as s } from "@/components/app/AppShell";
import { ErrorLine } from "@/components/auth/parts";
import { Button, ButtonLink, Loading, Notice, Screen } from "@/components/ui";
import ui from "@/components/ui/ui.module.css";

type DataType = "text" | "phone" | "postal_code" | "past_date" | "email";

interface InfoField {
  id: string;
  label: string;
  dataType: DataType;
  required: boolean;
  maxItems: number;
  values: string[];
  prefill: { values: string[]; sourceAgent: string } | null;
}

interface AgentInfoForm {
  agent: { id: string; name: string };
  profile: { id: string; firstName: string; isSelf: boolean };
  fields: InfoField[];
  complete: boolean;
}

const INPUT_TYPE: Record<DataType, string> = { text: "text", phone: "tel", postal_code: "text", past_date: "date", email: "email" };
const PLACEHOLDER: Record<DataType, string> = { text: "", phone: "06 12 34 56 78", postal_code: "75011", past_date: "", email: "vous@exemple.fr" };

/** Contrôle à la sortie du champ (US-10 RF4) ; le serveur refait les mêmes contrôles. */
function check(type: DataType, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  if (type === "phone" && !/^(\+[1-9]\d{6,14}|0[1-9]\d{8})$/.test(v.replace(/[\s.\-()]/g, ""))) return "Numéro de téléphone invalide";
  if (type === "postal_code" && !/^\d{5}$/.test(v)) return "Format invalide — 5 chiffres";
  if (type === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) return "Adresse email invalide";
  if (type === "past_date" && !(new Date(v) < new Date())) return "La date doit être passée";
  return null;
}

/** « Informations nécessaires à [agent] » (US-10 RF12, US-11 RF2), maquette Informations-Agent. */
export default function AgentInformationPage() {
  return (
    <Suspense>
      <AgentInformation />
    </Suspense>
  );
}

function AgentInformation() {
  const { agentId } = useParams<{ agentId: string }>();
  const profileId = useSearchParams().get("profil");
  const path = `/api/profile/agents/${agentId}${profileId ? `?profil=${profileId}` : ""}`;
  const query = useApiQuery<AgentInfoForm>(path);

  if (query.loading && !query.data) {
    return (
      <Screen>
        <Loading slow={query.slow} />
      </Screen>
    );
  }
  if (!query.data) {
    return (
      <Screen>
        <ErrorLine error={query.error} onRetry={query.reload} />
      </Screen>
    );
  }
  return <InfoForm path={path} form={query.data} />;
}

function InfoForm({ path, form }: { path: string; form: AgentInfoForm }) {
  const router = useRouter();
  const mutation = useApiMutation();
  // Valeurs de départ : celles enregistrées, sinon celles reprises d'un autre agent (à confirmer).
  const [values, setValues] = useState<Record<string, string[]>>(() =>
    Object.fromEntries(
      form.fields.map((f) => [f.id, f.values.length ? f.values : f.prefill?.values.length ? f.prefill.values : [""]]),
    ),
  );
  const [blurErrors, setBlurErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);
  const serverErrors = mutation.error?.body?.code === "invalid_info" ? (mutation.error.body.details as Record<string, string>) : {};
  const errorOf = (id: string) => blurErrors[id] || serverErrors[id];

  const requiredMissing = form.fields.some((f) => f.required && !(values[f.id] ?? []).some((v) => v.trim()));
  const hasFormatError = Object.values(blurErrors).some(Boolean);

  function setItem(field: InfoField, index: number, value: string) {
    const next = [...(values[field.id] ?? [""])];
    next[index] = value;
    setValues({ ...values, [field.id]: next });
    if (blurErrors[field.id]) setBlurErrors({ ...blurErrors, [field.id]: "" });
  }

  function validate(field: InfoField) {
    const problem = (values[field.id] ?? []).map((v) => check(field.dataType, v)).find(Boolean);
    setBlurErrors({ ...blurErrors, [field.id]: problem ?? "" });
  }

  async function submit() {
    const payload = Object.fromEntries(Object.entries(values).map(([id, list]) => [id, list.map((v) => v.trim()).filter(Boolean)]));
    const result = await mutation.run<AgentInfoForm>(path, { method: "PUT", body: { values: payload } });
    if (result) setDone(true);
  }

  const back = "/reglages";

  if (done) {
    return (
      <Screen>
        <div className={s.form} style={{ marginTop: 24 }}>
          <Notice tone="success">✓ Informations mises à jour</Notice>
          <p className={s.text}>
            {form.agent.name} peut maintenant traiter {form.profile.isSelf ? "vos demandes" : `les demandes de ${form.profile.firstName}`}.
          </p>
          <ButtonLink href={back} block>
            Continuer
          </ButtonLink>
        </div>
      </Screen>
    );
  }

  return (
    <Screen>
      <div className={s.row} style={{ alignItems: "flex-start" }}>
        <h1 style={{ fontSize: 24, lineHeight: 1.25 }}>Informations nécessaires à {form.agent.name}</h1>
        <button className={s.smallButton} aria-label="Fermer" onClick={() => router.push(back)} style={{ fontSize: 20 }}>
          ×
        </button>
      </div>
      <p className={s.muted} style={{ margin: "8px 0 18px" }}>
        {form.profile.isSelf ? "" : `Informations de ${form.profile.firstName}. `}
        Propres à {form.agent.name}. Une valeur déjà saisie pour un autre agent peut être reprise automatiquement — vous pouvez toujours la modifier.
      </p>

      <div className={s.form}>
        {form.fields.map((field) => {
          const items = values[field.id] ?? [""];
          const isList = field.maxItems > 1;
          return (
            <div key={field.id} className={ui.field}>
              <label className={ui.label} htmlFor={`f-${field.id}-0`}>
                {field.label}
                {field.required ? " *" : ""}
              </label>
              {items.map((item, index) => (
                <div key={index} style={{ display: "flex", gap: 6 }}>
                  <input
                    id={`f-${field.id}-${index}`}
                    className={`${ui.input} ${errorOf(field.id) ? ui.inputError : ""}`}
                    type={INPUT_TYPE[field.dataType]}
                    inputMode={field.dataType === "postal_code" ? "numeric" : undefined}
                    placeholder={PLACEHOLDER[field.dataType]}
                    maxLength={500}
                    value={item}
                    onChange={(e) => setItem(field, index, e.target.value)}
                    onBlur={() => validate(field)}
                  />
                  {isList && items.length > 1 && (
                    <button
                      type="button"
                      className={s.smallButton}
                      aria-label="Retirer cet élément"
                      onClick={() => setValues({ ...values, [field.id]: items.filter((_, i) => i !== index) })}
                    >
                      ×
                    </button>
                  )}
                </div>
              ))}
              {isList &&
                (items.length < field.maxItems ? (
                  <button type="button" className={s.smallButton} style={{ alignSelf: "flex-start" }} onClick={() => setValues({ ...values, [field.id]: [...items, ""] })}>
                    + Ajouter un élément
                  </button>
                ) : (
                  <span className={s.muted}>Maximum {field.maxItems} éléments.</span>
                ))}
              {!field.values.length && field.prefill && (
                <span className={s.muted}>Valeur reprise de {field.prefill.sourceAgent} — à confirmer ou modifier.</span>
              )}
              {errorOf(field.id) && <span className={ui.fieldError}>{errorOf(field.id)}</span>}
            </div>
          );
        })}
        {mutation.error?.body?.code !== "invalid_info" && <ErrorLine error={mutation.error} onRetry={submit} />}
        <Button block loading={mutation.pending} disabled={requiredMissing || hasFormatError} onClick={submit}>
          Enregistrer
        </Button>
        <button type="button" className={s.smallButton} style={{ alignSelf: "center" }} onClick={() => router.push(back)}>
          Fermer sans enregistrer
        </button>
        <p className={s.muted} style={{ textAlign: "center" }}>
          Ces informations sont chiffrées et ne servent qu&apos;à {form.agent.name}.
        </p>
      </div>
    </Screen>
  );
}
