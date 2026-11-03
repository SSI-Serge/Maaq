"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import { useSessionUser } from "@/components/auth/AuthGate";
import { Loading, Notice, RetryNotice } from "@/components/ui";
import type { WishList, WishView } from "@/server/emotions/wishes";
import styles from "./emotions.module.css";

const BACK = { href: "/assistant", label: "Assistant Famille" };
const LIMIT = "Vous avez beaucoup d'envies ! Faites-en disparaître une pour en ajouter une nouvelle.";
const UNDO_MS = 10_000;

const HORIZON_STYLE: Record<string, string> = { soon: styles.horizonSoon, this_year: styles.horizonYear };

/** « Nos envies » (US-147) : la liste complète du couple, sans date ni statut. « Retirer » laisse dix secondes pour « Annuler » (US-150), « En faire un RDV » ouvre le formulaire de RDV (US-151). */
export function WishesScreen() {
  // L'envie annoncée par la notification est mise en avant (adresse « #identifiant ») ; la liste n'apparaît qu'après le chargement, donc sans écart d'affichage.
  const focus = typeof window === "undefined" ? "" : window.location.hash.slice(1);
  const query = useApiQuery<WishList>("/api/family/wishes");
  const mutation = useApiMutation();
  const [removed, setRemoved] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const data = query.data;
  const forbidden = query.error?.body?.code === "forbidden";
  const full = Boolean(data && data.wishes.length >= data.max);

  async function remove(id: string) {
    const done = await mutation.run(`/api/family/wishes/${id}`, { method: "DELETE" });
    if (done === undefined) return;
    setRemoved(id);
    query.reload();
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setRemoved(null), UNDO_MS);
  }
  async function undo(id: string) {
    const done = await mutation.run(`/api/family/wishes/${id}/restore`, { method: "POST" });
    if (done === undefined) return;
    if (timer.current) clearTimeout(timer.current);
    setRemoved(null);
    query.reload();
  }

  return (
    <AppShell
      title="Nos envies"
      eyebrow={data ? `À deux · ${data.partner}` : "À deux"}
      back={BACK}
      action={
        data && (
          <Link href={full ? "#" : "/assistant/envies/nouvelle"} aria-label="Ajouter une envie" aria-disabled={full} className={`${styles.addRound} ${full ? styles.addRoundOff : ""}`}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden>
              <path d="M12 5v14M5 12h14" />
            </svg>
          </Link>
        )
      }
    >
      {query.loading && !data && <Loading slow={query.slow} />}
      {forbidden && <Notice tone="info">« Nos envies » est réservé aux deux parents du couple.</Notice>}
      {query.error && !forbidden && <RetryNotice message={query.error.message} onRetry={query.reload} />}
      {data && (
        <>
          <p className={styles.noteMeta} style={{ fontSize: 12, lineHeight: 1.45, textAlign: "left" }}>
            Vos projets et vos idées à deux, sans date ni obligation. Seuls vous deux les voyez.
          </p>
          {full && <div className={styles.limit}>{LIMIT}</div>}
          {data.wishes.length === 0 && (
            <div className={styles.empty}>
              <div className={styles.italic} style={{ fontSize: 17 }}>
                Vos envies à deux : un week-end, un projet, une idée…
              </div>
              <Link href="/assistant/envies/nouvelle" className={styles.cta2}>
                + Ajouter une envie
              </Link>
            </div>
          )}
          {data.wishes.map((w) => (
            <WishCard key={w.id} wish={w} fresh={focus === w.id} busy={mutation.pending} onRemove={() => void remove(w.id)} />
          ))}
          {mutation.error && <Notice tone="error">{mutation.error.kind === "rejected" ? mutation.error.message : "L'opération n'a pas pu être enregistrée : réessayez."}</Notice>}
          {removed && (
            <div className={styles.toast} role="status">
              <span>Envie retirée</span>
              <button type="button" className={styles.toastBtn} disabled={mutation.pending} onClick={() => void undo(removed)}>
                Annuler
              </button>
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}

function WishCard({ wish, fresh, busy, onRemove }: { wish: WishView; fresh: boolean; busy: boolean; onRemove: () => void }) {
  return (
    <div className={`${styles.wishCard} ${fresh ? styles.wishFresh : ""}`} id={wish.id}>
      <div className={styles.wishHead}>
        <div className={styles.wishTitle}>{wish.title}</div>
        {wish.horizonLabel && <span className={`${styles.horizon} ${wish.horizon ? (HORIZON_STYLE[wish.horizon] ?? "") : ""}`}>{wish.horizonLabel}</span>}
      </div>
      {wish.description && <div style={{ fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.45 }}>{wish.description}</div>}
      <div className={styles.noteMeta} style={{ textAlign: "left" }}>
        Ajoutée par {wish.by ?? "un parent"}
        {fresh ? " · nouvelle" : ""}
      </div>
      <div className={styles.wishActions}>
        <Link href={`/assistant/envies/${wish.id}/rdv`} className={styles.rdv}>
          En faire un RDV
        </Link>
        <Link href={`/assistant/envies/${wish.id}`} className={styles.link2}>
          Modifier
        </Link>
        <button type="button" className={styles.link2} style={{ color: "var(--ink-soft)" }} disabled={busy} onClick={onRemove}>
          Retirer
        </button>
      </div>
    </div>
  );
}

/** Formulaire « Nouvelle envie » / « Modifier l'envie » (US-148) : titre (60), description facultative (200), horizon flou facultatif. Le partenaire est prévenu à l'ajout, pas à la modification. */
export function WishFormScreen({ id }: { id?: string }) {
  const router = useRouter();
  const list = useApiQuery<WishList>("/api/family/wishes");
  const mutation = useApiMutation();
  const me = useSessionUser().firstName;
  const existing = id ? list.data?.wishes.find((w) => w.id === id) : undefined;
  return (
    <AppShell title={id ? "Modifier l'envie" : "Nouvelle envie"} eyebrow="À deux" back={{ href: "/assistant/envies", label: "Nos envies" }}>
      {list.loading && !list.data && <Loading slow={list.slow} />}
      {list.error && <RetryNotice message={list.error.message} onRetry={list.reload} />}
      {list.data && id && !existing && <Notice tone="info">Cette envie n&apos;existe plus.</Notice>}
      {list.data && (!id || existing) && (
        <WishForm
          key={existing?.id ?? "new"}
          existing={existing}
          partner={list.data.partner}
          me={me}
          full={!id && list.data.wishes.length >= list.data.max}
          pending={mutation.pending}
          error={mutation.error?.kind === "rejected" ? mutation.error.message : mutation.error ? "L'envie n'a pas pu être enregistrée : réessayez." : null}
          onSave={async (fields) => {
            const result = id
              ? await mutation.run(`/api/family/wishes/${id}`, { method: "PATCH", body: fields })
              : await mutation.run("/api/family/wishes", { method: "POST", body: fields });
            return result !== undefined;
          }}
          onDone={() => router.push("/assistant/envies")}
        />
      )}
    </AppShell>
  );
}

function WishForm({ existing, partner, me, full, pending, error, onSave, onDone }: { existing?: WishView; partner: string; me: string; full: boolean; pending: boolean; error: string | null; onSave: (fields: { title: string; description: string | null; horizon: string | null }) => Promise<boolean>; onDone: () => void }) {
  const [title, setTitle] = useState(existing?.title ?? "");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [horizon, setHorizon] = useState<string | null>(existing?.horizon ?? null);
  const [saved, setSaved] = useState(false);
  const blocked = !title.trim() || full;
  const HORIZONS: [string, string][] = [["soon", "Bientôt"], ["this_year", "Cette année"], ["someday", "Un jour"]];

  async function save() {
    if (blocked) return;
    const ok = await onSave({ title: title.trim(), description: description.trim() || null, horizon });
    if (ok) setSaved(true);
  }

  if (saved)
    return (
      <div className={styles.saved}>
        <div className={styles.savedMark} aria-hidden>
          ✓
        </div>
        <div className={styles.italic} style={{ fontSize: 19 }}>
          {existing ? "Envie modifiée" : "Envie ajoutée"}
        </div>
        <p className={styles.noteMeta} style={{ fontSize: 13, lineHeight: 1.5, textAlign: "center" }}>
          {existing ? `« ${title.trim()} » est à jour. ${partner} n'est pas prévenu d'une modification.` : `« ${title.trim()} » est dans vos envies. ${partner} est prévenu.`}
        </p>
        <button type="button" className={styles.goldLink} onClick={onDone}>
          Voir nos envies ›
        </button>
      </div>
    );

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {full && <div className={styles.limit}>{LIMIT}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label htmlFor="env-titre" style={{ fontSize: 12, fontWeight: 700 }}>
          Titre
        </label>
        <input id="env-titre" className={styles.noteInputLine} type="text" maxLength={60} value={title} placeholder="ex. Week-end à Lisbonne" onChange={(e) => setTitle(e.target.value)} />
        <div className={styles.count}>{[...title].length} / 60</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        <label htmlFor="env-desc" style={{ fontSize: 12, fontWeight: 700 }}>
          Description <span style={{ fontWeight: 500, color: "var(--ink-soft)" }}>· facultatif</span>
        </label>
        <textarea id="env-desc" className={styles.noteInputLine} maxLength={200} value={description} placeholder="Une phrase pour vous en souvenir" style={{ minHeight: 84, resize: "none", lineHeight: 1.45 }} onChange={(e) => setDescription(e.target.value)} />
        <div className={styles.count}>{[...description].length} / 200</div>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <span style={{ fontSize: 12, fontWeight: 700 }}>
          Quand ? <span style={{ fontWeight: 500, color: "var(--ink-soft)" }}>· facultatif, sans date</span>
        </span>
        <div className={styles.horizons}>
          {HORIZONS.map(([value, label]) => (
            <button key={value} type="button" className={styles.hz} aria-pressed={horizon === value} onClick={() => setHorizon(horizon === value ? null : value)}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <p className={styles.noteMeta} style={{ fontSize: 12, lineHeight: 1.45, textAlign: "left" }}>
        {existing ? "L'un ou l'autre peut modifier une envie. Aucune notification n'est envoyée." : `${partner} recevra « ${me} a ajouté une envie à deux. », sans le titre.`}
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      <button type="button" className={styles.primary} style={{ opacity: blocked ? 0.5 : 1 }} disabled={blocked || pending} onClick={() => void save()}>
        {existing ? "Enregistrer" : "Ajouter à nos envies"}
      </button>
    </div>
  );
}
