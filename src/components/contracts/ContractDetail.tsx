"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { cancelUpload, dismissUpload, onUploadDone, retryUpload, startUpload, useUploads, type UploadJob } from "@/client/uploads";
import { AppShell, appStyles as s } from "@/components/app/AppShell";
import { useSessionUser } from "@/components/auth/AuthGate";
import { ConfirmDialog, ErrorLine } from "@/components/auth/parts";
import { Button, Loading, Notice, RetryNotice } from "@/components/ui";
import type { ContractView, ContractsView, DocumentSlot } from "@/server/contracts/service";
import { ChannelSwitch, contractState, frDate, TONE_CLASS } from "./ContractParts";
import { TransmitArea } from "./TransmitArea";
import { DetailsForm } from "./DetailsForm";
import { DocumentMasking } from "./DocumentMasking";
import styles from "./contracts.module.css";

const FORMATS = /\.(jpe?g|gif|pdf)$/i;
const BAD_FORMAT = "Format non accepté. Formats possibles : jpeg, jpg, gif, pdf.";
const MAX_PHOTOS = 10;
const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;

/** Détail d'un contrat (maquette CT-Contrat-Detail) : nom, interrupteurs, détails texte, documents à transmettre, suppression. */
export function ContractDetail({ id }: { id: string }) {
  const user = useSessionUser();
  const router = useRouter();
  const allowed = user.role === "primary_user" || user.guestRank === "core";
  const query = useApiQuery<ContractsView>("/api/contracts?auto=1");
  const { reload } = query;
  const [override, setOverride] = useState<{ base: ContractsView | undefined; contract: ContractView | undefined }>({ base: undefined, contract: undefined });
  const uploads = useUploads();

  useEffect(() => {
    if (!allowed) router.replace("/accueil");
  }, [allowed, router]);
  useEffect(() => onUploadDone(() => reload()), [reload]);
  if (!allowed) return null;

  const view = query.data;
  const category = view?.categories.find((c) => c.contracts.some((x) => x.id === id));
  const loaded = category?.contracts.find((x) => x.id === id);
  const contract = override.base === view && override.contract?.id === id ? override.contract : loaded;
  const changed = (updated: ContractView) => setOverride({ base: view, contract: updated });

  return (
    <AppShell title={contract?.name ?? "Contrat"} subtitle={category ? `${category.name} · ${contract?.isBase ? "Contrat de base" : "Contrat complémentaire"}` : undefined} back={{ href: "/contrats", label: "Mes contrats" }}>
      {query.loading && !view && <Loading slow={query.slow} />}
      {query.error && !view && <RetryNotice message={query.error.message} onRetry={query.reload} />}
      {view && !contract && <Notice tone="info">Ce contrat n&apos;existe plus. <Link href="/contrats">Retour à mes contrats ›</Link></Notice>}
      {view && category && contract && (
        <Detail contract={contract} view={view} archived={category.archived} uploads={uploads} onChanged={changed} onDeleted={() => router.replace("/contrats")} />
      )}
    </AppShell>
  );
}

function Detail({ contract, view, archived, uploads, onChanged, onDeleted }: { contract: ContractView; view: ContractsView; archived: boolean; uploads: UploadJob[]; onChanged: (c: ContractView) => void; onDeleted: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(contract.name);
  const [savedDetails, setSavedDetails] = useState(false);
  const rename = useApiMutation();
  const state = contractState(contract, archived);
  const mine = uploads.filter((u) => u.contractId === contract.id);

  // Lecture et masquage des documents (US-136 RF1) : lancés dès qu'un document attend et que l'analyse est active ; tant qu'un masquage est en cours, on redemande l'état.
  const maskingNeeded = view.analysis.mode !== "off" && contract.analysis.enabled && !archived;
  const waiting = maskingNeeded ? contract.slots.filter((x) => x.document && !x.document.transmittedAt && x.document.masking.status === "pending").map((x) => x.document!.id) : [];
  const running = maskingNeeded && contract.slots.some((x) => x.document?.masking.status === "masking");
  const waitingKey = waiting.join(",");
  const attempted = useRef(new Set<string>());
  const refresh = useApiMutation();
  const { run: runRefresh } = refresh;
  useEffect(() => {
    if (!waitingKey || attempted.current.has(waitingKey)) return;
    attempted.current.add(waitingKey);
    void runRefresh<ContractView>(`/api/contracts/${contract.id}/process`, { method: "POST" }).then((result) => result && onChanged(result));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingKey, contract.id]);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void runRefresh<ContractView>(`/api/contracts/${contract.id}/process`, { method: "POST" }).then((result) => result && onChanged(result)), 6000);
    return () => clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, contract.id]);

  async function saveName(event: React.FormEvent) {
    event.preventDefault();
    const result = await rename.run<ContractView>(`/api/contracts/${contract.id}`, { method: "PATCH", body: { name } });
    if (result) {
      setRenaming(false);
      onChanged(result);
    }
  }

  return (
    <div className={styles.detail}>
      <div className={styles.nameLine}>
        {renaming ? (
          <form className={styles.addForm} onSubmit={saveName}>
            <label className={styles.label} htmlFor="contract-name">
              Nom du contrat
            </label>
            <input id="contract-name" className={styles.input} maxLength={60} autoFocus value={name} onChange={(e) => setName(e.target.value)} />
            <ErrorLine error={rename.error} />
            <div className={styles.choices}>
              <Button type="button" variant="secondary" onClick={() => { setRenaming(false); setName(contract.name); rename.reset(); }}>
                Annuler
              </Button>
              <Button type="submit" loading={rename.pending} disabled={!name.trim()}>
                Enregistrer
              </Button>
            </div>
          </form>
        ) : (
          <>
            <span className={`${styles.pill} ${TONE_CLASS[state.tone]}`}>{state.label}</span>
            {!archived && (
              <button type="button" className={s.smallButton} onClick={() => setRenaming(true)}>
                Renommer
              </button>
            )}
          </>
        )}
      </div>

      {archived && (
        <Notice tone="info">
          Catégorie archivée. Ce contrat, ses documents et ses rapports restent consultables, sans transmission possible.
        </Notice>
      )}

      {contract.reportAt && (
        <section className={styles.panel}>
          <div className={styles.label}>Rapport d&apos;analyse</div>
          <p className={styles.hint}>Rapport du {frDate(contract.reportAt)}. Son affichage arrive avec l&apos;étape suivante.</p>
        </section>
      )}

      <section className={styles.panel}>
        <ChannelSwitch contract={contract} channel="analysis" view={view} archived={archived} onChanged={onChanged} />
        <ChannelSwitch contract={contract} channel="challenge" view={view} archived={archived} onChanged={onChanged} />
      </section>

      <section className={styles.panel}>
        <div className={styles.label}>Détails du contrat</div>
        {contract.fields.length === 0 ? (
          <p className={styles.hint}>Aucun champ de détail n&apos;a encore été défini par MAAQ pour cette catégorie.</p>
        ) : archived ? (
          <dl className={styles.facts}>
            {contract.fields.map((f) => (
              <div key={f.id}>
                <dt>{f.label}</dt>
                <dd>{f.value ?? "—"}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <DetailsForm key={contract.modified?.at ?? "vide"} contract={contract} onChanged={onChanged} onSaved={() => setSavedDetails(true)} onEdit={() => setSavedDetails(false)} />
        )}
        {savedDetails && <Notice tone="success">✓ Contrat mis à jour</Notice>}
        {contract.modified && (
          <div className={styles.audit}>
            Modifié par {contract.modified.byFirstName ?? "un profil supprimé"} le {frDate(contract.modified.at)}
          </div>
        )}
      </section>

      <section className={styles.panel}>
        <div className={styles.label}>Documents à transmettre</div>
        {contract.slots.length === 0 ? (
          <p className={styles.hint}>Aucun document n&apos;est demandé pour cette catégorie.</p>
        ) : (
          contract.slots.map((slot) => <Slot key={slot.fieldId} slot={slot} contract={contract} view={view} archived={archived} jobs={mine.filter((j) => j.fieldId === slot.fieldId)} onChanged={onChanged} />)
        )}
        <p className={styles.hint}>Vos documents sont supprimés 48 h après leur transmission, ou au bout de 30 jours s&apos;ils ne sont pas transmis. Seul le rapport d&apos;analyse est conservé.</p>
        {contract.challenge.enabled && <p className={styles.hint}>Une copie est envoyée par email à notre partenaire pour le challenge.</p>}
        <TransmitArea contract={contract} view={view} archived={archived} onChanged={onChanged} />
        {contract.transmission && (
          <div className={styles.audit}>
            Historique : transmis par {contract.transmission.byFirstName ?? "un profil supprimé"} le {frDate(contract.transmission.at)} —{" "}
            {[contract.transmission.forAnalysis && "analyse", contract.transmission.forChallenge && "challenge"].filter(Boolean).join(", ")}.
          </div>
        )}
      </section>

      {!archived && <ClearButton contract={contract} onChanged={onChanged} />}
      <DeleteButton contract={contract} onDeleted={onDeleted} />
    </div>
  );
}

function Slot({ slot, contract, view, archived, jobs, onChanged }: { slot: DocumentSlot; contract: ContractView; view: ContractsView; archived: boolean; jobs: UploadJob[]; onChanged: (c: ContractView) => void }) {
  const [choosing, setChoosing] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [photos, setPhotos] = useState<File[]>([]);
  const [removing, setRemoving] = useState(false);
  const camera = useRef<HTMLInputElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const remove = useApiMutation();
  const doc = slot.document;
  const max = view.limits.maxDocumentMb;

  /** Mêmes contrôles que le serveur (US-126 RF3) : ils évitent un envoi inutile. */
  function check(files: File[]): string | null {
    if (files.some((f) => !FORMATS.test(f.name))) return BAD_FORMAT;
    const pdf = files.filter((f) => /\.pdf$/i.test(f.name));
    if (pdf.length > 0 && files.length > 1) return "Un champ reçoit un PDF, ou des photos : pas les deux.";
    if (files.length > MAX_PHOTOS) return "Un champ reçoit 10 photos au plus.";
    if (files.reduce((n, f) => n + f.size, 0) > max * 1_048_576) return `Ce document dépasse ${max} Mo.`;
    return null;
  }

  function send(files: File[]) {
    const problem = check(files);
    if (problem) return setRefused(problem);
    setRefused(null);
    setChoosing(false);
    setPhotos([]);
    startUpload({ contractId: contract.id, contractName: contract.name, fieldId: slot.fieldId, files });
  }

  function chosen(list: FileList | null, fromCamera: boolean) {
    const files = [...(list ?? [])];
    if (camera.current) camera.current.value = "";
    if (picker.current) picker.current.value = "";
    if (files.length === 0) return;
    if (fromCamera) {
      // Plusieurs photos forment un seul document : on les accumule avant l'envoi.
      const next = [...photos, ...files];
      if (next.length > MAX_PHOTOS) return setRefused("Un champ reçoit 10 photos au plus.");
      setRefused(null);
      return setPhotos(next);
    }
    send(files);
  }

  async function confirmRemove() {
    if (!doc) return;
    const result = await remove.run<ContractView>(`/api/contracts/documents/${doc.id}`, { method: "DELETE" });
    if (result) {
      setRemoving(false);
      onChanged(result);
    }
  }

  const editable = !archived && !(doc?.locked ?? false);
  const running = jobs.filter((j) => j.state === "uploading");
  return (
    <div className={styles.doc}>
      <div className={styles.docTop}>
        <span className={styles.docName}>
          {slot.name}
          {!slot.required && <span className={styles.optional}> · Facultatif</span>}
        </span>
      </div>
      {slot.help && <div className={styles.docMeta}>{slot.help}</div>}

      {doc && (
        <>
          <div className={styles.docName}>{doc.fileName}</div>
          <div className={styles.docMeta}>
            {plural(doc.pages, "page", "pages")} · déposé par {doc.uploadedByFirstName ?? "un profil supprimé"} le {frDate(doc.uploadedAt)}
            {doc.transmittedAt ? ` · transmis le ${frDate(doc.transmittedAt)}` : ""} · supprimé le {frDate(doc.expiresAt)}
          </div>
          <DocumentMasking doc={doc} contractId={contract.id} analysisActive={view.analysis.mode !== "off" && contract.analysis.enabled} />
          <div className={styles.docActions}>
            <a className={s.smallButton} href={`/api/contracts/documents/${doc.id}`} target="_blank" rel="noreferrer">
              Aperçu
            </a>
            {editable && (
              <>
                <button type="button" className={s.smallButton} onClick={() => setChoosing(true)}>
                  Remplacer
                </button>
                <button type="button" className={`${s.smallButton} ${s.danger}`} aria-label={`Retirer le document ${slot.name}`} onClick={() => setRemoving(true)}>
                  Retirer
                </button>
              </>
            )}
          </div>
        </>
      )}

      {running.map((job) => (
        <UploadRow key={job.id} job={job} />
      ))}
      {jobs.filter((j) => j.state !== "uploading" && j.state !== "done").map((job) => (
        <UploadRow key={job.id} job={job} />
      ))}

      {refused && (
        <div className={styles.error} role="alert">
          {refused}
        </div>
      )}
      {photos.length > 0 && (
        <div className={styles.choices}>
          <span className={styles.docMeta}>{plural(photos.length, "photo prête", "photos prêtes")}</span>
          <Button variant="secondary" onClick={() => camera.current?.click()} disabled={photos.length >= MAX_PHOTOS}>
            Ajouter une photo
          </Button>
          <Button onClick={() => send(photos)}>Envoyer</Button>
          <Button variant="secondary" onClick={() => setPhotos([])}>
            Annuler
          </Button>
        </div>
      )}
      {!archived && photos.length === 0 && (!doc || choosing) && running.length === 0 && (
        <div className={styles.choices}>
          <Button variant="secondary" onClick={() => camera.current?.click()}>
            Prendre une photo
          </Button>
          <Button variant="secondary" onClick={() => picker.current?.click()}>
            Choisir un fichier
          </Button>
          {choosing && doc && (
            <Button variant="secondary" onClick={() => setChoosing(false)}>
              Annuler
            </Button>
          )}
        </div>
      )}
      <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => chosen(e.target.files, true)} />
      <input ref={picker} type="file" multiple accept=".jpg,.jpeg,.gif,.pdf,image/jpeg,image/gif,application/pdf" hidden onChange={(e) => chosen(e.target.files, false)} />
      {!doc && !archived && <div className={styles.note}>Un PDF, ou jusqu&apos;à 10 photos qui forment un seul document. JPEG, JPG, GIF ou PDF, {max} Mo au plus.</div>}
      {doc?.locked && <div className={styles.note}>Document verrouillé jusqu&apos;à sa suppression.</div>}

      {removing && (
        <ConfirmDialog
          title="Retirer ce document ?"
          text={`« ${slot.name} » sera supprimé définitivement.`}
          confirmLabel="Retirer"
          confirming={remove.pending}
          onConfirm={confirmRemove}
          onCancel={() => {
            remove.reset();
            setRemoving(false);
          }}
        >
          <ErrorLine error={remove.error} onRetry={confirmRemove} />
        </ConfirmDialog>
      )}
    </div>
  );
}

/** Envoi en cours (barre de progression, « Annuler »), ou son échec avec « Réessayer » (US-126 RF9). */
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

function ClearButton({ contract, onChanged }: { contract: ContractView; onChanged: (c: ContractView) => void }) {
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
        Vider les détails et les documents
      </button>
      {confirming && (
        <ConfirmDialog
          title="Vider tous les détails et documents de ce contrat ?"
          text="Les détails et les documents seront supprimés définitivement, et l'analyse et le challenge seront désactivés."
          confirmLabel="Vider"
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

/** « Supprimer ce contrat » (US-133) : contrat complémentaire seulement ; la confirmation dit qu'un email de challenge récent ne se rappelle pas. */
function DeleteButton({ contract, onDeleted }: { contract: ContractView; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const remove = useApiMutation();
  if (contract.isBase) return null;

  async function confirm() {
    const result = await remove.run<{ challengeSentRecently: boolean }>(`/api/contracts/${contract.id}?delete=1`, { method: "DELETE" });
    if (result) onDeleted();
  }

  return (
    <>
      <button type="button" className={styles.danger} onClick={() => setConfirming(true)}>
        Supprimer ce contrat
      </button>
      {confirming && (
        <ConfirmDialog
          title={`Supprimer ${contract.name} ?`}
          text={`Ses informations, ses documents et son rapport seront supprimés définitivement.${contract.challengeSentRecently ? " L'email envoyé au challenge ne peut pas être rappelé." : ""}`}
          confirmLabel="Supprimer"
          confirming={remove.pending}
          onConfirm={confirm}
          onCancel={() => {
            remove.reset();
            setConfirming(false);
          }}
        >
          <ErrorLine error={remove.error} onRetry={confirm} />
        </ConfirmDialog>
      )}
    </>
  );
}
