"use client";

import { useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import { Loading, Notice, RetryNotice } from "@/components/ui";
import type { NoteView } from "@/server/emotions/notes";
import { stamp } from "./format";
import styles from "./emotions.module.css";

const MAX = 500;

/**
 * « Un mot pour [prénom] » (US-143) : un message libre à tout moment de la semaine, lu par le partenaire dans son bilan, sans qu'il soit prévenu avant. Modifiable ou retirable jusqu'à
 * l'ouverture de son bilan, figé ensuite. Chiffré, jamais lu par l'assistant (le texte de l'écran le dit).
 */
export function NoteScreen() {
  const query = useApiQuery<{ partner: string; notes: NoteView[] }>("/api/family/notes");
  const mutation = useApiMutation();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const data = query.data;
  const partner = data?.partner ?? "votre partenaire";
  const blocked = !draft.trim() || [...draft].length > MAX;

  async function save() {
    if (blocked) return;
    const result = editing
      ? await mutation.run<{ note: NoteView }>(`/api/family/notes/${editing}`, { method: "PATCH", body: { text: draft } })
      : await mutation.run<{ note: NoteView }>("/api/family/notes", { method: "POST", body: { text: draft } });
    if (!result) return;
    setDraft("");
    setEditing(null);
    query.reload();
  }
  async function remove(id: string) {
    const done = await mutation.run(`/api/family/notes/${id}`, { method: "DELETE" });
    if (done === undefined) return;
    if (editing === id) {
      setEditing(null);
      setDraft("");
    }
    query.reload();
  }

  const waiting = data?.notes.filter((n) => !n.frozen) ?? [];
  const read = data?.notes.filter((n) => n.frozen) ?? [];
  const forbidden = query.error?.body?.code === "forbidden";

  return (
    <AppShell title={`Un mot pour ${partner}`} back={{ href: "/assistant/bilan", label: "Bilan" }}>
      {query.loading && !data && <Loading slow={query.slow} />}
      {forbidden && <Notice tone="info">Les mots sont réservés aux deux parents du couple.</Notice>}
      {query.error && !forbidden && <RetryNotice message={query.error.message} onRetry={query.reload} />}
      {data && (
        <>
          <p className={styles.noteMeta} style={{ fontSize: 13, lineHeight: 1.5 }}>
            Un merci, un ressenti, ce que vous voulez. {partner} le lira dans son bilan de dimanche, sans en être prévenu avant. Ce mot reste entre vous deux : il n&apos;est jamais lu par l&apos;assistant.
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label htmlFor="mot" style={{ fontSize: 12, fontWeight: 700 }}>
              {editing ? "Modifier votre mot" : waiting.length > 0 ? "Ajouter un autre mot" : "Votre mot"}
            </label>
            <textarea id="mot" className={styles.noteInput} value={draft} maxLength={MAX} placeholder="ex. Merci d'avoir géré la réunion de jeudi." onChange={(e) => setDraft(e.target.value)} />
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span className={styles.noteMeta}>
                {[...draft].length} / {MAX}
              </span>
              <div className={styles.row2}>
                {editing && (
                  <button type="button" className={styles.small} onClick={() => { setEditing(null); setDraft(""); }}>
                    Annuler
                  </button>
                )}
                <button type="button" className={styles.smallPrimary} disabled={blocked || mutation.pending} onClick={() => void save()}>
                  {editing ? "Enregistrer" : "Garder pour son bilan"}
                </button>
              </div>
            </div>
            {mutation.error && <Notice tone="error">{mutation.error.kind === "rejected" ? mutation.error.message : "Le mot n'a pas pu être enregistré : réessayez."}</Notice>}
          </div>

          {waiting.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className={styles.kick}>En attente de son bilan · modifiable jusqu&apos;à ce qu&apos;il l&apos;ouvre</div>
              {waiting.map((n) => (
                <div key={n.id} className={styles.noteCard}>
                  <div className={styles.motText}>{n.text}</div>
                  <div className={styles.noteMeta}>Écrit {stamp(n.createdAt)}</div>
                  <div className={styles.row2}>
                    <button type="button" className={styles.small} onClick={() => { setEditing(n.id); setDraft(n.text); }}>
                      Modifier
                    </button>
                    <button type="button" className={styles.small} style={{ color: "var(--ink-soft)" }} disabled={mutation.pending} onClick={() => void remove(n.id)}>
                      Retirer
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
          {read.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className={styles.kick}>Lu par {partner} dans son bilan</div>
              {read.map((n) => (
                <div key={n.id} className={styles.noteCard}>
                  <div className={styles.motText}>{n.text}</div>
                  <div className={styles.noteMeta}>Écrit {stamp(n.createdAt)} · ne peut plus être modifié</div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}
