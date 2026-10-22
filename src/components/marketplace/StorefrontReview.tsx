"use client";

import Link from "next/link";
import { useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { appStyles as s } from "@/components/app/AppShell";
import { ErrorLine } from "@/components/auth/parts";
import { Button, Field, Loading, Notice, RetryNotice } from "@/components/ui";
import type { AvailabilityMode, ContactMethod, FieldGroup, PriceMode, ServiceCategory, ServiceMode, Storefront } from "@/server/marketplace/model";
import type { StorefrontPatch, StorefrontView } from "@/server/marketplace/service";
import styles from "./marketplace.module.css";

/**
 * Relecture de la vitrine sur la fiche de l'agent vitrine : chaque groupe de champs avec sa provenance, modification
 * ligne par ligne sans recommencer la conversation, aperçu côté acheteur, publication explicite, pause et
 * indisponibilité (US-05, US-06). Mêmes données que le tchat de l'agent.
 */

// Libellés et règles recopiés de src/server/marketplace/model.ts : seuls les types sont importés du serveur.
const GROUPS: FieldGroup[] = ["displayName", "category", "services", "description", "area", "availability", "price", "contact", "languages", "notice", "qualifications"];
const REQUIRED_GROUPS: FieldGroup[] = ["displayName", "category", "services", "description", "area", "availability", "contact"];
const GROUP_LABEL: Record<FieldGroup, string> = {
  displayName: "Nom affiché",
  category: "Catégorie",
  services: "Services",
  description: "Description",
  area: "Zone",
  availability: "Disponibilité",
  price: "Tarifs",
  languages: "Langues",
  notice: "Délai de réservation",
  qualifications: "Qualifications",
  contact: "Contact",
};
const MODE_LABEL: Record<ServiceMode, string> = { at_supplier: "chez le fournisseur", travels: "se déplace", remote: "à distance" };
const MODE_CHOICE: Record<ServiceMode, string> = { at_supplier: "Chez moi", travels: "Je me déplace", remote: "À distance" };
const CONTACT_LABEL: Record<ContactMethod, string> = { maaq_intro: "Présentation par MAAQ (email)", whatsapp: "WhatsApp, après accord" };
const AVAILABILITY_LABEL: Record<AvailabilityMode, string> = { hours: "Horaires précis", by_arrangement: "À convenir" };
const PRICE_LABEL: Record<PriceMode, string> = { quote: "Sur devis", from: "À partir de", range: "Fourchette" };
const PROVENANCE_BADGE = {
  stated: { text: "dit par vous", tone: s.neutral },
  proposed: { text: "proposé par MAAQ", tone: s.warn },
  confirmed: { text: "confirmé", tone: s.ok },
} as const;

function euros(n: number): string {
  return `${Number.isInteger(n) ? n : n.toFixed(2).replace(".", ",")} €`;
}

function dateTime(iso: string): string {
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric" }).format(new Date(iso));
}

function dateOnly(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Valeur d'un groupe telle qu'une personne la lit ; null quand le groupe n'est pas renseigné. */
function groupValue(group: FieldGroup, sf: Storefront, categories: ServiceCategory[]): string | null {
  switch (group) {
    case "displayName":
      return sf.displayName?.trim() || null;
    case "category":
      return sf.categoryCode ? (categories.find((c) => c.code === sf.categoryCode)?.label ?? sf.categoryCode) : null;
    case "services":
      return sf.services.length ? sf.services.join(", ") : null;
    case "description":
      return sf.description?.trim() || null;
    case "area": {
      if (!sf.postcode && !sf.city && sf.modes.length === 0) return null;
      const parts: string[] = [];
      const place = [sf.city, sf.postcode].filter(Boolean).join(" ");
      if (place) parts.push(place);
      for (const mode of sf.modes) {
        if (mode === "travels") parts.push(`${MODE_LABEL.travels}${sf.travelAreas.length ? ` vers ${sf.travelAreas.join(", ")}` : ""}`);
        else parts.push(MODE_LABEL[mode]);
      }
      if (sf.travelNote) parts.push(sf.travelNote);
      return parts.join(" · ");
    }
    case "availability":
      if (sf.availabilityMode === "by_arrangement") return "À convenir";
      if (sf.availabilityMode === "hours") return sf.availabilityText?.trim() || null;
      return null;
    case "price":
      if (sf.priceMode === "quote") return "Sur devis";
      if (sf.priceMode === "from") return sf.priceMin !== null ? `À partir de ${euros(sf.priceMin)}` : null;
      if (sf.priceMode === "range") return sf.priceMin !== null && sf.priceMax !== null ? `${euros(sf.priceMin).replace(" €", "")} à ${euros(sf.priceMax)}` : null;
      return null;
    case "contact":
      if (!sf.contactMethod) return null;
      return `${CONTACT_LABEL[sf.contactMethod]}${sf.contactValue ? ` — ${sf.contactValue}` : ""}`;
    case "languages":
      return sf.languages.length ? sf.languages.join(", ") : null;
    case "notice":
      return sf.noticeText?.trim() || null;
    case "qualifications":
      return sf.qualificationsText?.trim() || null;
  }
}

export function StorefrontReview({ agentId, added }: { agentId: string; added: boolean }) {
  const view = useApiQuery<StorefrontView>("/api/storefront");
  const [editing, setEditing] = useState<FieldGroup | null>(null);
  const confirm = useApiMutation();

  if (view.loading && !view.data) return <Loading slow={view.slow} />;
  if (view.error && !view.data) return <RetryNotice message={view.error.message} onRetry={view.reload} />;
  if (!view.data) return null;
  const { storefront, issues, issueLines, canPublish, preview, categories } = view.data;

  if (!storefront) {
    return (
      <div className={styles.review}>
        <p className={s.text}>Pas encore de vitrine. Décrivez votre activité à l&apos;agent vitrine, à l&apos;oral ou à l&apos;écrit : il la rédige avec vous.</p>
        {added ? (
          <Link href={`/tchat/${agentId}`} className={s.smallButton} style={{ textDecoration: "none", padding: 0 }}>
            Ouvrir le tchat de l&apos;agent vitrine ›
          </Link>
        ) : (
          <p className={s.muted}>Ajoutez d&apos;abord l&apos;agent vitrine à votre dashboard pour lui parler.</p>
        )}
      </div>
    );
  }

  async function confirmGroup(group: FieldGroup) {
    const result = await confirm.run<StorefrontView>("/api/storefront/confirm", { method: "POST", body: { groups: [group] } });
    if (result) view.reload();
  }

  return (
    <div className={styles.review}>
      {issueLines.length > 0 && (
        <Notice tone="warning">
          Avant de publier :
          <ul className={styles.issueList}>
            {issueLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Notice>
      )}

      <div className={styles.groups}>
        {GROUPS.map((group) => {
          const value = groupValue(group, storefront, categories);
          const source = storefront.provenance[group]?.source;
          const badge = value === null ? (REQUIRED_GROUPS.includes(group) ? { text: "manquant", tone: s.error } : { text: "facultatif", tone: s.neutral }) : source ? PROVENANCE_BADGE[source] : null;
          const needsConfirm = issues.some((issue) => issue.group === group && (issue.reason === "proposed" || issue.reason === "unconfirmed"));
          return (
            <div key={group} className={styles.group}>
              <div className={styles.groupHead}>
                <span className={styles.groupLabel}>{GROUP_LABEL[group]}</span>
                {badge && <span className={`${s.badge} ${badge.tone}`}>{badge.text}</span>}
              </div>
              <div className={`${styles.groupValue} ${value === null ? styles.groupEmpty : ""}`}>{value ?? "Non renseigné"}</div>
              {editing !== group && (
                <div className={styles.groupActions}>
                  {needsConfirm && (
                    <button type="button" className={s.smallButton} disabled={confirm.pending} onClick={() => void confirmGroup(group)}>
                      Confirmer
                    </button>
                  )}
                  <button type="button" className={s.smallButton} onClick={() => setEditing(group)}>
                    Modifier
                  </button>
                </div>
              )}
              {editing === group && (
                <GroupEditor
                  group={group}
                  storefront={storefront}
                  categories={categories}
                  onDone={() => {
                    setEditing(null);
                    view.reload();
                  }}
                  onCancel={() => setEditing(null)}
                />
              )}
            </div>
          );
        })}
      </div>
      <ErrorLine error={confirm.error} />

      {preview && (
        <div className={styles.preview}>
          <div className={styles.previewTitle}>Aperçu côté acheteur</div>
          <div className={styles.previewName}>{preview.name}</div>
          <div className={styles.previewLine}>{preview.category}</div>
          {preview.services.length > 0 && <div className={styles.previewLine}>{preview.services.join(", ")}</div>}
          <div className={styles.previewLine}>{preview.area}</div>
          <div className={styles.previewLine}>
            {preview.availability} · {preview.price}
          </div>
          {preview.description && <div className={styles.previewLine}>{preview.description}</div>}
          <p className={styles.previewNote}>Aucune adresse ni numéro n&apos;apparaît. La raison de la suggestion est ajoutée au moment où elle est faite.</p>
        </div>
      )}

      <StatusPanel key={`${storefront.status}:${storefront.pausedUntil ?? ""}`} storefront={storefront} canPublish={canPublish} onChanged={view.reload} />
    </div>
  );
}

/** Publication, pause, indisponibilité temporaire : la conversation seule ne publie jamais. */
function StatusPanel({ storefront, canPublish, onChanged }: { storefront: Storefront; canPublish: boolean; onChanged: () => void }) {
  const publish = useApiMutation();
  const pause = useApiMutation();
  const unavailable = useApiMutation();
  const [until, setUntil] = useState(storefront.pausedUntil ?? "");

  async function run(action: ReturnType<typeof useApiMutation>, path: string, body?: unknown) {
    const result = await action.run<StorefrontView>(path, { method: "POST", body });
    if (result) onChanged();
  }

  if (storefront.status === "draft") {
    return (
      <div className={styles.statusBox}>
        <Button block loading={publish.pending} disabled={!canPublish} onClick={() => void run(publish, "/api/storefront/publish")}>
          Publier — suggérée silencieusement
        </Button>
        <p className={s.muted}>La conversation seule ne publie jamais : la publication se fait ici.</p>
        <ErrorLine error={publish.error} />
      </div>
    );
  }

  const paused = storefront.status === "paused";
  return (
    <div className={styles.statusBox}>
      <Notice tone="success">
        {storefront.publishedAt ? `Publiée le ${dateTime(storefront.publishedAt)}` : "Publiée"}
        {paused ? " — Suggestions en pause" : ""}
        {storefront.pausedUntil ? ` — Indisponible jusqu'au ${dateOnly(storefront.pausedUntil)}` : ""}
      </Notice>
      {storefront.lastConfirmedAt && <p className={s.muted}>Détails confirmés le {dateTime(storefront.lastConfirmedAt)}</p>}
      <Button variant="secondary" block loading={pause.pending} onClick={() => void run(pause, "/api/storefront/pause", { paused: !paused })}>
        {paused ? "Reprendre les suggestions" : "Mettre en pause"}
      </Button>
      <ErrorLine error={pause.error} />
      <div className={styles.dateRow}>
        <label className={styles.selectLabel}>
          <span className={styles.label}>Indisponible jusqu&apos;au</span>
          <input type="date" className={styles.dateInput} value={until} onChange={(e) => setUntil(e.target.value)} />
        </label>
        <Button variant="secondary" loading={unavailable.pending} disabled={!until} onClick={() => void run(unavailable, "/api/storefront/unavailable", { until })}>
          Enregistrer
        </Button>
      </div>
      {storefront.pausedUntil && (
        <Button variant="ghost" loading={unavailable.pending} onClick={() => void run(unavailable, "/api/storefront/unavailable", { until: null })}>
          Annuler l&apos;indisponibilité
        </Button>
      )}
      <ErrorLine error={unavailable.error} />
    </div>
  );
}

interface EditorForm {
  displayName: string;
  categoryCode: string;
  services: string;
  description: string;
  postcode: string;
  city: string;
  modes: ServiceMode[];
  travelAreas: string;
  travelNote: string;
  availabilityMode: "" | AvailabilityMode;
  availabilityText: string;
  priceMode: "" | PriceMode;
  priceMin: string;
  priceMax: string;
  languages: string;
  noticeText: string;
  qualificationsText: string;
  contactMethod: "" | ContactMethod;
  contactValue: string;
}

function formOf(sf: Storefront): EditorForm {
  return {
    displayName: sf.displayName ?? "",
    categoryCode: sf.categoryCode ?? "",
    services: sf.services.join(", "),
    description: sf.description ?? "",
    postcode: sf.postcode ?? "",
    city: sf.city ?? "",
    modes: sf.modes,
    travelAreas: sf.travelAreas.join(", "),
    travelNote: sf.travelNote ?? "",
    availabilityMode: sf.availabilityMode ?? "",
    availabilityText: sf.availabilityText ?? "",
    priceMode: sf.priceMode ?? "",
    priceMin: sf.priceMin !== null ? String(sf.priceMin) : "",
    priceMax: sf.priceMax !== null ? String(sf.priceMax) : "",
    languages: sf.languages.join(", "),
    noticeText: sf.noticeText ?? "",
    qualificationsText: sf.qualificationsText ?? "",
    contactMethod: sf.contactMethod ?? "",
    contactValue: sf.contactValue ?? "",
  };
}

const text = (v: string) => v.trim() || null;
const list = (v: string) => v.split(",").map((x) => x.trim()).filter(Boolean);
const num = (v: string) => (v.trim() === "" ? null : Number(v.replace(",", ".")));

/** Seuls les champs du groupe modifié partent au serveur. */
function patchOf(group: FieldGroup, form: EditorForm): StorefrontPatch {
  switch (group) {
    case "displayName":
      return { displayName: text(form.displayName) };
    case "category":
      return { categoryCode: form.categoryCode || null };
    case "services":
      return { services: list(form.services) };
    case "description":
      return { description: text(form.description) };
    case "area":
      return { postcode: text(form.postcode), city: text(form.city), modes: form.modes, travelAreas: list(form.travelAreas).map((d) => d.toUpperCase()), travelNote: text(form.travelNote) };
    case "availability":
      return { availabilityMode: form.availabilityMode || null, availabilityText: form.availabilityMode === "hours" ? text(form.availabilityText) : null };
    case "price":
      return {
        priceMode: form.priceMode || null,
        priceMin: form.priceMode === "from" || form.priceMode === "range" ? num(form.priceMin) : null,
        priceMax: form.priceMode === "range" ? num(form.priceMax) : null,
      };
    case "contact":
      return { contactMethod: form.contactMethod || null, contactValue: text(form.contactValue) };
    case "languages":
      return { languages: list(form.languages) };
    case "notice":
      return { noticeText: text(form.noticeText) };
    case "qualifications":
      return { qualificationsText: text(form.qualificationsText) };
  }
}

/** Modification d'un groupe de champs ; ce que le fournisseur écrit ici est considéré comme confirmé par lui. */
function GroupEditor({ group, storefront, categories, onDone, onCancel }: { group: FieldGroup; storefront: Storefront; categories: ServiceCategory[]; onDone: () => void; onCancel: () => void }) {
  const [form, setForm] = useState<EditorForm>(() => formOf(storefront));
  const save = useApiMutation();
  const errors = (save.error?.body?.details as { path?: (string | number)[]; message: string }[] | undefined) ?? [];
  const errorFor = (field: string) => errors.find((e) => e.path?.[0] === field)?.message;
  const set = <K extends keyof EditorForm>(key: K, value: EditorForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const result = await save.run<StorefrontView>("/api/storefront", { method: "PATCH", body: patchOf(group, form) });
    if (result) onDone();
  }

  function toggleMode(mode: ServiceMode, on: boolean) {
    set("modes", on ? [...new Set([...form.modes, mode])] : form.modes.filter((m) => m !== mode));
  }

  return (
    <form className={styles.editor} onSubmit={submit}>
      {group === "displayName" && <Field label="Nom affiché" value={form.displayName} onChange={(e) => set("displayName", e.target.value)} error={errorFor("displayName")} maxLength={100} />}

      {group === "category" && (
        <label className={styles.selectLabel}>
          <span className={styles.label}>Catégorie</span>
          <select className={styles.select} value={form.categoryCode} onChange={(e) => set("categoryCode", e.target.value)}>
            <option value="">—</option>
            {categories.map((c) => (
              <option key={c.code} value={c.code}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {group === "services" && <Field label="Services, séparés par des virgules" value={form.services} onChange={(e) => set("services", e.target.value)} error={errorFor("services")} placeholder="coupe, barbe, coloration" />}

      {group === "description" && (
        <label className={styles.selectLabel}>
          <span className={styles.label}>Description</span>
          <textarea className={styles.textarea} maxLength={1000} value={form.description} onChange={(e) => set("description", e.target.value)} />
          {errorFor("description") && <span className={s.danger}>{errorFor("description")}</span>}
        </label>
      )}

      {group === "area" && (
        <>
          <div className={styles.editorRow}>
            <Field label="Ville" value={form.city} onChange={(e) => set("city", e.target.value)} error={errorFor("city")} />
            <Field label="Code postal" inputMode="numeric" maxLength={5} value={form.postcode} onChange={(e) => set("postcode", e.target.value)} error={errorFor("postcode")} />
          </div>
          {(Object.keys(MODE_CHOICE) as ServiceMode[]).map((mode) => (
            <label key={mode} className={styles.checkbox}>
              <input type="checkbox" checked={form.modes.includes(mode)} onChange={(e) => toggleMode(mode, e.target.checked)} />
              {MODE_CHOICE[mode]}
            </label>
          ))}
          {errorFor("modes") && <span className={s.danger}>{errorFor("modes")}</span>}
          {form.modes.includes("travels") && (
            <>
              <Field label="Départements où je me déplace, séparés par des virgules" value={form.travelAreas} onChange={(e) => set("travelAreas", e.target.value)} error={errorFor("travelAreas")} placeholder="75, 92, 93" />
              <Field label="Précision sur les déplacements (facultatif)" value={form.travelNote} onChange={(e) => set("travelNote", e.target.value)} error={errorFor("travelNote")} maxLength={200} />
            </>
          )}
        </>
      )}

      {group === "availability" && (
        <>
          <label className={styles.selectLabel}>
            <span className={styles.label}>Disponibilité</span>
            <select className={styles.select} value={form.availabilityMode} onChange={(e) => set("availabilityMode", e.target.value as EditorForm["availabilityMode"])}>
              <option value="">—</option>
              {(Object.keys(AVAILABILITY_LABEL) as AvailabilityMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {AVAILABILITY_LABEL[mode]}
                </option>
              ))}
            </select>
          </label>
          {form.availabilityMode === "hours" && (
            <Field label="Horaires" value={form.availabilityText} onChange={(e) => set("availabilityText", e.target.value)} error={errorFor("availabilityText")} placeholder="Du lundi au vendredi, 9 h – 18 h" maxLength={300} />
          )}
        </>
      )}

      {group === "price" && (
        <>
          <label className={styles.selectLabel}>
            <span className={styles.label}>Tarifs</span>
            <select className={styles.select} value={form.priceMode} onChange={(e) => set("priceMode", e.target.value as EditorForm["priceMode"])}>
              <option value="">—</option>
              {(Object.keys(PRICE_LABEL) as PriceMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {PRICE_LABEL[mode]}
                </option>
              ))}
            </select>
          </label>
          {(form.priceMode === "from" || form.priceMode === "range") && (
            <div className={styles.editorRow}>
              <Field label={form.priceMode === "range" ? "Minimum (€)" : "À partir de (€)"} type="number" min={0} step="0.01" value={form.priceMin} onChange={(e) => set("priceMin", e.target.value)} error={errorFor("priceMin")} />
              {form.priceMode === "range" && <Field label="Maximum (€)" type="number" min={0} step="0.01" value={form.priceMax} onChange={(e) => set("priceMax", e.target.value)} error={errorFor("priceMax")} />}
            </div>
          )}
        </>
      )}

      {group === "contact" && (
        <>
          <label className={styles.selectLabel}>
            <span className={styles.label}>Mise en relation</span>
            <select className={styles.select} value={form.contactMethod} onChange={(e) => set("contactMethod", e.target.value as EditorForm["contactMethod"])}>
              <option value="">—</option>
              {(Object.keys(CONTACT_LABEL) as ContactMethod[]).map((method) => (
                <option key={method} value={method}>
                  {CONTACT_LABEL[method]}
                </option>
              ))}
            </select>
          </label>
          <Field
            label={form.contactMethod === "whatsapp" ? "Numéro WhatsApp" : "Email ou numéro"}
            value={form.contactValue}
            onChange={(e) => set("contactValue", e.target.value)}
            error={errorFor("contactValue")}
            hint="Révélé seulement après une mise en relation acceptée."
            maxLength={200}
          />
          <p className={s.muted}>
            Ce qui circule, étape par étape : une suggestion montre au membre votre vitrine sans ce contact ; une demande de mise en relation vous apporte son besoin, le moment, sa zone et son prénom ; si vous acceptez, il reçoit ce contact et vous recevez son email (et son téléphone s&apos;il en a un). Refuser ne transmet rien ; sans réponse sous 7 jours, la demande expire.
          </p>
        </>
      )}

      {group === "languages" && <Field label="Langues, séparées par des virgules" value={form.languages} onChange={(e) => set("languages", e.target.value)} error={errorFor("languages")} placeholder="français, anglais" />}

      {group === "notice" && <Field label="Délai de réservation" value={form.noticeText} onChange={(e) => set("noticeText", e.target.value)} error={errorFor("noticeText")} placeholder="48 h à l'avance" maxLength={200} />}

      {group === "qualifications" && (
        <label className={styles.selectLabel}>
          <span className={styles.label}>Qualifications</span>
          <textarea className={styles.textarea} maxLength={500} value={form.qualificationsText} onChange={(e) => set("qualificationsText", e.target.value)} />
          {errorFor("qualificationsText") && <span className={s.danger}>{errorFor("qualificationsText")}</span>}
        </label>
      )}

      {errors.length === 0 && <ErrorLine error={save.error} />}
      <div className={styles.actions}>
        <Button type="submit" loading={save.pending}>
          Enregistrer
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Annuler
        </Button>
      </div>
    </form>
  );
}
