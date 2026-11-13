"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { useApiQuery } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import family from "@/components/family/family.module.css";
import { Loading, Notice, RetryNotice } from "@/components/ui";
import type { CourseHome } from "@/server/courses/home";
import { ChatPanel } from "./ChatPanel";
import { takeMenuValidated } from "./validated-flag";
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

/**
 * Carte « Menu de la semaine », en premier sur l'accueil (maquette CR-Tchat v88) : la semaine, le nombre de repas, les 3 prochains repas ; un toucher ouvre le menu complet.
 * Sans menu validé cette semaine : « Préparer le menu de la semaine », qui ouvre le tchat. « Semaine suivante › » quand la semaine suivante a un menu validé.
 */
export function WeekMenuCard({ menu, nextWeek, canPrepare, onPrepare }: { menu: CourseHome["weekMenu"]; nextWeek: string | null; canPrepare: boolean; onPrepare: () => void }) {
  const plural = (n: number, one: string, many: string) => `${n} ${n > 1 ? many : one}`;
  return (
    <>
      {menu ? (
        <Link href={`/courses/menu?week=${menu.week}`} style={{ display: "flex", flexDirection: "column", gap: 6, background: "var(--bg-raised)", border: "1px solid var(--secondary)", borderRadius: "var(--radius)", padding: "12px 14px", color: "var(--ink)", textDecoration: "none" }}>
          <span style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
            <span style={{ fontFamily: "var(--font-mono, 'IBM Plex Mono', monospace)", fontSize: 10, letterSpacing: ".06em", textTransform: "uppercase", color: "var(--secondary-strong)" }}>Menu de la semaine</span>
            <span className={styles.meta}>
              {plural(menu.dinners, "dîner", "dîners")}
              {menu.express ? ` · ${menu.express} express` : ""}
            </span>
          </span>
          <span style={{ fontFamily: "var(--font-serif, 'Newsreader', serif)", fontSize: 17 }}>{menu.range.replace(/^d/, "D")}</span>
          {menu.next.map((m, i) => (
            <span key={i} style={{ display: "flex", gap: 8, fontSize: 13, borderTop: "1px solid var(--line)", paddingTop: 5 }}>
              <span style={{ width: 62, flexShrink: 0, fontWeight: 700, color: "var(--ink-soft)" }}>{m.day}</span>
              <span style={{ flex: 1 }}>{m.name}</span>
              {m.express && <span style={{ flexShrink: 0, fontSize: 10, fontWeight: 700, borderRadius: 100, padding: "2px 8px", background: "var(--bg-sunken)", color: "var(--ink-soft)" }}>express</span>}
            </span>
          ))}
          <span style={{ alignSelf: "flex-end", fontSize: 13, fontWeight: 700, color: "var(--primary)" }}>Voir le menu complet ›</span>
        </Link>
      ) : (
        canPrepare && (
          <button type="button" onClick={onPrepare} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, width: "100%", minHeight: 64, padding: "12px 14px", borderRadius: "var(--radius)", border: "none", background: "var(--primary)", color: "var(--primary-ink)", fontWeight: 700, fontSize: 18, textAlign: "left", cursor: "pointer" }}>
            <span>
              <span style={{ display: "block", fontFamily: "var(--font-serif, 'Newsreader', serif)", fontSize: 17 }}>Préparer le menu de la semaine</span>
              <span style={{ display: "block", fontSize: 12, fontWeight: 500, opacity: 0.85 }}>Aucun menu validé cette semaine.</span>
            </span>
            <span aria-hidden="true">›</span>
          </button>
        )
      )}
      {nextWeek && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: -4 }}>
          <Link href={`/courses/menu?week=${nextWeek}`} style={{ fontSize: 13, fontWeight: 700, color: "var(--primary)" }}>
            Semaine suivante ›
          </Link>
        </div>
      )}
    </>
  );
}

function Home({ home }: { home: CourseHome }) {
  const couple = home.access === "couple";
  // « Menu validé. Retrouvez-le en haut de l'accueil. » : 5 secondes, au retour sur l'accueil après une validation (CR-72)
  const [validatedNote, setValidatedNote] = useState(false);
  useEffect(() => {
    if (!takeMenuValidated()) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setValidatedNote(true);
    const timer = setTimeout(() => setValidatedNote(false), 5000);
    return () => clearTimeout(timer);
  }, []);
  // menu composé en conversation (MENU_IA ouvert) : le premier parcours ouvre le tchat plutôt que l'ancien écran
  // arrivée par un lien (« Préparer le menu », « Menu à partir de ce ticket ») : le tchat prend la suite dès l'ouverture
  const params = useSearchParams();
  const wantTicket = home.menuIa && params.get("depuis") === "ticket";
  const wantMenu = home.menuIa && !wantTicket && params.get("menu") === "1";
  const [startMenu, setStartMenu] = useState(wantMenu ? 1 : 0);
  const [fromTicket, setFromTicket] = useState(wantTicket ? 1 : 0);
  // « Menu du mois dans le budget » avant 6 menus validés : le toucher ouvre un message qui explique les conditions (CR-63)
  const [monthInfo, setMonthInfo] = useState(false);
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
      {couple && <WeekMenuCard menu={home.weekMenu} nextWeek={home.nextWeekMenu} canPrepare={home.menuIa && home.chat} onPrepare={() => setStartMenu((n) => n + 1)} />}
      {validatedNote && (
        <div role="status" style={{ position: "fixed", left: 16, right: 16, bottom: 84, zIndex: 12, maxWidth: 358, margin: "0 auto", background: "var(--ink)", color: "var(--primary-ink)", borderRadius: "var(--radius)", padding: "12px 14px", fontSize: 13, fontWeight: 600 }}>
          Menu validé. Retrouvez-le en haut de l&apos;accueil.
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
      {couple && home.month && (
        <>
          {home.month.ready ? (
            <Link href="/courses/menu-du-mois" className={styles.scenarioCard} style={{ minHeight: 44, borderColor: "var(--primary)", color: "var(--primary)" }}>
              <span>Menu du mois dans le budget</span>
              <span aria-hidden="true">›</span>
            </Link>
          ) : (
            <button type="button" aria-expanded={monthInfo} onClick={() => setMonthInfo((v) => !v)} className={styles.scenarioCard} style={{ minHeight: 44, borderColor: "var(--primary)", color: "var(--primary)", textAlign: "left", cursor: "pointer", background: "transparent" }}>
              <span>Menu du mois dans le budget</span>
              <span aria-hidden="true">›</span>
            </button>
          )}
          {monthInfo && !home.month.ready && (
            <div className={styles.dayCard} role="dialog" aria-label="Menu du mois dans le budget">
              <p className={styles.lead} style={{ margin: 0 }}>
                Le menu du mois dans le budget s&apos;appuie sur vos habitudes. Il faut {home.month.needed} menus validés (vous en avez {home.month.menus}) et vos tickets de caisse enregistrés, pour que MAAQ connaisse vos prix ({home.month.tickets} ticket{home.month.tickets > 1 ? "s" : ""} enregistré{home.month.tickets > 1 ? "s" : ""}).
              </p>
              <div className={family.wrapRow}>
                {home.menuIa && (
                  <button
                    type="button"
                    className={styles.scenarioCard}
                    style={{ minHeight: 40, background: "var(--primary)", borderColor: "var(--primary)", color: "var(--primary-ink)", cursor: "pointer" }}
                    onClick={() => {
                      setMonthInfo(false);
                      setStartMenu((n) => n + 1);
                    }}
                  >
                    Composer un menu
                  </button>
                )}
                <Link href="/courses/ticket" className={styles.scenarioCard} style={{ minHeight: 40, borderColor: "var(--primary)", color: "var(--primary)" }}>
                  Enregistrer un ticket
                </Link>
              </div>
            </div>
          )}
        </>
      )}
      {home.chat && <ChatPanel couple={couple} startMenu={startMenu} fromTicket={fromTicket} weeks={home.weeks} />}
    </>
  );
}
