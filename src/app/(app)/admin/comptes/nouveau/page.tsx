"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useApiAction } from "@/client/hooks";
import { BackLink, PageHead, adminStyles as s } from "@/components/admin/AdminShell";
import { ErrorLine } from "@/components/auth/parts";
import { Button, ButtonLink } from "@/components/ui";

const EMAIL_FORMAT = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type Form = { firstName: string; lastName: string; email: string; phone: string; guestQuota: string; dailyRequestLimit: string };

/** Création du compte d'un utilisateur principal (US-64 RF2 à RF9). */
export default function CreateAccountPage() {
  const router = useRouter();
  const [form, setForm] = useState<Form>({ firstName: "", lastName: "", email: "", phone: "", guestQuota: "", dailyRequestLimit: "50" });
  const [errors, setErrors] = useState<Partial<Record<keyof Form, string>>>({});
  const create = useApiAction<unknown, { accountId: string; email: string }>("/api/admin/accounts");

  const set = (key: keyof Form) => (event: React.ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [key]: event.target.value });
    setErrors({ ...errors, [key]: undefined });
  };

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await send();
  }

  async function send() {
    const found: Partial<Record<keyof Form, string>> = {};
    if (!form.firstName.trim()) found.firstName = "Le prénom est obligatoire.";
    if (!form.lastName.trim()) found.lastName = "Le nom est obligatoire.";
    if (!EMAIL_FORMAT.test(form.email.trim())) found.email = "Adresse email invalide";
    if (!/^\d+$/.test(form.guestQuota.trim())) found.guestQuota = "Indiquez un nombre entier positif ou nul.";
    if (!/^\d+$/.test(form.dailyRequestLimit.trim()) || Number(form.dailyRequestLimit) < 1) {
      found.dailyRequestLimit = "Indiquez un nombre entier supérieur ou égal à 1.";
    }
    setErrors(found);
    if (Object.keys(found).length) return;

    const result = await create.run({
      firstName: form.firstName,
      lastName: form.lastName,
      email: form.email,
      phone: form.phone,
      guestQuota: Number(form.guestQuota),
      dailyRequestLimit: Number(form.dailyRequestLimit),
    });
    if (result) router.push(`/admin/comptes?cree=${encodeURIComponent(result.email)}`);
  }

  // Erreurs de saisie renvoyées par le serveur (email déjà utilisé, téléphone invalide…).
  const serverErrors =
    create.error?.body?.code === "invalid_account" ? (create.error.body.details as Partial<Record<keyof Form, string>>) : {};
  const errorOf = (key: keyof Form) => errors[key] ?? serverErrors[key];

  const field = (key: keyof Form, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <div>
      <label className={s.label} htmlFor={key}>
        {label}
      </label>
      <input id={key} className={`${s.input} ${errorOf(key) ? s.inputError : ""}`} value={form[key]} onChange={set(key)} {...props} />
      {errorOf(key) && <div className={s.fieldError}>{errorOf(key)}</div>}
    </div>
  );

  return (
    <>
      <BackLink href="/admin/comptes">Comptes</BackLink>
      <PageHead title="Créer un compte" />
      <form className={s.panel} onSubmit={submit} noValidate style={{ maxWidth: 720 }}>
        <div className={s.grid2}>
          {field("firstName", "Prénom", { maxLength: 100, autoComplete: "off" })}
          {field("lastName", "Nom", { maxLength: 100, autoComplete: "off" })}
          {field("email", "Email", { type: "email", maxLength: 254, autoComplete: "off" })}
          {field("phone", "Téléphone (facultatif)", { type: "tel", maxLength: 30, placeholder: "06 12 34 56 78" })}
          {field("guestQuota", "Nombre d'invités autorisés (plan souscrit)", { type: "number", min: 0 })}
          {field("dailyRequestLimit", "Plafond quotidien de demandes par profil", { type: "number", min: 1 })}
        </div>
        <p className={s.hint} style={{ marginTop: 14 }}>
          Un email d&apos;activation, valable 30 minutes, part dès la création. Un compte dont le lien d&apos;activation n&apos;a jamais été
          utilisé est supprimé automatiquement 30 jours après le dernier envoi.
        </p>
        {create.error?.body?.code !== "invalid_account" && <ErrorLine error={create.error} onRetry={send} />}
        <div className={s.actions}>
          <ButtonLink href="/admin/comptes" variant="secondary">
            Annuler
          </ButtonLink>
          <Button type="submit" loading={create.pending}>
            Créer le compte
          </Button>
        </div>
      </form>
    </>
  );
}
