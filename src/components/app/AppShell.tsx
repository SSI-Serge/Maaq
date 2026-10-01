"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useSessionUser } from "@/components/auth/AuthGate";
import styles from "./app.module.css";

interface Tab {
  href: string;
  label: string;
  icon: ReactNode;
  /** Onglet visible seulement pour l'utilisateur principal. */
  primaryOnly?: boolean;
}

/** Onglets du bas de l'application, d'après les maquettes. L'onglet Contrats arrivera au lot 7. */
const TABS: Tab[] = [
  { href: "/accueil", label: "Agents", icon: <path d="M4 5h16v11H8l-4 4V5z" /> },
  {
    href: "/invites",
    label: "Invités",
    primaryOnly: true,
    icon: (
      <>
        <circle cx="9" cy="8" r="3" />
        <path d="M2 20c0-3.5 3-6 7-6s7 2.5 7 6" />
        <circle cx="17" cy="9" r="2.5" />
        <path d="M16 14c2.8 0 5 2 5 5" />
      </>
    ),
  },
  {
    href: "/reglages",
    label: "Réglages",
    icon: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4" />
      </>
    ),
  },
];

/** Écran de l'application mobile : en-tête, contenu défilant et onglets en bas. */
export function AppShell({
  title,
  subtitle,
  back,
  action,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  back?: { href: string; label: string };
  action?: ReactNode;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const user = useSessionUser();
  const tabs = TABS.filter((tab) => !tab.primaryOnly || user.role === "primary_user");

  return (
    <div className={styles.app}>
      <header className={styles.header}>
        {back && (
          <Link href={back.href} className={styles.back}>
            ‹ {back.label}
          </Link>
        )}
        <div className={styles.headerRow}>
          <h1 className={styles.title}>{title}</h1>
          {action}
        </div>
        {subtitle && <p className={styles.subtitle}>{subtitle}</p>}
      </header>
      <div className={styles.content}>{children}</div>
      <nav className={styles.tabs} aria-label="Navigation principale">
        {tabs.map((tab) => {
          const active = pathname.startsWith(tab.href);
          return (
            <Link key={tab.href} href={tab.href} className={`${styles.tab} ${active ? styles.tabActive : ""}`} aria-current={active ? "page" : undefined}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
                {tab.icon}
              </svg>
              {tab.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

/** Carte de section (Réglages, invités…). */
export function Section({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <div className={styles.sectionTitle}>{title}</div>
        {action}
      </div>
      {children}
    </section>
  );
}

export { styles as appStyles };
