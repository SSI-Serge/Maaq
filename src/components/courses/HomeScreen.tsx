"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { useApiQuery } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import family from "@/components/family/family.module.css";
import { Loading, Notice, RetryNotice } from "@/components/ui";
import type { CourseHome } from "@/server/courses/home";
import { ChatPanel } from "./ChatPanel";
import styles from "./courses.module.css";

const BACK = { href: "/accueil", label: "Agents" };

/** Parcours de l'accueil ; ceux dont l'écran n'existe pas encore restent cachés (`ready`), pour ne jamais mener à une page vide. */
const PATHS: { label: string; href: string; ready: boolean; couple: boolean; chat?: "menu" | "ticket" }[] = [
  // ces deux parcours se déroulent dans le tchat (MENU_IA ouvert) ; fermé, ils sont cachés (pas de menu de secours, CR-44)
  { label: "Liste de courses et menu de la semaine", href: "/courses?menu=1", ready: true, couple: true, chat: "menu" },
  { label: "Ajouter un produit", href: "/courses/liste", ready: true, couple: true },
  { label: "Ajouter un plat", href: "/courses/plats/nouveau", ready: true, couple: true },
  { label: "Menu à partir d'un ticket", href: "/courses?depuis=ticket", ready: true, couple: true, chat: "ticket" },
  { label: "Enregistrer un ticket", href: "/courses/ticket", ready: true, couple: true },
  { label: "Mettre à jour la liste après un achat", href: "/courses/ma-liste", ready: true, couple: true },
  { label: "Budget par rayon", href: "/courses/budget", ready: true, couple: true },
];

/** Accueil de l'agent « Courses et repas » : ma liste, ce que l'autre parent a ajouté, les parcours (CR-Tchat). */
export function CoursesHomeScreen() {
  const query = useApiQuery<{ home: CourseHome }>("/api/courses/home");
  const forbidden = query.error?.body?.code === "forbidden";
  return (
    <AppShell title="Courses et repas" eyebrow="Assistant · Perso" back={BACK}>
      {query.loading && !query.data && <Loading slow={query.slow} />}
      {forbidden && <Notice tone="info">Courses et repas est réservé aux membres du foyer.</Notice>}
      {query.error && !forbidden && <RetryNotice message={query.error.message} onRetry={query.reload} />}
      {query.data && (
        <Suspense fallback={<Loading />}>
          <Home home={query.data.home} />
        </Suspense>
      )}
    </AppShell>
  );
}

function Home({ home }: { home: CourseHome }) {
  const couple = home.access === "couple";
  // menu composé en conversation (MENU_IA ouvert) : le premier parcours ouvre le tchat plutôt que l'ancien écran
  // arrivée par un lien (« Préparer le menu », « Menu à partir de ce ticket ») : le tchat prend la suite dès l'ouverture
  const params = useSearchParams();
  const wantTicket = home.menuIa && params.get("depuis") === "ticket";
  const wantMenu = home.menuIa && !wantTicket && params.get("menu") === "1";
  const [startMenu, setStartMenu] = useState(wantMenu ? 1 : 0);
  const [fromTicket, setFromTicket] = useState(wantTicket ? 1 : 0);
  const paths = couple ? PATHS.filter((p) => p.ready && (!p.chat || home.menuIa)) : [{ label: "Ajouter un produit", href: "/courses/liste", ready: true, couple: false }, { label: "Voir ma liste de courses", href: "/courses/ma-liste", ready: true, couple: false }];
  return (
    <>
      {couple && (
        <div className={styles.tools} style={{ justifyContent: "flex-end" }}>
          <Link href="/courses/reglages" className={styles.link} aria-label="Réglages du foyer">
            Réglages du foyer
          </Link>
        </div>
      )}
      <Link href="/courses/ma-liste" className={styles.scenarioCard} style={{ background: "var(--primary-soft)" }}>
        <span>
          <div className={styles.lineName}>Ma liste de courses</div>
          <div className={styles.lineSub}>
            {home.list
              ? couple
                ? `Validée ${home.list.validatedDay} · ${home.list.products} produit${home.list.products > 1 ? "s" : ""}${home.list.stores ? ` · ${home.list.stores} magasin${home.list.stores > 1 ? "s" : ""}` : ""}`
                : `Validée ${home.list.validatedDay} · ${home.list.products} produit${home.list.products > 1 ? "s" : ""}`
              : "Aucune liste validée pour l'instant"}
          </div>
        </span>
        <span aria-hidden="true">›</span>
      </Link>

      {couple && home.missing.length > 0 && (
        <div className={styles.dayCard}>
          <div className={styles.lineName}>Bienvenue !</div>
          <p className={styles.lead} style={{ margin: 0 }}>
            Quelques questions, une seule fois, pour vous proposer des menus qui vous ressemblent : la ville, le nombre de personnes à table, les jours de courses et vos objectifs.
          </p>
          <Link href="/courses/reglages" className={styles.link}>
            Renseigner les réglages ›
          </Link>
        </div>
      )}

      <div className={styles.dayCard}>
        <p className={styles.lead} style={{ margin: 0 }}>
          {couple
            ? `Bonjour ${home.firstName} !${home.addedByOthers ? ` Depuis la dernière fois, ${home.addedByOthers.by} a ajouté ${home.addedByOthers.names.join(", ")}.` : ""} Que voulez-vous faire ?`
            : `Bonjour ${home.firstName} ! Vous pouvez consulter la liste de courses et y ajouter un produit.`}
        </p>
      </div>
      {home.budgetDay && (
        <p className={styles.banner}>
          C&apos;est le jour de votre budget : voulez-vous le voir ? <Link href="/courses/budget">Voir le budget ›</Link>
        </p>
      )}

      <nav aria-label="Parcours" className={family.form}>
        {paths.map((p) =>
          p.chat ? (
            <button
              key={p.label}
              type="button"
              onClick={() => (p.chat === "menu" ? setStartMenu((n) => n + 1) : setFromTicket((n) => n + 1))}
              className={styles.scenarioCard}
              style={{ minHeight: 44, background: "var(--primary)", borderColor: "var(--primary)", color: "var(--primary-ink)", textAlign: "left", cursor: "pointer" }}
            >
              <span>{p.label}</span>
              <span aria-hidden="true">›</span>
            </button>
          ) : (
          <Link key={p.label} href={p.href} className={styles.scenarioCard} style={{ minHeight: 44, borderColor: "var(--primary)", color: "var(--primary)" }}>
            <span>{p.label}</span>
            <span aria-hidden="true">›</span>
          </Link>
          ),
        )}
      </nav>
      <ChatPanel couple={couple} startMenu={startMenu} fromTicket={fromTicket} />
    </>
  );
}
