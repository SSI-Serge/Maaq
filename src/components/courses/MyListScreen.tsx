"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import family from "@/components/family/family.module.css";
import { Button, Loading, Notice, RetryNotice } from "@/components/ui";
import type { MyList, MyStore } from "@/server/courses/list/mine";
import type { AddedLine } from "@/server/courses/list/service";
import { euro, euroPer } from "./ListScreen";
import styles from "./courses.module.css";

const BACK = { href: "/courses", label: "Courses et repas" };
const UNDO_MS = 8000;

/** « Ma liste de courses » (US-158) : la liste validée par magasin et par rayon, cochée en magasin ; un produit acheté sort de la liste et rejoint l'historique. */
export function CoursesMyListScreen() {
  const query = useApiQuery<{ list: MyList }>("/api/courses/list/mine");
  const [printing, setPrinting] = useState(false);
  const forbidden = query.error?.body?.code === "forbidden";

  function print() {
    flushSync(() => setPrinting(true));
    window.print();
    setPrinting(false);
  }

  const body = (
    <>
      {query.loading && !query.data && <Loading slow={query.slow} />}
      {forbidden && <Notice tone="info">La liste de courses n&apos;est pas disponible pour ce profil.</Notice>}
      {query.error && !forbidden && <RetryNotice message={query.error.message} onRetry={query.reload} />}
      {query.data && <Content list={query.data.list} reload={query.reload} onPrint={print} printing={printing} />}
    </>
  );
  if (printing) return <div style={{ padding: 16, background: "#fff", color: "#000" }}>{body}</div>;
  return (
    <AppShell title="Ma liste de courses" eyebrow="Courses et repas" back={BACK}>
      {body}
    </AppShell>
  );
}

function Content({ list, reload, onPrint, printing }: { list: MyList; reload: () => void; onPrint: () => void; printing: boolean }) {
  const bought = useApiMutation();
  const add = useApiMutation();
  const drop = useApiMutation();
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ key: string; name: string; late: boolean } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [text, setText] = useState("");
  const couple = list.access === "couple";

  async function tick(key: string, name: string, late: boolean) {
    setHidden((h) => new Set(h).add(key));
    const ok = await bought.run("/api/courses/list/bought", { method: "POST", body: { key, bought: true, late } });
    if (!ok) {
      setHidden((h) => {
        const next = new Set(h);
        next.delete(key);
        return next;
      });
      return;
    }
    if (timer.current) clearTimeout(timer.current);
    setToast({ key, name, late });
    timer.current = setTimeout(() => setToast(null), UNDO_MS);
    reload();
  }
  async function undo() {
    if (!toast) return;
    const { key, late } = toast;
    if (timer.current) clearTimeout(timer.current);
    setToast(null);
    if (await bought.run("/api/courses/list/bought", { method: "POST", body: { key, bought: false, late } })) {
      setHidden((h) => {
        const next = new Set(h);
        next.delete(key);
        return next;
      });
      reload();
    }
  }
  async function addLate() {
    if (!text.trim()) return;
    if (await add.run("/api/courses/list/products", { method: "POST", body: { name: text.trim() } })) {
      setText("");
      reload();
    }
  }
  async function removeLate(key: string) {
    if (await drop.run("/api/courses/list/products", { method: "DELETE", body: { key } })) reload();
  }

  if (list.empty) {
    return (
      <p className={styles.empty}>
        Aucune liste validée cette semaine. <Link href={list.hasMenu ? "/courses/liste" : "/courses/menu"}>{list.hasMenu ? "Préparer la liste ›" : "Préparer le menu ›"}</Link>
      </p>
    );
  }

  const late = list.late.filter((l) => !hidden.has(l.key));
  const stores = list.stores
    .map((s) => ({ ...s, aisles: s.aisles.map((a) => ({ ...a, lines: a.lines.filter((l) => !hidden.has(l.key)) })).filter((a) => a.lines.length > 0) }))
    .filter((s) => s.aisles.length > 0);
  const remaining = couple && list.remaining !== null ? list.stores.flatMap((s) => s.aisles.flatMap((a) => a.lines)).filter((l) => !hidden.has(l.key)).reduce((n, l) => n + (l.price ?? 0), 0) : null;

  return (
    <>
      {!printing && (
        <div className={styles.tools}>
          <Button variant="ghost" onClick={onPrint}>
            Imprimer
          </Button>
        </div>
      )}
      <section className={styles.dayCard} aria-label="Ajoutés depuis la validation">
        <div className={styles.dayHead}>
          <span className={styles.dayName}>Ajoutés depuis la validation</span>
          <span className={styles.meta}>{late.length ? `${late.length} produit${late.length > 1 ? "s" : ""}` : "Aucun pour l'instant"}</span>
        </div>
        {!printing && <span className={styles.meta}>Sans magasin ni prix : ils ne comptent pas dans le reste à acheter.</span>}
        {late.map((l) => (
          <LateRow key={l.key} line={l} couple={couple} printing={printing} onTick={() => void tick(l.key, l.name, true)} onRemove={() => void removeLate(l.key)} />
        ))}
        {!printing && (
          <div className={styles.addRow}>
            <input id="ml-add" className={family.input} placeholder="Ajouter un produit" aria-label="Ajouter un produit" value={text} maxLength={120} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void addLate()} />
            <Button variant="ghost" onClick={() => void addLate()} loading={add.pending}>
              + Ajouter
            </Button>
          </div>
        )}
      </section>

      {!printing && <p className={family.hint}>Cochez au fur et à mesure : un produit acheté sort de la liste et rejoint votre historique.</p>}
      {stores.map((s) => (
        <StoreBlock key={s.name} store={s} couple={couple} printing={printing} onTick={(key, name) => void tick(key, name, false)} />
      ))}
      {list.allBought || (stores.length === 0 && late.length === 0) ? (
        <p className={styles.session} role="status">
          ✓ Tout est acheté. Bonne semaine !
        </p>
      ) : (
        remaining !== null &&
        remaining > 0 && (
          <div className={styles.totalRow}>
            <span>Reste à acheter</span>
            <span>{euro(remaining)}</span>
          </div>
        )
      )}
      {(bought.error || add.error || drop.error) && <Notice tone="error">{(bought.error ?? add.error ?? drop.error)!.message}</Notice>}
      {toast && (
        <div role="status" className={styles.toast}>
          <span>{toast.name} acheté · rejoint votre historique</span>
          <button type="button" className={styles.toastUndo} onClick={() => void undo()}>
            Annuler
          </button>
        </div>
      )}
    </>
  );
}

function LateRow({ line, couple, printing, onTick, onRemove }: { line: AddedLine; couple: boolean; printing: boolean; onTick: () => void; onRemove: () => void }) {
  return (
    <div className={styles.line}>
      {!printing && <button type="button" className={styles.toggleBox} aria-label={`Marquer « ${line.name} » comme acheté`} onClick={onTick} />}
      <div className={styles.lineMain}>
        <div className={styles.lineName}>{line.name}</div>
        <div className={styles.lineSub}>{line.by ? `ajouté par ${line.by}` : "ajouté"}</div>
      </div>
      <span className={styles.meta}>×{line.qty}</span>
      {!printing && (couple || line.mine) && (
        <button type="button" className={styles.link} onClick={onRemove} aria-label={`Retirer ${line.name}`}>
          Retirer
        </button>
      )}
    </div>
  );
}

function StoreBlock({ store, couple, printing, onTick }: { store: MyStore; couple: boolean; printing: boolean; onTick: (key: string, name: string) => void }) {
  const sub = store.aisles.reduce((n, a) => n + a.lines.reduce((m, l) => m + (l.price ?? 0), 0), 0);
  return (
    <section>
      <div className={styles.storeHead}>
        <span>
          {store.name}
          {store.city ? ` · ${store.city}` : ""}
        </span>
        {couple && store.subtotal !== null && <span className={styles.meta}>{euro(sub)}</span>}
      </div>
      {store.aisles.map((a) => (
        <div key={a.name}>
          <h3 className={styles.kick}>{a.name}</h3>
          {a.lines.map((l) => (
            <div key={l.key} className={styles.line}>
              {!printing && <button type="button" className={styles.toggleBox} aria-label={`Marquer « ${l.name} » comme acheté`} onClick={() => onTick(l.key, l.name)} />}
              {printing && <span aria-hidden="true">☐</span>}
              <div className={styles.lineMain}>
                <div className={styles.lineName}>{l.name}</div>
                {l.reference && <div className={styles.lineSub}>{l.reference}{l.format ? ` · ${l.format}` : ""}</div>}
              </div>
              <span className={styles.meta}>×{l.qty}</span>
              {couple && l.price !== null && <span className={styles.linePrice}>{euro(l.price)}</span>}
              {couple && l.perMeasure && (
                <span className={styles.linePrice} title="Prix au kilo, non totalisé">
                  {euroPer(l.perMeasure.value, l.perMeasure.unit)}
                </span>
              )}
            </div>
          ))}
        </div>
      ))}
    </section>
  );
}
