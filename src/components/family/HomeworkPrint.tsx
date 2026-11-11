"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useApiQuery } from "@/client/hooks";
import { Loading, Notice } from "@/components/ui";
import type { WeekItemView, WeekView } from "@/server/assistant/homework/weeks";
import { DAY_LONG, DOMAIN_LABEL, dayDate, weekRange, weekTitle } from "./homework-domains";
import print from "./homework-print.module.css";

const DAYS = [1, 2, 3, 4, 5, 6, 7];

/**
 * Version imprimable (US-119 RF4, CA 4.2, maquette RDV-Devoirs-Semaine) : pour chaque enfant, une page A4 paysage avec les sept colonnes et des cases ☐, puis une page de cartes
 * illustrées à découper. Polices et couleurs de la charte de l'application. Pas de barre de progression ni de compteur (AT-9). La boîte d'impression s'ouvre à l'arrivée sur la page.
 */
export function HomeworkPrintScreen({ id }: { id: string }) {
  const query = useApiQuery<{ week: WeekView }>(`/api/family/homework/weeks/${id}`);
  // Un enfant sans élément cette semaine a une page à l'écran, mais pas de feuille à imprimer.
  const loaded = query.data?.week;
  const week = loaded ? { ...loaded, children: loaded.children.filter((c) => c.items.length > 0) } : undefined;
  const ready = Boolean(week);
  useEffect(() => {
    if (ready) {
      const timer = setTimeout(() => window.print(), 600);
      return () => clearTimeout(timer);
    }
  }, [ready]);
  if (query.loading && !week) return <Loading slow={query.slow} />;
  if (!week) return <Notice tone="info">Cette page n&apos;existe plus ou ne vous est pas accessible.</Notice>;
  const sheetNumber = (childIndex: number, withCards: boolean[]) => 1 + withCards.slice(0, childIndex).reduce((n, has) => n + 1 + (has ? 1 : 0), 0);
  const hasCards = week.children.map((c) => c.items.some((i) => i.card));
  return (
    <div className={print.root}>
      <style>{"@page { size: A4 landscape; margin: 9mm; }"}</style>
      <div className={`${print.toolbar} no-print`}>
        <Link href={`/assistant/devoirs/${week.id}`} className={print.link}>
          ‹ Retour à la semaine
        </Link>
        <p className={print.note}>Aperçu avant impression : une page A4 paysage par enfant, puis ses cartes d&apos;activité à découper.</p>
        <button type="button" className={print.button} onClick={() => window.print()}>
          Imprimer
        </button>
      </div>
      {week.children.map((child, index) => {
        const cards = child.items.filter((i) => i.card);
        const page = sheetNumber(index, hasCards);
        return (
          <div key={child.memberId} className={print.kid}>
            <div className={`${print.pageLabel} no-print`}>Page {page} · A4 paysage</div>
            <div className={print.scroll}>
              <section className={print.sheet} aria-label={`Semaine de ${child.firstName}`}>
                <header className={print.head}>
                  <span className={print.name}>
                    {child.firstName} · {weekTitle(week.weekStart).toLowerCase()}
                  </span>
                  <span className={print.range}>{weekRange(week.weekStart, week.weekEnd)}</span>
                  <span className={print.level}>{child.levelLabel}</span>
                </header>
                <div className={print.cols}>
                  {DAYS.map((day) => {
                    const items = child.items.filter((i) => i.day === day);
                    const working = week.workDays.includes(day);
                    return (
                      <div key={day} className={`${print.col} ${!working && items.length === 0 ? print.rest : ""}`}>
                        <div className={print.dayHead}>
                          <span>{DAY_LONG[day - 1]}</span>
                          <small>{dayDate(week.weekStart, day)}</small>
                        </div>
                        {items.length === 0 && <div className={print.empty}>{working ? "Libre" : "Repos"}</div>}
                        {items.map((item) => (
                          <PrintItem key={item.id} item={item} />
                        ))}
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>
            {cards.length > 0 && (
              <>
                <div className={`${print.pageLabel} no-print`}>Page {page + 1} · cartes à découper</div>
                <div className={print.scroll}>
                  <section className={`${print.sheet} ${print.cardsSheet}`} aria-label={`Cartes de ${child.firstName}`}>
                    <header className={print.head}>
                      <span className={print.name}>Cartes à découper · {child.firstName}</span>
                    </header>
                    <div className={print.cards}>
                      {cards.map((item) => (
                        <figure key={item.id} className={print.cardFig}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={item.card!} alt={`Carte : ${item.title}`} />
                          <figcaption>
                            {DAY_LONG[item.day - 1]} · {item.title}
                          </figcaption>
                        </figure>
                      ))}
                    </div>
                  </section>
                </div>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

function PrintItem({ item }: { item: WeekItemView }) {
  return (
    <div className={print.item}>
      <span className={print.box} aria-hidden>
        ☐
      </span>
      <div>
        <span className={print.chip} style={{ ["--k" as string]: `var(--c-${item.domain})` }}>
          {DOMAIN_LABEL[item.domain]}
        </span>
        <span className={print.title}>{item.title}</span>
        {item.needsAdult && <div className={print.meta}>avec un adulte</div>}
        {item.kind === "exercise" && item.statement && <div className={print.meta}>{item.statement}</div>}
      </div>
    </div>
  );
}
