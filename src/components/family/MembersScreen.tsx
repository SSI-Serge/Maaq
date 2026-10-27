"use client";

import { useEffect, useId, useState, type ReactNode } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import type { MutationState } from "@/client/hooks";
import { AppShell, appStyles as s } from "@/components/app/AppShell";
import { Button, Loading, Notice, RetryNotice } from "@/components/ui";
import type { FamilyMemberView, FamilyOverview } from "@/server/assistant/family";
import { birthLabel, todayLocal } from "./format";
import { FALLBACK_COLOR } from "./parts";
import styles from "./family.module.css";

const MAX_NAME = 30;
const RANK: Record<"primary" | "guest", string> = { primary: "Utilisateur principal", guest: "Invité" };

/** Libellé relié à sa saisie (nom accessible), avec l'aide et l'erreur annoncées avec elle. */
function Field({ label, error, hint, children }: { label: string; error?: string | null; hint?: string; children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode }) {
  const id = useId();
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={styles.field}>
      <label htmlFor={id} className={styles.label}>
        {label}
      </label>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint && (
        <span id={`${id}-hint`} className={styles.hint}>
          {hint}
        </span>
      )}
      {error && (
        <span id={`${id}-error`} className={styles.fieldError} role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** Erreur de l'opération en cours : un refus du serveur s'affiche tel quel, une panne propose « Réessayer » ; la saisie est conservée (CC-2, CC-3). */
function Outcome({ mutation, onRetry }: { mutation: MutationState; onRetry: () => void }) {
  const { error, slow } = mutation;
  return (
    <>
      {error && !error.body?.code && (
        <RetryNotice message={error.kind === "server" ? "L'opération n'a pas pu aboutir. Vos informations sont conservées." : error.message} onRetry={onRetry} />
      )}
      {error && error.body?.code && <Notice tone="error">{error.message}</Notice>}
      {slow && !error && <Notice tone="info">Toujours en cours…</Notice>}
    </>
  );
}

const Pencil = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
  </svg>
);
const Bin = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
    <path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13" />
  </svg>
);

/** Prénom et mois de naissance : le formulaire de l'ajout et de la modification (mêmes contrôles, US-93 RF2). */
function MemberForm({ title, member, submitLabel, pendingLabel, hint, onSubmit, onCancel, mutation }: {
  title: string;
  member?: FamilyMemberView;
  submitLabel: string;
  pendingLabel: string;
  hint?: string;
  onSubmit: (values: { firstName: string; birth: string | null }) => void;
  onCancel: () => void;
  mutation: MutationState;
}) {
  const [name, setName] = useState(member?.firstName ?? "");
  const [birth, setBirth] = useState(member?.birth ?? "");
  const today = todayLocal();
  const nameError = !name.trim() ? "Le prénom est obligatoire." : [...name.trim()].length > MAX_NAME ? `Le prénom ne peut pas dépasser ${MAX_NAME} caractères.` : null;
  const birthError = birth && birth > today.slice(0, 7) ? "La date de naissance ne peut pas être dans le futur." : null;
  const invalid = Boolean(nameError || birthError);
  const values = () => ({ firstName: name.trim(), birth: birth || null });

  return (
    <form
      className={styles.form}
      aria-label={title}
      onSubmit={(e) => {
        e.preventDefault();
        if (!invalid) onSubmit(values());
      }}
    >
      <div className={styles.dialogTitle}>{title}</div>
      <Field label="Prénom" error={name ? nameError : null} hint={member?.linked ? "Le prénom se modifie depuis le profil de cette personne." : undefined}>
        {(a11y) => (
          <input
            {...a11y}
            className={`${styles.input} ${name && nameError ? styles.inputError : ""}`}
            value={name}
            maxLength={MAX_NAME + 10}
            onChange={(e) => setName(e.target.value)}
            disabled={mutation.pending || member?.linked}
            autoComplete="off"
          />
        )}
      </Field>
      <Field label="Mois et année de naissance (facultatif)" error={birthError}>
        {(a11y) => (
          <input {...a11y} type="month" className={`${styles.input} ${birthError ? styles.inputError : ""}`} value={birth} max={today.slice(0, 7)} onChange={(e) => setBirth(e.target.value)} disabled={mutation.pending} />
        )}
      </Field>
      {hint && <span className={styles.hint}>{hint}</span>}
      <Outcome mutation={mutation} onRetry={() => onSubmit(values())} />
      <div className={styles.actionsRow}>
        <Button variant="ghost" type="button" onClick={onCancel} disabled={mutation.pending}>
          Annuler
        </Button>
        <Button type="submit" loading={mutation.pending} disabled={invalid}>
          {mutation.pending ? pendingLabel : submitLabel}
        </Button>
      </div>
    </form>
  );
}

function AddMember({ onAdded, onCancel }: { onAdded: (member: FamilyMemberView) => void; onCancel: () => void }) {
  const mutation = useApiMutation();
  async function add(values: { firstName: string; birth: string | null }) {
    const result = await mutation.run<{ member: FamilyMemberView }>("/api/family/members", { method: "POST", body: values });
    if (result) onAdded(result.member);
  }
  return (
    <div className={styles.memberCard}>
      <MemberForm
        title="Nouveau membre"
        submitLabel="Ajouter"
        pendingLabel="Ajout…"
        hint="Pour donner un accès à l'application à ce membre, invitez-le depuis « Mes invités »."
        onSubmit={(values) => void add(values)}
        onCancel={onCancel}
        mutation={mutation}
      />
    </div>
  );
}

function RemovePanel({ member, onDone, onCancel }: { member: FamilyMemberView; onDone: () => void; onCancel: () => void }) {
  const mutation = useApiMutation();
  // Une fois fait, le bouton reste en chargement jusqu'à ce que la liste se mette à jour : pas de second envoi.
  const [done, setDone] = useState(false);
  async function remove() {
    if ((await mutation.run(`/api/family/members/${member.id}/remove`, { method: "POST" })) !== undefined) {
      setDone(true);
      onDone();
    }
  }
  return (
    <div role="alertdialog" aria-label={`Retirer ${member.firstName} ?`} className={styles.form}>
      <div className={styles.confirmTitle}>Retirer {member.firstName} ?</div>
      <p className={styles.confirmText}>Les RDV déjà créés en son nom sont conservés dans l&apos;historique.</p>
      {member.upcoming > 0 && (
        <p className={styles.confirmText}>
          {member.upcoming === 1 ? "1 rendez-vous à venir le concerne : il reste dans le calendrier." : `${member.upcoming} rendez-vous à venir le concernent : ils restent dans le calendrier.`}
        </p>
      )}
      <Outcome mutation={mutation} onRetry={() => void remove()} />
      <div className={styles.actionsRow}>
        <Button variant="ghost" onClick={onCancel} disabled={mutation.pending || done}>
          Annuler
        </Button>
        <Button variant="danger" onClick={() => void remove()} loading={mutation.pending || done}>
          {mutation.pending || done ? "Retrait…" : "Retirer"}
        </Button>
      </div>
    </div>
  );
}

function ErasePanel({ member, onDone, onCancel }: { member: FamilyMemberView; onDone: () => void; onCancel: () => void }) {
  const mutation = useApiMutation();
  // Une fois fait, le bouton reste en chargement jusqu'à ce que la liste se mette à jour : pas de second envoi.
  const [done, setDone] = useState(false);
  async function erase() {
    if ((await mutation.run(`/api/family/members/${member.id}/erase`, { method: "POST" })) !== undefined) {
      setDone(true);
      onDone();
    }
  }
  return (
    <div role="alertdialog" aria-label={`Effacer définitivement ${member.firstName} ?`} className={styles.form}>
      <div className={styles.confirmTitle}>Effacer définitivement {member.firstName} ?</div>
      <p className={styles.confirmText}>Ses informations et les rendez-vous qui ne concernent que lui seront supprimés. Cette action est irréversible.</p>
      <Outcome mutation={mutation} onRetry={() => void erase()} />
      <div className={styles.actionsRow}>
        <Button variant="ghost" onClick={onCancel} disabled={mutation.pending || done}>
          Annuler
        </Button>
        <Button variant="danger" onClick={() => void erase()} loading={mutation.pending || done}>
          {mutation.pending || done ? "Effacement…" : "Effacer définitivement"}
        </Button>
      </div>
    </div>
  );
}

type Mode = "view" | "edit" | "remove" | "erase";

function MemberCard({ member, onChanged }: { member: FamilyMemberView; onChanged: (message: string) => void }) {
  const [mode, setMode] = useState<Mode>("view");
  const mutation = useApiMutation();

  async function save(values: { firstName: string; birth: string | null }) {
    // Le prénom d'un membre relié à un profil ne s'envoie pas : il suit le profil (US-93 RF3).
    const body = member.linked ? { birth: values.birth } : values;
    const result = await mutation.run<{ member: FamilyMemberView }>(`/api/family/members/${member.id}`, { method: "PATCH", body });
    if (result) {
      setMode("view");
      onChanged(`${result.member.firstName} a été mis(e) à jour.`);
    }
  }

  if (mode === "edit") {
    return (
      <div className={styles.memberCard}>
        <MemberForm title="Modifier le membre" member={member} submitLabel="Enregistrer" pendingLabel="Enregistrement…" onSubmit={(v) => void save(v)} onCancel={() => setMode("view")} mutation={mutation} />
      </div>
    );
  }
  if (mode === "remove") {
    return (
      <div className={styles.memberCard}>
        <RemovePanel member={member} onCancel={() => setMode("view")} onDone={() => onChanged(`${member.firstName} a été retiré(e) de la famille.`)} />
      </div>
    );
  }
  if (mode === "erase") {
    return (
      <div className={styles.memberCard}>
        <ErasePanel member={member} onCancel={() => setMode("view")} onDone={() => onChanged("Le membre a été effacé définitivement.")} />
      </div>
    );
  }
  return (
    <div className={styles.memberCard}>
      <div className={styles.memberRow}>
        <div>
          <div className={styles.memberName}>
            <span className={styles.dot} style={{ background: member.color || FALLBACK_COLOR }} aria-hidden />
            {member.firstName}
            {member.badge && <span className={`${styles.rank} ${member.badge === "guest" ? styles.rankGuest : ""}`}>{RANK[member.badge]}</span>}
          </div>
          {member.birth && <div className={styles.memberMeta}>Né(e) en {birthLabel(member.birth)}</div>}
        </div>
        <div className={styles.iconButtons}>
          <button type="button" className={styles.iconButton} aria-label={`Modifier ${member.firstName}`} onClick={() => setMode("edit")}>
            <Pencil />
          </button>
          {!member.linked && (
            <button type="button" className={styles.iconButton} aria-label={`Retirer ${member.firstName}`} onClick={() => setMode("remove")}>
              <Bin />
            </button>
          )}
        </div>
      </div>
      {!member.linked && (
        <button type="button" className={styles.dangerLink} onClick={() => setMode("erase")}>
          Effacer définitivement
        </button>
      )}
    </div>
  );
}

function RemovedItem({ member, onChanged }: { member: FamilyMemberView; onChanged: (message: string) => void }) {
  const [asking, setAsking] = useState(false);
  if (asking) {
    return (
      <div className={styles.removedItem}>
        <ErasePanel member={member} onCancel={() => setAsking(false)} onDone={() => onChanged("Le membre a été effacé définitivement.")} />
      </div>
    );
  }
  return (
    <div className={styles.removedItem}>
      <span>{member.firstName}</span>
      <button type="button" className={styles.dangerLink} onClick={() => setAsking(true)}>
        Effacer définitivement
      </button>
    </div>
  );
}

/**
 * Membres de la famille (US-92, US-93) : les personnes que l'assistant peut associer aux rendez-vous, avec ou sans compte MAAQ.
 * Les deux parents ajoutent, modifient, retirent ou effacent ; les profils (utilisateur principal, invités) ne se retirent pas d'ici.
 */
export function MembersScreen() {
  const overview = useApiQuery<FamilyOverview>("/api/family/members");
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const data = overview.data;
  const full = Boolean(data && data.members.length >= data.max);
  const forbidden = overview.error?.body?.code === "forbidden";

  function changed(message: string) {
    setAdding(false);
    setNotice(message);
    overview.reload();
  }

  return (
    <AppShell title="Membres de la famille" back={{ href: "/assistant", label: "Assistant Famille" }}>
      <p className={styles.hint}>
        Un membre peut être concerné par un RDV ou une tâche sans jamais se connecter à MAAQ (ex. un jeune enfant). Un invité a en plus un accès applicatif : il est donc aussi un membre.
      </p>

      {notice && <Notice tone="success">{notice}</Notice>}
      {overview.loading && !data && <Loading slow={overview.slow} />}
      {overview.error && !forbidden && <RetryNotice message={overview.error.kind === "server" ? "La liste des membres n'a pas pu être chargée." : overview.error.message} onRetry={overview.reload} />}
      {forbidden && <Notice tone="info">L&apos;Assistant Famille est réservé aux deux parents du foyer.</Notice>}

      {data && (
        <>
          {data.members.every((m) => m.linked) && <div className={s.empty}>Ajoutez vos enfants ou les autres personnes concernées par vos rendez-vous.</div>}

          <div className={styles.memberList}>
            {data.members.map((m) => (
              <MemberCard key={m.id} member={m} onChanged={changed} />
            ))}
          </div>

          {adding ? (
            <AddMember onCancel={() => setAdding(false)} onAdded={(m) => changed(`${m.firstName} a été ajouté(e) à la famille.`)} />
          ) : (
            <>
              <Button onClick={() => setAdding(true)} disabled={full}>
                Ajouter un membre
              </Button>
              {full && <span className={styles.hint}>Nombre maximal de membres atteint ({data.max}).</span>}
            </>
          )}

          {data.removed.length > 0 && (
            <details className={styles.removedBox}>
              <summary>Membres retirés ({data.removed.length})</summary>
              {data.removed.map((m) => (
                <RemovedItem key={m.id} member={m} onChanged={changed} />
              ))}
            </details>
          )}
        </>
      )}
    </AppShell>
  );
}
