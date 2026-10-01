"use client";

import { useEffect, useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell, Section, appStyles as s } from "@/components/app/AppShell";
import { ConfirmDialog, ErrorLine } from "@/components/auth/parts";
import { Button, Field, Loading, Notice, RetryNotice } from "@/components/ui";

type Status = "not_invited" | "sending" | "invitation_sent" | "invitation_expired" | "send_failed" | "active" | "grace_period";

interface Guest {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  rank: "core" | "secondary";
  status: Status;
  lastSentAt: string | null;
}

interface GuestList {
  guests: Guest[];
  quota: number;
  used: number;
  hasCoreGuest: boolean;
}

type Form = { firstName: string; lastName: string; email: string; phone: string };

const STATUS: Record<Status, { label: string; tone: string }> = {
  not_invited: { label: "Invitation non envoyée", tone: s.neutral },
  sending: { label: "Envoi en cours", tone: s.neutral },
  invitation_sent: { label: "Invitation envoyée", tone: s.neutral },
  invitation_expired: { label: "Invitation expirée", tone: s.error },
  send_failed: { label: "Échec d'envoi", tone: s.error },
  active: { label: "Actif", tone: s.ok },
  grace_period: { label: "Suppression demandée", tone: s.warn },
};

const time = (iso: string) => new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/** Gestion des invités de l'utilisateur principal (US-5, US-18 à US-21), maquette Invités. */
export default function GuestsPage() {
  const query = useApiQuery<GuestList>("/api/guests");
  const [list, setList] = useState<GuestList | null>(null);
  const data = list ?? query.data ?? null;
  const [toast, setToast] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  // L'envoi des invitations est en arrière-plan (CC-10) : on relit tant qu'un envoi est en cours.
  const sending = data?.guests.some((g) => g.status === "sending");
  const { reload } = query;
  useEffect(() => {
    if (!sending) return;
    const timer = setTimeout(() => {
      setList(null);
      reload();
    }, 2000);
    return () => clearTimeout(timer);
  }, [sending, reload, data]);

  const update = (next: GuestList, message?: string) => {
    setList(next);
    if (message) setToast(message);
  };

  const atQuota = data ? data.used >= data.quota : true;

  return (
    <AppShell title="Mes invités">
      {/* Bandeau de quota (US-21) */}
      <Section title="Quota du plan">
        {query.loading && !data && <Loading slow={query.slow} />}
        {query.error && !data && <RetryNotice message={query.error.message} onRetry={query.reload} />}
        {data && (
          <>
            <div className={s.row}>
              <span className={s.text} style={{ fontWeight: 700 }}>
                {data.used} invité{data.used > 1 ? "s" : ""} sur {data.quota} — {Math.max(data.quota - data.used, 0)} place
                {Math.max(data.quota - data.used, 0) > 1 ? "s" : ""} disponible{Math.max(data.quota - data.used, 0) > 1 ? "s" : ""}
              </span>
            </div>
            <div className={s.gauge} aria-hidden>
              <div className={s.gaugeFill} style={{ width: `${data.quota ? Math.min(100, (data.used / data.quota) * 100) : 100}%` }} />
            </div>
            <p className={s.muted}>
              {atQuota
                ? "Vous avez atteint le nombre maximum d'invités de votre plan."
                : "Le nombre d'invités possibles dépend de votre plan souscrit. Le premier invité ajouté devient l'« Invité 1 »."}
            </p>
          </>
        )}
      </Section>

      {toast && <Notice tone="success">✓ {toast}</Notice>}

      {data?.guests.map((guest) => (
        <GuestCard key={`${guest.id}-${guest.status}-${guest.email}-${guest.rank}`} guest={guest} canDesignate={!data.hasCoreGuest} onUpdated={update} />
      ))}

      {adding ? (
        <AddGuestForm
          canDesignate={data ? !data.hasCoreGuest : false}
          onCancel={() => setAdding(false)}
          onAdded={(next) => {
            setAdding(false);
            update(next, "Invitation envoyée");
          }}
        />
      ) : (
        <Button
          block
          disabled={!data || atQuota}
          onClick={() => {
            setToast(null);
            setAdding(true);
          }}
        >
          + Ajouter un invité
        </Button>
      )}
    </AppShell>
  );
}

function GuestCard({ guest, canDesignate, onUpdated }: { guest: Guest; canDesignate: boolean; onUpdated: (list: GuestList, message?: string) => void }) {
  const [mode, setMode] = useState<"view" | "edit" | "delete" | "designate">("view");
  const [form, setForm] = useState<Form>({ firstName: guest.firstName, lastName: guest.lastName, email: guest.email, phone: guest.phone ?? "" });
  const [abandoning, setAbandoning] = useState(false);
  const mutation = useApiMutation();
  const status = STATUS[guest.status];
  const pendingActivation = guest.status !== "active" && guest.status !== "grace_period";
  const dirty = form.firstName !== guest.firstName || form.lastName !== guest.lastName || form.email !== guest.email || form.phone !== (guest.phone ?? "");
  const errors = mutation.error?.body?.code === "invalid_guest" ? (mutation.error.body.details as Record<string, string>) : {};

  async function act(path: string, method: "POST" | "PATCH" | "DELETE", message: string, body?: unknown) {
    const result = await mutation.run<GuestList>(path, { method, body });
    if (result) {
      setMode("view");
      onUpdated(result, message);
    }
  }

  return (
    <Section
      title={guest.rank === "core" ? "Invité 1" : "Invité secondaire"}
      action={<span className={`${s.badge} ${status.tone}`}>{status.label}</span>}
    >
      {mode === "edit" ? (
        <div className={s.form}>
          <Field label="Prénom" value={form.firstName} error={errors.firstName} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
          <Field label="Nom" value={form.lastName} error={errors.lastName} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
          <Field label="Email" type="email" value={form.email} error={errors.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <Field label="Téléphone (facultatif)" type="tel" value={form.phone} error={errors.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
          {pendingActivation && <p className={s.muted}>Changer l&apos;email ou le téléphone invalide le lien d&apos;invitation en cours.</p>}
          {!errors.email && <ErrorLine error={mutation.error} />}
          <div className={s.row}>
            <Button variant="secondary" disabled={mutation.pending} onClick={() => (dirty ? setAbandoning(true) : setMode("view"))}>
              Annuler
            </Button>
            <Button loading={mutation.pending} disabled={!dirty} onClick={() => act(`/api/guests/${guest.id}`, "PATCH", "Informations mises à jour", form)}>
              Enregistrer
            </Button>
          </div>
          {abandoning && (
            <ConfirmDialog
              title="Abandonner vos modifications ?"
              confirmLabel="Abandonner"
              onConfirm={() => {
                setAbandoning(false);
                setForm({ firstName: guest.firstName, lastName: guest.lastName, email: guest.email, phone: guest.phone ?? "" });
                setMode("view");
              }}
              onCancel={() => setAbandoning(false)}
            />
          )}
        </div>
      ) : (
        <>
          <div className={s.row}>
            <div>
              <div className={s.text} style={{ fontWeight: 700 }}>
                {guest.firstName} {guest.lastName}
              </div>
              <div className={s.muted}>
                {guest.email}
                {guest.phone ? ` · ${guest.phone}` : ""}
              </div>
            </div>
            <div style={{ display: "flex", gap: 2 }}>
              <button className={s.smallButton} onClick={() => setMode("edit")} aria-label={`Modifier ${guest.firstName} ${guest.lastName}`}>
                Modifier
              </button>
              <button className={`${s.smallButton} ${s.danger}`} onClick={() => setMode("delete")} aria-label={`Supprimer ${guest.firstName} ${guest.lastName}`}>
                Supprimer
              </button>
            </div>
          </div>

          {guest.status === "invitation_sent" && guest.lastSentAt && <p className={s.muted}>Invitation envoyée à {time(guest.lastSentAt)}.</p>}
          {guest.status === "invitation_expired" && (
            <p className={s.muted}>Le lien envoyé à {guest.firstName} a expiré au bout de 30 minutes sans activation.</p>
          )}
          {guest.status === "send_failed" && <p className={s.muted}>L&apos;invitation n&apos;a pas pu être envoyée.</p>}

          {pendingActivation && guest.status !== "sending" && (
            <>
              {mutation.error?.body?.code === "resend_limited" ? (
                <Notice tone="warning">{mutation.error.message}</Notice>
              ) : (
                <ErrorLine error={mutation.error} onRetry={() => act(`/api/guests/${guest.id}/invitation`, "POST", `Nouveau lien envoyé à ${guest.firstName}`)} />
              )}
              <Button
                variant="secondary"
                block
                loading={mutation.pending}
                disabled={mutation.error?.body?.code === "resend_limited"}
                onClick={() => act(`/api/guests/${guest.id}/invitation`, "POST", guest.status === "not_invited" ? "Invitation envoyée" : `Nouveau lien envoyé à ${guest.firstName}`)}
              >
                {guest.status === "not_invited" ? "Envoyer l'invitation" : "Renvoyer un nouveau lien"}
              </Button>
            </>
          )}
          {canDesignate && (
            <Button variant="ghost" onClick={() => setMode("designate")}>
              Désigner comme invité 1
            </Button>
          )}
        </>
      )}

      {mode === "delete" && (
        <ConfirmDialog
          title={`Supprimer ${guest.firstName} ${guest.lastName} ?`}
          text={
            `Son accès est retiré immédiatement, sur tous ses appareils. Ses adresses en copie sont supprimées. ` +
            `Ses demandes restent visibles dans le carnet de bord, sans son nom.` +
            (guest.rank === "core" ? ` Étant « Invité 1 », il fait partie du noyau du compte : vous pourrez désigner un nouvel invité 1.` : "")
          }
          confirmLabel="Supprimer"
          confirming={mutation.pending}
          onConfirm={() => act(`/api/guests/${guest.id}`, "DELETE", `${guest.firstName} ${guest.lastName} a été supprimé`)}
          onCancel={() => {
            mutation.reset();
            setMode("view");
          }}
        />
      )}
      {mode === "designate" && (
        <ConfirmDialog
          title={`Désigner ${guest.firstName} comme invité 1 ?`}
          text="L'invité 1 rejoint le noyau du compte : il est ajouté automatiquement à vos rendez-vous, voit tout le carnet de bord et accède aux contrats."
          confirmLabel="Désigner"
          confirming={mutation.pending}
          onConfirm={() => act(`/api/guests/${guest.id}/core`, "POST", `${guest.firstName} ${guest.lastName} est désormais Invité 1`)}
          onCancel={() => setMode("view")}
        />
      )}
      {(mode === "delete" || mode === "designate") && <ErrorLine error={mutation.error} />}
    </Section>
  );
}

function AddGuestForm({ canDesignate, onCancel, onAdded }: { canDesignate: boolean; onCancel: () => void; onAdded: (list: GuestList) => void }) {
  const [form, setForm] = useState<Form>({ firstName: "", lastName: "", email: "", phone: "" });
  const [designateCore, setDesignateCore] = useState(false);
  const mutation = useApiMutation();
  const errors = mutation.error?.body?.code === "invalid_guest" ? (mutation.error.body.details as Record<string, string>) : {};
  const complete = form.firstName.trim() && form.lastName.trim() && form.email.trim();

  async function send() {
    const result = await mutation.run<GuestList>("/api/guests", { method: "POST", body: { ...form, designateCore } });
    if (result) onAdded(result);
  }

  return (
    <Section title="Nouvel invité">
      <form
        className={s.form}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <Field label="Prénom *" value={form.firstName} error={errors.firstName} maxLength={100} onChange={(e) => setForm({ ...form, firstName: e.target.value })} />
        <Field label="Nom *" value={form.lastName} error={errors.lastName} maxLength={100} onChange={(e) => setForm({ ...form, lastName: e.target.value })} />
        <Field label="Email *" type="email" value={form.email} error={errors.email} placeholder="email@exemple.fr" onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <Field
          label="Téléphone mobile (facultatif)"
          type="tel"
          value={form.phone}
          error={errors.phone}
          placeholder="06 00 00 00 00"
          hint="Sans numéro, l'invitation n'est envoyée que par email."
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
        />
        {canDesignate && (
          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
            <input type="checkbox" checked={designateCore} onChange={(e) => setDesignateCore(e.target.checked)} />
            Désigner comme invité 1
          </label>
        )}
        {mutation.error?.body?.code !== "invalid_guest" && <ErrorLine error={mutation.error} onRetry={send} />}
        <div className={s.row}>
          <Button type="button" variant="secondary" disabled={mutation.pending} onClick={onCancel}>
            Annuler
          </Button>
          <Button type="submit" loading={mutation.pending} disabled={!complete}>
            Inviter
          </Button>
        </div>
      </form>
    </Section>
  );
}
