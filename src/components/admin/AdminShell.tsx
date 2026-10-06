"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, type ReactNode } from "react";
import styles from "./admin.module.css";

const NAV = [
  {
    href: "/admin/agents",
    label: "Agents",
    icon: (
      <>
        <rect x="3" y="4" width="18" height="6" rx="1.5" />
        <rect x="3" y="14" width="18" height="6" rx="1.5" />
      </>
    ),
  },
  {
    href: "/admin/contrats",
    label: "Contrats obligatoires",
    icon: (
      <>
        <path d="M7 3h8l4 4v14H7z" />
        <path d="M15 3v4h4M10 12h6M10 16h6" />
      </>
    ),
  },
  {
    href: "/admin/comptes",
    label: "Comptes",
    icon: (
      <>
        <circle cx="12" cy="8" r="3.5" />
        <path d="M5 20c0-3.5 3-6 7-6s7 2.5 7 6" />
      </>
    ),
  },
  {
    href: "/admin/parametres",
    label: "Paramètres",
    icon: (
      <>
        <path d="M10.3 3h3.4l.6 2.4a7 7 0 0 1 1.8 1l2.3-.9 1.7 3-1.8 1.6a7 7 0 0 1 0 2l1.8 1.6-1.7 3-2.3-.9a7 7 0 0 1-1.8 1L13.7 21h-3.4l-.6-2.4a7 7 0 0 1-1.8-1l-2.3.9-1.7-3 1.8-1.6a7 7 0 0 1 0-2L3.9 10l1.7-3 2.3.9a7 7 0 0 1 1.8-1z" />
        <circle cx="12" cy="12" r="2.6" />
      </>
    ),
  },
  {
    href: "/admin/reglages",
    label: "Réglages",
    icon: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
      </>
    ),
  },
];

/** Gabarit de la console : barre latérale de navigation et zone de contenu (maquettes Admin-*). */
export function AdminShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return (
    <div className={styles.shell}>
      <nav className={styles.sidebar} aria-label="Console d'administration">
        <div className={styles.brand}>
          <div className={styles.brandMark} aria-hidden>
            M
          </div>
          <div>
            <div className={styles.brandName}>MAAQ</div>
            <div className={styles.brandSub}>Administration</div>
          </div>
        </div>
        {NAV.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link key={item.href} href={item.href} className={`${styles.navLink} ${active ? styles.navActive : ""}`} aria-current={active ? "page" : undefined}>
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                {item.icon}
              </svg>
              {item.label}
            </Link>
          );
        })}
      </nav>
      <main className={styles.main}>{children}</main>
    </div>
  );
}

export function PageHead({ title, lead, action }: { title: string; lead?: ReactNode; action?: ReactNode }) {
  return (
    <div className={styles.pageHead}>
      <div>
        <h1 className={styles.pageTitle}>{title}</h1>
        {lead && <p className={styles.pageLead}>{lead}</p>}
      </div>
      {action}
    </div>
  );
}

export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className={styles.back}>
      ‹ {children}
    </Link>
  );
}

export function AdminDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <h2 className={styles.dialogTitle}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

export function formatDate(iso: string, withTime = true): string {
  return new Intl.DateTimeFormat("fr-FR", withTime ? { dateStyle: "short", timeStyle: "short" } : { dateStyle: "short" }).format(new Date(iso));
}

export { styles as adminStyles };
