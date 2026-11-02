"use client";

import { useState } from "react";
import { Button, Loading, Notice } from "@/components/ui";
import { photoWarning } from "@/server/assistant/homework/photo-text";
import type { PhotoResult } from "@/server/assistant/homework/photos";
import type { WeekChildView } from "@/server/assistant/homework/weeks";
import styles from "./family.module.css";

/** Largeur maximale d'une photo envoyée : assez pour lire une feuille, assez petite pour un envoi rapide et peu de jetons. */
const PHOTO_MAX_SIDE = 1600;

/** Réduit la photo (JPEG, 1600 px au plus) avant l'envoi ; un navigateur qui ne sait pas le faire envoie le fichier tel quel. */
async function shrink(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    return blob ?? file;
  } catch {
    return file;
  }
}

/**
 * Photo du travail d'un enfant (US-119 RF5) : le message qui prévient que la photo sera supprimée est affiché AVANT le choix du fichier (CA 5.1). L'aide dit ce qui est réussi
 * ou à revoir, puis confirme « Progrès de [prénom] notés. La photo a été supprimée. » (CA 5.2). Seules les photos valident : une case cochée ne valide rien (RF6).
 */
export function PhotoPanel({ weekId, child, onDone }: { weekId: string; child: WeekChildView; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "error">("idle");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<PhotoResult | null>(null);

  async function send(file: File) {
    setState("sending");
    setResult(null);
    const form = new FormData();
    form.set("memberId", child.memberId);
    form.set("weekId", weekId);
    form.set("photo", await shrink(file), "photo.jpg");
    try {
      const response = await fetch("/api/family/homework/photos", { method: "POST", body: form, credentials: "same-origin", signal: AbortSignal.timeout(90_000) });
      const body = (await response.json().catch(() => null)) as { result?: PhotoResult; error?: { message?: string } } | null;
      if (!response.ok || !body?.result) {
        setMessage(body?.error?.message ?? "La photo n'a pas pu être analysée. Elle n'a pas été conservée : réessayez.");
        setState("error");
        return;
      }
      setResult(body.result);
      setState("idle");
      onDone();
    } catch {
      setMessage("La photo n'a pas pu être envoyée. Elle n'a pas été conservée : réessayez.");
      setState("error");
    }
  }

  if (!open)
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Envoyer une photo du travail de {child.firstName}
      </Button>
    );
  return (
    <div className={styles.form}>
      <Notice tone="info">{photoWarning(child.firstName)}</Notice>
      <input type="file" accept="image/*" aria-label={`Photo du travail de ${child.firstName}`} disabled={state === "sending"} onChange={(e) => e.target.files?.[0] && void send(e.target.files[0])} />
      {state === "sending" && <Loading label="Analyse de la photo…" />}
      {state === "error" && <Notice tone="error">{message}</Notice>}
      {result && (
        <Notice tone="success">
          {result.comment && <p>{result.comment}</p>}
          <p>{result.confirmation}</p>
        </Notice>
      )}
      <Button variant="ghost" onClick={() => setOpen(false)} disabled={state === "sending"}>
        Fermer
      </Button>
    </div>
  );
}
