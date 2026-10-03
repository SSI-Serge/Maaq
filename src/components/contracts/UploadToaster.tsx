"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { dismissNotice, useNotices } from "@/client/notices";
import { dismissUpload, onUploadDone, retryUpload, useUploads } from "@/client/uploads";
import styles from "./contracts.module.css";

/**
 * Messages de fin de traitement en arrière-plan, sur n'importe quel écran (US-34 RF10, US-63 RF11, CC-10) :
 * « Document ajouté à [contrat] », « Message transmis au support », et l'échec d'un envoi quand le profil n'est plus sur la page Contrats.
 */
export function UploadToaster() {
  const pathname = usePathname();
  const jobs = useUploads();
  const notices = useNotices();
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
  if (added.length === 0 && failed.length === 0 && notices.length === 0) return null;

  return (
    <div className={styles.toast} role="status" aria-live="polite">
      {added.map((toast) => (
        <div key={toast.id} className={`${styles.toastItem} ${styles.toastOk}`}>
          ✓ {toast.text}
        </div>
      ))}
      {notices.map((notice) => (
        <div key={notice.id} className={`${styles.toastItem} ${notice.tone === "success" ? styles.toastOk : styles.toastError}`} role={notice.tone === "error" ? "alert" : "status"}>
          <span>{notice.tone === "success" ? "✓ " : ""}{notice.text}</span>
          <button onClick={() => dismissNotice(notice.id)}>Fermer</button>
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
