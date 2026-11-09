"use client";

import { useState } from "react";
import { useApiMutation } from "@/client/hooks";
import family from "@/components/family/family.module.css";
import { Button, Notice } from "@/components/ui";
import type { WeekChoice } from "@/server/courses/list/weeks";
import styles from "./courses.module.css";

/** Choix de la semaine (CR-54, CR-56) : « Cette semaine », puis « Semaine du 16 au 22 nov. »… ; au-delà de trois semaines, les boutons défilent horizontalement. */
export function WeekSelector({ weeks, week, onChange }: { weeks: WeekChoice[]; week: string | null; onChange: (week: string) => void }) {
  return (
    <div className={family.wrapRow} role="group" aria-label="Semaine" style={weeks.length > 3 ? { flexWrap: "nowrap", overflowX: "auto", paddingBottom: 6 } : undefined}>
      {weeks.map((w) => (
        <button key={w.week} type="button" className={family.chipToggle} style={weeks.length > 3 ? { flex: "0 0 auto", whiteSpace: "nowrap" } : undefined} aria-pressed={w.week === week} onClick={() => onChange(w.week)}>
          {w.label}
        </button>
      ))}
    </div>
  );
}

/** Lundi de la semaine dans l'adresse de la page (`?week=`), pour qu'un lien du tchat ouvre la bonne semaine. */
export function weekFromLocation(): string | null {
  if (typeof window === "undefined") return null;
  const value = new URLSearchParams(window.location.search).get("week");
  return value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : null;
}

/** « scope=group » dans l'adresse : Ma liste s'ouvre sur la liste du mois (CR-56). */
export function scopeFromLocation(): "week" | "group" {
  if (typeof window === "undefined") return "week";
  return new URLSearchParams(window.location.search).get("scope") === "group" ? "group" : "week";
}

/**
 * « Supprimer… » (couple seulement) : supprime définitivement le menu de la semaine (avec sa liste) ou seulement sa liste, après confirmation. Les tickets, les prix, « Mes plats »
 * et le plafond de menus du jour ne sont pas touchés.
 */
export function DeleteWeek({ week, weekText, hasList, onDone }: { week: string; weekText: string; hasList: boolean; onDone: () => void }) {
  const [asking, setAsking] = useState<null | "menu" | "list">(null);
  const [open, setOpen] = useState(false);
  const remove = useApiMutation();

  async function confirm(what: "menu" | "list") {
    if (await remove.run("/api/courses/list/delete", { method: "POST", body: { what, week } })) {
      setAsking(null);
      setOpen(false);
      onDone();
    }
  }

  if (!open) {
    return (
      <div className={styles.tools}>
        <Button variant="ghost" onClick={() => setOpen(true)}>
          Supprimer…
        </Button>
      </div>
    );
  }
  return (
    <section className={styles.dayCard} aria-label="Supprimer">
      <div className={styles.dayHead}>
        <span className={styles.dayName}>Supprimer · {weekText.replace(/^de la /, "")}</span>
        <button type="button" className={styles.link} onClick={() => { setOpen(false); setAsking(null); }}>
          Fermer
        </button>
      </div>
      {asking === null && (
        <>
          <p className={family.hint}>La suppression est définitive. Vos tickets et vos prix ne sont jamais supprimés.</p>
          <div className={family.wrapRow}>
            <Button variant="ghost" onClick={() => setAsking("menu")}>
              Supprimer le menu
            </Button>
            {hasList && (
              <Button variant="ghost" onClick={() => setAsking("list")}>
                Supprimer la liste
              </Button>
            )}
          </div>
        </>
      )}
      {asking === "menu" && (
        <>
          <p className={styles.confirm}>
            Supprimer définitivement le menu {weekText} ? Sa liste de courses est supprimée avec lui, produits déjà achetés et produits ajoutés à la main compris. Vos tickets, vos prix, les plats copiés dans « Mes plats » et le nombre de menus du jour ne changent pas. Cette action est définitive.
          </p>
          <div className={family.wrapRow}>
            <Button onClick={() => void confirm("menu")} loading={remove.pending}>
              Oui, supprimer le menu
            </Button>
            <Button variant="ghost" onClick={() => setAsking(null)}>
              Non, garder
            </Button>
          </div>
        </>
      )}
      {asking === "list" && (
        <>
          <p className={styles.confirm}>
            Supprimer définitivement la liste de courses {weekText} ? Le menu reste : la liste est recalculée à partir de lui et sera à valider de nouveau. Les produits ajoutés à la main pour cette semaine et les produits déjà achetés de cette liste sont supprimés. Cette action est définitive.
          </p>
          <div className={family.wrapRow}>
            <Button onClick={() => void confirm("list")} loading={remove.pending}>
              Oui, supprimer la liste
            </Button>
            <Button variant="ghost" onClick={() => setAsking(null)}>
              Non, garder
            </Button>
          </div>
        </>
      )}
      {remove.error && <Notice tone="error">{remove.error.message}</Notice>}
    </section>
  );
}
