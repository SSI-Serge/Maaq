"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { dismissUpload, onUploadDone, retryUpload, useUploads } from "@/client/uploads";
import styles from "./contracts.module.css";

/**
 * Messages de fin d'envoi, sur n'importe quel écran (US-34 RF10, CC-10) : « Document ajouté à [contrat] »,
 * et l'échec d'un envoi quand le profil n'est plus sur la page Contrats.
 */
export function UploadToaster() {
  const pathname = usePathname();
  const jobs = useUploads();
  const [added, setAdded] = useState<{ id: string; text: string }[]>([]);

  useEffect(
    () =>
      onUploadDone((job) => {
        setAdded((list) => [...list, { id: job.id, text: `Document ajouté à ${job.contractName}` }]);
        setTimeout(() => setAdded((list) => list.filter((t) => t.id !== job.id)), 5_000);
        setTimeout(() => dismissUpload(job.id), 5_000);
      }),
    [],
  );

  const failed = pathname.startsWith("/contrats") ? [] : jobs.filter((j) => j.state === "failed" || j.state === "stalled" || j.state === "rejected");
  if (added.length === 0 && failed.length === 0) return null;

  return (
    <div className={styles.toast} role="status" aria-live="polite">
      {added.map((toast) => (
        <div key={toast.id} className={`${styles.toastItem} ${styles.toastOk}`}>
          ✓ {toast.text}
        </div>
      ))}
      {failed.map((job) => (
        <div key={job.id} className={`${styles.toastItem} ${styles.toastError}`} role="alert">
          <span>
            {job.message} ({job.fileName})
          </span>
          <span style={{ display: "flex", gap: 10 }}>
            {job.state !== "rejected" && <button onClick={() => retryUpload(job.id)}>Réessayer</button>}
            <button onClick={() => dismissUpload(job.id)}>Fermer</button>
          </span>
        </div>
      ))}
    </div>
  );
}
