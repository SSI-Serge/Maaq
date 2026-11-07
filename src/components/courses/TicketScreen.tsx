"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useRef, useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import family from "@/components/family/family.module.css";
import { Button, Loading, Notice, RetryNotice } from "@/components/ui";
import type { TicketConfirmation, TicketMenuIdea, TicketReadResult } from "@/server/courses/tickets/service";
import { euro } from "./ListScreen";
import styles from "./courses.module.css";
import { DUPLICATE_MESSAGE, EMPTY_PHOTO_MESSAGE, READING_MESSAGE, READ_TIMEOUT_MS, SAVING_MESSAGE, UNREADABLE_MESSAGE, failureOf, savedMessage } from "./ticket-messages";

const BACK = { href: "/courses", label: "Courses et repas" };
const MAX_PHOTOS = 3;

interface Line {
  product: string;
  reference: string;
  total: string;
  qty: string;
  aisle: string;
  /** Produit pesé : poids ou volume saisi, son unité, prix au kilo ou au litre lu sur le ticket (CR-39). */
  measured: string;
  measureUnit: "" | "kg" | "g" | "l" | "cl" | "ml";
  perMeasure: string;
}

const toNumber = (text: string) => Number(text.replace(/\s/g, "").replace("€", "").replace(",", "."));

/** « Enregistrer un ticket » (US-161) et « Menu à partir d'un ticket » (US-160) : photo, lecture, correction ligne par ligne, confirmation. Aucune photo n'est conservée. */
export function CoursesTicketScreen() {
  return (
    <AppShell title="Enregistrer un ticket" eyebrow="Courses et repas" back={BACK}>
      <Suspense fallback={<Loading />}>
        <Flow />
      </Suspense>
    </AppShell>
  );
}

function Flow() {
  const wantMenu = useSearchParams().get("menu") === "1";
  const read = useApiMutation();
  const confirm = useApiMutation();
  const input = useRef<HTMLInputElement>(null);
  const [ticket, setTicket] = useState<TicketReadResult | null>(null);
  const [store, setStore] = useState("");
  const [city, setCity] = useState("");
  const [date, setDate] = useState("");
  const [lines, setLines] = useState<Line[]>([]);
  const [editing, setEditing] = useState<number | null>(null);
  const [result, setResult] = useState<TicketConfirmation | null>(null);
  const [shared, setShared] = useState(false);
  const [summary, setSummary] = useState<{ store: string; date: string } | null>(null);
  const [photoError, setPhotoError] = useState(false);
  // Les photos choisies restent en mémoire le temps de la lecture : « Réessayer » les renvoie sans en reprendre une.
  const photos = useRef<File[]>([]);

  function onFiles(files: FileList | null) {
    if (!files?.length) return;
    photos.current = Array.from(files).slice(0, MAX_PHOTOS);
    if (input.current) input.current.value = "";
    void readPhotos();
  }

  async function readPhotos() {
    setPhotoError(false);
    if (!photos.current.length || photos.current.every((f) => f.size === 0)) {
      setPhotoError(true);
      return;
    }
    const body = new FormData();
    photos.current.forEach((f) => body.append("files", f));
    const response = await read.run<{ ticket: TicketReadResult }>("/api/courses/tickets/read", { method: "POST", body, timeoutMs: READ_TIMEOUT_MS });
    if (!response) return;
    const t = response.ticket;
    setTicket(t);
    setStore(t.draft.store);
    setCity(t.draft.city ?? "");
    setDate(t.draft.date);
    setLines(t.draft.lines.map((l) => ({ product: l.product, reference: l.reference ?? "", total: String(l.total).replace(".", ","), qty: String(l.qty).replace(".", ","), aisle: l.aisle, measured: l.measured ? String(l.measured).replace(".", ",") : "", measureUnit: l.measureUnit ?? "", perMeasure: l.pricePerMeasure ? String(l.pricePerMeasure).replace(".", ",") : "" })));
    setEditing(null);
    setResult(null);
  }

  const total = lines.reduce((s, l) => s + (toNumber(l.total) || 0), 0);
  const invalid = !store.trim() || lines.length === 0 || lines.some((l) => !l.product.trim() || !toNumber(l.total) || !(toNumber(l.qty) > 0));

  async function submit() {
    const response = await confirm.run<{ result: TicketConfirmation }>("/api/courses/tickets/confirm", {
      method: "POST",
      body: { store: store.trim(), city: city.trim() || null, date, lines: lines.map((l) => ({ product: l.product.trim(), reference: l.reference.trim() || null, total: toNumber(l.total), qty: toNumber(l.qty), aisle: l.aisle, measured: l.measureUnit && toNumber(l.measured) > 0 ? toNumber(l.measured) : null, measureUnit: l.measureUnit && toNumber(l.measured) > 0 ? l.measureUnit : null, pricePerMeasure: l.measureUnit && toNumber(l.perMeasure) > 0 ? toNumber(l.perMeasure) : null })) },
    });
    if (response) {
      setSummary({ store: store.trim(), date });
      setResult(response.result);
      setShared(response.result.shared > 0);
    }
  }

  function reset() {
    photos.current = [];
    read.reset();
    confirm.reset();
    setPhotoError(false);
    setTicket(null);
    setResult(null);
    setLines([]);
  }

  if (read.error?.body?.code === "forbidden") return <Notice tone="info">L&apos;enregistrement des tickets est réservé aux deux parents du couple.</Notice>;

  if (result) return <Done result={result} summary={summary} shared={shared} wantMenu={wantMenu} onAnother={reset} />;

  if (!ticket) {
    return (
      <>
        <p className={styles.lead}>
          Photographiez votre ticket de caisse (jusqu&apos;à {MAX_PHOTOS} photos si le ticket est long). MAAQ lit les lignes, vous vérifiez, puis vous confirmez.
          {wantMenu ? " Vous pourrez ensuite obtenir un menu avec ce que vous venez d'acheter." : ""}
        </p>
        <p className={family.hint}>La photo de votre ticket est supprimée une fois lue. Le nom et la carte de fidélité sont masqués avant la lecture.</p>
        <input ref={input} type="file" accept="image/*" capture="environment" multiple hidden aria-label="Photo du ticket" onChange={(e) => onFiles(e.target.files)} />
        {read.pending ? (
          <Loading slow={read.slow} label={READING_MESSAGE} />
        ) : (
          <Button block onClick={() => input.current?.click()}>
            Photographier un ticket
          </Button>
        )}
        {photoError && <Notice tone="error">{EMPTY_PHOTO_MESSAGE}</Notice>}
        {read.error && !read.pending && (failureOf(read.error).retry ? <RetryNotice message={read.error.message} onRetry={() => void readPhotos()} /> : <Notice tone="error">{read.error.message}</Notice>)}
      </>
    );
  }

  if (!ticket.draft.readable) {
    return (
      <>
        <Notice tone="warning">{UNREADABLE_MESSAGE}</Notice>
        <Button block onClick={reset}>
          Reprendre une photo
        </Button>
      </>
    );
  }

  return (
    <>
      {ticket.duplicate && <Notice tone="info">{DUPLICATE_MESSAGE}</Notice>}
      <p className={styles.lead}>
        Ticket lu : <strong>{store || "enseigne à indiquer"}</strong>
        {city ? `, ${city}` : ""} · {date.split("-").reverse().join("/")}. Vérifiez les lignes, corrigez si besoin.
      </p>
      {ticket.draft.dateGuessed && <p className={family.hint}>La date n&apos;était pas lisible : c&apos;est celle d&apos;aujourd&apos;hui, à corriger si besoin.</p>}
      <div className={family.two}>
        <div className={family.field}>
          <label className={family.label} htmlFor="tk-store">
            Enseigne
          </label>
          <input id="tk-store" className={family.input} value={store} maxLength={80} onChange={(e) => setStore(e.target.value)} />
        </div>
        <div className={family.field}>
          <label className={family.label} htmlFor="tk-date">
            Date
          </label>
          <input id="tk-date" className={family.input} type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
      </div>

      {lines.map((l, i) => (
        <div key={i} className={styles.dayCard}>
          <div className={styles.dayHead}>
            <span className={styles.lineName}>{l.product || "—"}</span>
            <span className={styles.lineName}>{euro(toNumber(l.total) || 0)}</span>
          </div>
          <span className={styles.meta}>
            {l.reference ? `${l.reference} · ` : ""}{l.measureUnit && toNumber(l.measured) > 0 ? `${l.measured} ${l.measureUnit}${toNumber(l.perMeasure) > 0 ? ` à ${l.perMeasure} €/${l.measureUnit === "g" ? "kg" : l.measureUnit === "kg" ? "kg" : "L"}` : ""}` : `qté ${l.qty}`} · {l.aisle}
          </span>
          {editing === i ? (
            <div className={family.form}>
              <input className={family.input} aria-label="Produit" value={l.product} maxLength={120} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, product: e.target.value } : x)))} />
              <div className={family.two}>
                <input className={family.input} aria-label="Prix de la ligne" inputMode="decimal" value={l.total} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, total: e.target.value } : x)))} />
                <input className={family.input} aria-label="Quantité" inputMode="decimal" value={l.qty} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, qty: e.target.value } : x)))} />
              </div>
              <div className={family.two}>
                <input className={family.input} aria-label="Poids ou volume (produit pesé)" placeholder="Poids ou volume (facultatif)" inputMode="decimal" value={l.measured} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, measured: e.target.value } : x)))} />
                <select className={family.select} aria-label="Unité du poids ou du volume" value={l.measureUnit} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, measureUnit: e.target.value as Line["measureUnit"] } : x)))}>
                  <option value="">À la pièce</option>
                  <option value="kg">kg</option>
                  <option value="g">g</option>
                  <option value="l">L</option>
                  <option value="cl">cl</option>
                  <option value="ml">ml</option>
                </select>
              </div>
              <select className={family.select} aria-label="Rayon" value={l.aisle} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, aisle: e.target.value } : x)))}>
                {ticket.aisles.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
              <div className={family.actionsRow}>
                <Button variant="ghost" onClick={() => { setLines(lines.filter((_, k) => k !== i)); setEditing(null); }}>
                  Retirer la ligne
                </Button>
                <Button onClick={() => setEditing(null)}>OK</Button>
              </div>
            </div>
          ) : (
            <button type="button" className={styles.link} onClick={() => setEditing(i)}>
              Corriger
            </button>
          )}
        </div>
      ))}
      <div className={styles.totalRow}>
        <span>Total</span>
        <span>{euro(total)}</span>
      </div>
      <p className={family.hint}>La photo de votre ticket est supprimée une fois lue. Le nom et la carte de fidélité sont masqués avant la lecture.</p>
      {confirm.pending && <Loading slow={confirm.slow} label={SAVING_MESSAGE} />}
      {confirm.error && !confirm.pending && (failureOf(confirm.error).retry ? <RetryNotice message={confirm.error.message} onRetry={() => void submit()} /> : <Notice tone="error">{confirm.error.message}</Notice>)}
      <div className={styles.footer}>
        <div className={family.actionsRow}>
          <Button variant="ghost" onClick={reset}>
            Annuler
          </Button>
          <Button onClick={() => void submit()} loading={confirm.pending} disabled={invalid || confirm.pending}>
            Confirmer le ticket
          </Button>
        </div>
      </div>
    </>
  );
}

function Done({ result, summary, shared, wantMenu, onAnother }: { result: TicketConfirmation; summary: { store: string; date: string } | null; shared: boolean; wantMenu: boolean; onAnother: () => void }) {
  const [showMenu, setShowMenu] = useState(wantMenu);
  if (result.duplicate) {
    return (
      <>
        <Notice tone="info">{DUPLICATE_MESSAGE}</Notice>
        <Button block onClick={onAnother}>
          Enregistrer un autre ticket
        </Button>
      </>
    );
  }
  return (
    <>
      <div className={styles.session} role="status">
        ✓ {savedMessage({ store: summary?.store ?? "", date: summary?.date ?? "", lines: result.recorded, total: result.total, ticked: result.removed.length })}
        {result.removed.length > 0 ? ` Cochés : ${result.removed.join(", ")}.` : ""} Budget mis à jour : {result.aisles.join(", ")}.
        {shared ? " Les prix sont ajoutés, sans votre nom, à la base commune." : ""}
      </div>
      <p className={family.hint}>La photo a été supprimée.</p>
      {!showMenu ? (
        <>
          <p className={styles.lead}>Voulez-vous un menu avec ce que vous venez d&apos;acheter ?</p>
          <Button variant="ghost" onClick={() => setShowMenu(true)}>
            Menu à partir de ce ticket
          </Button>
        </>
      ) : (
        result.receiptId && <Ideas receipt={result.receiptId} />
      )}
      <div style={{ marginTop: 12 }}>
        <button type="button" className={styles.link} onClick={onAnother}>
          Enregistrer un autre ticket
        </button>
      </div>
    </>
  );
}

function Ideas({ receipt }: { receipt: string }) {
  const query = useApiQuery<{ ideas: TicketMenuIdea[] }>(`/api/courses/tickets/menu?ticket=${receipt}`);
  if (query.loading && !query.data) return <Loading slow={query.slow} />;
  if (query.error) return <RetryNotice message={query.error.message} onRetry={query.reload} />;
  const ideas = query.data?.ideas ?? [];
  if (!ideas.length) return <p className={styles.empty}>Aucun plat du catalogue ne correspond à ces achats pour l&apos;instant.</p>;
  return (
    <>
      <p className={styles.lead}>Avec ce que vous venez d&apos;acheter :</p>
      {ideas.map((i) => (
        <div key={i.id} className={styles.dayCard}>
          <div className={styles.lineName}>{i.name}</div>
          <span className={styles.meta}>{i.missing.length ? `Reste à acheter : ${i.missing.join(", ")}` : "Tout est déjà acheté."}</span>
        </div>
      ))}
      <Link href={`/courses/menu?plats=${ideas.slice(0, 2).map((i) => encodeURIComponent(i.id)).join(",")}`} className={styles.link}>
        Choisir et préparer le menu ›
      </Link>
    </>
  );
}
