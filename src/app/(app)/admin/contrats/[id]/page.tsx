"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { BackLink, PageHead, adminStyles as s } from "@/components/admin/AdminShell";
import { ErrorLine } from "@/components/auth/parts";
import { Button, Loading } from "@/components/ui";

type FieldType = "text" | "date" | "amount" | "choice";

interface ContractFields {
  name: string;
  fields: { id: string; label: string; type: FieldType; required: boolean; options: string[] }[];
}

const TYPE_LABEL: Record<FieldType, string> = { text: "Texte", date: "Date", amount: "Montant", choice: "Liste de choix" };

/** Champs de détail d'un contrat proposés aux clients (US-48 RF10). */
export default function ContractFieldsPage() {
  const { id } = useParams<{ id: string }>();
  const query = useApiQuery<ContractFields>(`/api/admin/contracts/${id}/fields`);
  const [updated, setUpdated] = useState<ContractFields | null>(null);
  const data = updated ?? query.data;
  const mutation = useApiMutation();

  const [label, setLabel] = useState("");
  const [type, setType] = useState<FieldType>("text");
  const [required, setRequired] = useState(false);
  const [options, setOptions] = useState("");

  async function add(event: React.FormEvent) {
    event.preventDefault();
    const result = await mutation.run<ContractFields>(`/api/admin/contracts/${id}/fields`, {
      method: "POST",
      body: { label, type, required, options: type === "choice" ? options.split("\n") : [] },
    });
    if (result) {
      setUpdated(result);
      setLabel("");
      setOptions("");
      setRequired(false);
    }
  }

  async function remove(fieldId: string) {
    const result = await mutation.run<ContractFields>(`/api/admin/contracts/${id}/fields/${fieldId}`, { method: "DELETE" });
    if (result) setUpdated(result);
  }

  return (
    <>
      <BackLink href="/admin/contrats">Contrats obligatoires</BackLink>
      {query.loading && !data && <Loading slow={query.slow} />}
      <ErrorLine error={query.error} onRetry={query.reload} />
      {data && (
        <>
          <PageHead
            title={`Champs — ${data.name}`}
            lead="Ajouter ou retirer un champ s'applique immédiatement aux fiches de tous les clients pour ce contrat."
          />
          <table className={s.table} style={{ maxWidth: 820, marginBottom: 18 }}>
            <thead>
              <tr>
                <th>Libellé</th>
                <th>Type</th>
                <th>Obligatoire</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.fields.map((f) => (
                <tr key={f.id}>
                  <td>
                    {f.label}
                    {f.options.length > 0 && <div className={`${s.small} ${s.muted}`}>{f.options.join(" · ")}</div>}
                  </td>
                  <td>{TYPE_LABEL[f.type]}</td>
                  <td>{f.required ? "Oui" : "Non"}</td>
                  <td className={s.cellRight}>
                    <button className={`${s.linkButton} ${s.dangerLink}`} disabled={mutation.pending} onClick={() => remove(f.id)}>
                      Retirer
                    </button>
                  </td>
                </tr>
              ))}
              {data.fields.length === 0 && (
                <tr>
                  <td colSpan={4} className={s.empty}>
                    Aucun champ pour ce contrat.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <form className={s.panel} style={{ maxWidth: 820 }} onSubmit={add}>
            <div className={s.panelTitle}>Ajouter un champ</div>
            <div className={s.row}>
              <input
                className={s.input}
                style={{ maxWidth: 300 }}
                aria-label="Libellé du champ"
                placeholder="Libellé (ex. Numéro de police)"
                maxLength={120}
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
              <select className={s.select} style={{ width: 170 }} aria-label="Type du champ" value={type} onChange={(e) => setType(e.target.value as FieldType)}>
                {Object.entries(TYPE_LABEL).map(([code, text]) => (
                  <option key={code} value={code}>
                    {text}
                  </option>
                ))}
              </select>
              <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
                <input type="checkbox" checked={required} onChange={(e) => setRequired(e.target.checked)} />
                Champ obligatoire
              </label>
            </div>
            {type === "choice" && (
              <div style={{ marginTop: 12, maxWidth: 420 }}>
                <label className={s.label} htmlFor="options">
                  Choix proposés (un par ligne, au moins deux)
                </label>
                <textarea
                  id="options"
                  className={s.textarea}
                  value={options}
                  onChange={(e) => setOptions(e.target.value)}
                  placeholder={"Mensuel\nTrimestriel\nAnnuel"}
                />
              </div>
            )}
            <div style={{ marginTop: 12 }}>
              <ErrorLine error={mutation.error} />
            </div>
            <div className={s.actions} style={{ justifyContent: "flex-start" }}>
              <Button type="submit" loading={mutation.pending} disabled={!label.trim()}>
                Ajouter le champ
              </Button>
            </div>
          </form>
        </>
      )}
    </>
  );
}
