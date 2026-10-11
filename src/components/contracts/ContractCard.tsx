"use client";

import { useRef, useState } from "react";
import { useApiMutation } from "@/client/hooks";
import { cancelUpload, dismissUpload, retryUpload, startUpload, type UploadJob } from "@/client/uploads";
import { appStyles as s } from "@/components/app/AppShell";
import { ConfirmDialog, ErrorLine } from "@/components/auth/parts";
import { Button, Notice } from "@/components/ui";
import type { ContractView, DocumentView, FieldView } from "@/server/contracts/service";
import styles from "./contracts.module.css";

const FORMATS = /\.(jpe?g|gif|pdf)$/i;
const BAD_FORMAT = "Format non accepté. Formats possibles : jpeg, jpg, gif, pdf.";

const frDate = (value: string) => new Date(value).toLocaleDateString("fr-FR");

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

export interface ContractCardProps {
  contract: ContractView;
  consentText: string;
  primaryFirstName: string;
  limits: { maxDocumentMb: number; maxDocuments: number };
  uploads: UploadJob[];
  /** Le serveur a répondu avec le contrat à jour. */
  onChanged: (contract: ContractView) => void;
}

/** Carte d'un contrat : état, consentement au challenge (US-36), détails (US-33), documents (US-34, US-35). */
export function ContractCard({ contract, consentText, primaryFirstName, limits, uploads, onChanged }: ContractCardProps) {
  const [open, setOpen] = useState(false);
  const [confirmingConsent, setConfirmingConsent] = useState(false);
  const consent = useApiMutation();

  async function toggleConsent(accepted: boolean) {
    const result = await consent.run<ContractView>(`/api/contracts/${contract.id}/consent`, {
      method: "POST",
      body: contract.consent.active ? { active: false } : { active: true, accepted },
    });
    if (result) {
      setConfirmingConsent(false);
      onChanged(result);
    }
  }

  const status = contract.filled ? `Renseigné — ${contract.documents.length} document(s)` : "Non renseigné";
  const auditLine = contract.consent.at
    ? `${contract.consent.active ? "Activé" : "Désactivé"} par ${contract.consent.byFirstName ?? "un profil supprimé"} le ${frDate(contract.consent.at)}`
    : null;

  return (
    <article className={styles.card}>
      <div className={styles.head}>
        <div>
          <div className={styles.name}>{contract.name}</div>
          <span className={`${styles.state} ${contract.filled ? styles.stateOn : ""}`}>{status}</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={contract.consent.active}
          aria-label={`Consentement au challenge du contrat ${contract.name}`}
          className={styles.switch}
          disabled={consent.pending}
          onClick={() => (contract.consent.active ? toggleConsent(false) : setConfirmingConsent(true))}
        >
          <span className={styles.knob} />
        </button>
      </div>
      <div className={styles.consentLine}>
        Consentement au challenge par MAAQ : <b>{consent.pending ? "Enregistrement…" : contract.consent.active ? "Activé" : "Désactivé"}</b>
      </div>
      {auditLine && <div className={styles.audit}>{auditLine}</div>}
      {!confirmingConsent && <ErrorLine error={consent.error} onRetry={() => toggleConsent(false)} />}

      <button type="button" className={styles.openButton} aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Masquer les détails ‹" : "Détails et documents ›"}
      </button>

      {open && <Details contract={contract} primaryFirstName={primaryFirstName} limits={limits} uploads={uploads} onChanged={onChanged} />}

      {confirmingConsent && (
        <ConfirmDialog
          title="Consentement au challenge"
          text={consentText}
          confirmLabel="J'accepte"
          confirming={consent.pending}
          onConfirm={() => toggleConsent(true)}
          onCancel={() => {
            consent.reset();
            setConfirmingConsent(false);
          }}
        >
          <ErrorLine error={consent.error} onRetry={() => toggleConsent(true)} />
        </ConfirmDialog>
      )}
    </article>
  );
}

function Details({ contract, primaryFirstName, limits, uploads, onChanged }: Omit<ContractCardProps, "consentText">) {
  // Le message de succès vit ici : le formulaire est recréé dès que le contrat enregistré change.
  const [saved, setSaved] = useState(false);
  return (
    <div className={styles.details}>
      {contract.fields.length === 0 ? (
        <p className={styles.hint}>Aucun champ n&apos;a encore été défini par MAAQ pour ce contrat.</p>
      ) : (
        // Le formulaire repart des valeurs enregistrées quand un autre profil les modifie.
        <DetailsForm
          key={contract.modified?.at ?? "vide"}
          contract={contract}
          onChanged={onChanged}
          onSaved={() => setSaved(true)}
          onEdit={() => setSaved(false)}
        />
      )}
      {saved && <Notice tone="success">✓ Contrat mis à jour</Notice>}
      {contract.modified && (
        <div className={styles.audit}>
          Modifié par {contract.modified.byFirstName ?? "un profil supprimé"} le {frDate(contract.modified.at)}
        </div>
      )}
      <Documents contract={contract} primaryFirstName={primaryFirstName} limits={limits} uploads={uploads} onChanged={onChanged} />
      <ClearButton contract={contract} primaryFirstName={primaryFirstName} onChanged={onChanged} />
    </div>
  );
}

function DetailsForm({
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

const PILL: Record<DocumentView["status"], { label: string; tone: string }> = {
  pending: { label: "Classement en cours", tone: styles.pillPending },
  available: { label: "Document disponible", tone: styles.pillOk },
  failed: { label: "Classement impossible", tone: styles.pillFailed },
};

function Documents({ contract, primaryFirstName, limits, uploads, onChanged }: Omit<ContractCardProps, "consentText">) {
  const [choosing, setChoosing] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [removing, setRemoving] = useState<DocumentView | null>(null);
  const photo = useRef<HTMLInputElement>(null);
  const file = useRef<HTMLInputElement>(null);
  const remove = useApiMutation();
  const retry = useApiMutation();
  const mine = uploads.filter((u) => u.contractId === contract.id);
  const reachedMax = contract.documents.length + mine.filter((u) => u.state !== "done" && u.state !== "rejected").length >= limits.maxDocuments;

  function pick(list: FileList | null) {
    setChoosing(false);
    const chosen = list?.[0];
    if (photo.current) photo.current.value = "";
    if (file.current) file.current.value = "";
    if (!chosen) return;
    // Les mêmes contrôles existent côté serveur (US-34 RT3) ; ici, ils évitent un envoi inutile.
    if (!FORMATS.test(chosen.name)) return setRefused(BAD_FORMAT);
    if (chosen.size > limits.maxDocumentMb * 1_048_576) return setRefused(`Ce document dépasse ${limits.maxDocumentMb} Mo.`);
    if (reachedMax) return setRefused(`Ce contrat a atteint le nombre maximum de documents (${limits.maxDocuments}).`);
    setRefused(null);
    startUpload({ contractId: contract.id, contractName: contract.name, file: chosen });
  }

  async function confirmRemove() {
    if (!removing) return;
    const result = await remove.run<ContractView>(`/api/contracts/documents/${removing.id}`, { method: "DELETE" });
    if (result) {
      setRemoving(null);
      onChanged(result);
    }
  }

  async function retryClassification(id: string) {
    const result = await retry.run<ContractView>(`/api/contracts/documents/${id}/retry`, { method: "POST" });
    if (result) onChanged(result);
  }

  return (
    <div className={styles.docs}>
      <div className={styles.label}>Documents scannés</div>
      {contract.documents.length === 0 && mine.length === 0 && <p className={styles.hint}>Aucun document pour le moment.</p>}
      {contract.documents.map((doc) => (
        <div key={doc.id} className={styles.doc}>
          <div className={styles.docTop}>
            <span className={styles.docName}>{doc.fileName}</span>
            <span className={`${styles.pill} ${PILL[doc.status].tone}`}>{PILL[doc.status].label}</span>
          </div>
          <div className={styles.docMeta}>
            Ajouté le {frDate(doc.addedAt)} par {doc.addedByFirstName ?? "un profil supprimé"}
          </div>
          <div className={styles.docActions}>
            <a className={s.smallButton} href={`/api/contracts/documents/${doc.id}`} target="_blank" rel="noreferrer">
              Aperçu
            </a>
            {doc.status === "failed" && (
              <button type="button" className={s.smallButton} disabled={retry.pending} onClick={() => retryClassification(doc.id)}>
                Réessayer
              </button>
            )}
            <button type="button" className={`${s.smallButton} ${s.danger}`} aria-label={`Retirer le document ${doc.fileName}`} onClick={() => setRemoving(doc)}>
              Retirer
            </button>
          </div>
        </div>
      ))}
      <ErrorLine error={retry.error} />

      {mine.map((job) => (
        <UploadRow key={job.id} job={job} />
      ))}

      {refused && (
        <div className={styles.error} role="alert">
          {refused}
        </div>
      )}
      {choosing ? (
        <div className={styles.choices}>
          <Button variant="secondary" onClick={() => photo.current?.click()}>
            Prendre une photo
          </Button>
          <Button variant="secondary" onClick={() => file.current?.click()}>
            Choisir un fichier
          </Button>
        </div>
      ) : (
        <Button variant="secondary" onClick={() => setChoosing(true)}>
          + Ajouter une copie scannée
        </Button>
      )}
      <input ref={photo} type="file" accept="image/*" capture="environment" hidden onChange={(e) => pick(e.target.files)} />
      <input ref={file} type="file" accept=".jpg,.jpeg,.gif,.pdf,image/jpeg,image/gif,application/pdf" hidden onChange={(e) => pick(e.target.files)} />
      <div className={styles.note}>JPEG, JPG, GIF ou PDF — {limits.maxDocumentMb} Mo max par fichier</div>

      {removing && (
        <ConfirmDialog
          title="Retirer ce document du contrat ?"
          text={`Il restera dans le Google Drive de ${primaryFirstName}.`}
          confirmLabel="Retirer"
          confirming={remove.pending}
          onConfirm={confirmRemove}
          onCancel={() => {
            remove.reset();
            setRemoving(null);
          }}
        >
          <ErrorLine error={remove.error} onRetry={confirmRemove} />
        </ConfirmDialog>
      )}
    </div>
  );
}

/** Envoi en cours (barre de progression, « Annuler »), ou son échec avec « Réessayer » (US-34 RF7 à RF9). */
function UploadRow({ job }: { job: UploadJob }) {
  if (job.state === "done") return null;
  if (job.state === "uploading") {
    return (
      <div className={styles.uploading}>
        <div className={styles.docName}>{job.fileName}</div>
        <div className={styles.uploadRow}>
          <div className={styles.progress} role="progressbar" aria-valuenow={Math.round(job.progress * 100)} aria-valuemin={0} aria-valuemax={100}>
            <div className={styles.progressBar} style={{ width: `${Math.round(job.progress * 100)}%` }} />
          </div>
          <button type="button" className={s.smallButton} onClick={() => cancelUpload(job.id)}>
            Annuler
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className={styles.uploading}>
      <div className={styles.docName}>{job.fileName}</div>
      <div className={styles.error} role="alert">
        {job.message}
      </div>
      <div className={styles.docActions}>
        {job.state !== "rejected" && (
          <button type="button" className={s.smallButton} onClick={() => retryUpload(job.id)}>
            Réessayer
          </button>
        )}
        <button type="button" className={`${s.smallButton} ${s.danger}`} onClick={() => dismissUpload(job.id)}>
          {job.state === "rejected" ? "Fermer" : "Abandonner"}
        </button>
      </div>
    </div>
  );
}

function ClearButton({ contract, primaryFirstName, onChanged }: { contract: ContractView; primaryFirstName: string; onChanged: (contract: ContractView) => void }) {
  const [confirming, setConfirming] = useState(false);
  const clear = useApiMutation();

  async function confirm() {
    const result = await clear.run<ContractView>(`/api/contracts/${contract.id}`, { method: "DELETE" });
    if (result) {
      setConfirming(false);
      onChanged(result);
    }
  }

  return (
    <>
      <button type="button" className={styles.danger} onClick={() => setConfirming(true)}>
        Supprimer les détails et documents
      </button>
      {confirming && (
        <ConfirmDialog
          title="Supprimer tous les détails et documents de ce contrat ?"
          text={`Les documents resteront dans le Google Drive de ${primaryFirstName}.`}
          confirmLabel="Supprimer"
          confirming={clear.pending}
          onConfirm={confirm}
          onCancel={() => {
            clear.reset();
            setConfirming(false);
          }}
        >
          <ErrorLine error={clear.error} onRetry={confirm} />
        </ConfirmDialog>
      )}
    </>
  );
}
