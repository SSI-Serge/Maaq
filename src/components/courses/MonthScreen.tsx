"use client";

import Link from "next/link";
import { useState } from "react";
import { apiRequest } from "@/client/api";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import family from "@/components/family/family.module.css";
import { Button, Loading, Notice, RetryNotice } from "@/components/ui";
import type { ReplaceChoice, ReplaceKind, ReplaceOptions } from "@/server/courses/menu-ia/replace";
import type { MonthStatus, MonthValidated, MonthView } from "@/server/courses/month/service";
import { euro } from "./ListScreen";
import { DishRow, type ReplaceApi } from "./MenuCard";
import { DAY_LABELS, sessionText } from "./menu-text";
import styles from "./courses.module.css";

const BACK = { href: "/courses", label: "Courses et repas" };
const COMPOSE_TIMEOUT_MS = 140_000;

/** « Menu du mois dans le budget » (US-178) : 4 semaines composées par MAAQ, chiffrées et comparées au budget ; on consulte, on remplace un plat (sans IA), puis on valide les 4 menus. */
export function MonthScreen() {
  const query = useApiQuery<{ status: MonthStatus }>("/api/courses/month");
  const forbidden = query.error?.body?.code === "forbidden";
  return (
    <AppShell title="Menu du mois dans le budget" eyebrow="Courses et repas" back={BACK}>
      {query.loading && !query.data && <Loading slow={query.slow} />}
      {forbidden && <Notice tone="info">Le menu du mois est réservé aux deux parents du foyer.</Notice>}
      {query.error && !forbidden && <RetryNotice message={query.error.message} onRetry={query.reload} />}
      {query.data && <Month status={query.data.status} reload={query.reload} />}
    </AppShell>
  );
}

/** Euros entiers pour les totaux du mois (« 386 € pour 4 semaines »). */
const euro0 = (n: number) => `${Math.round(n)} €`;

const rangeOf = (week: string, last = false) => {
  const d = new Date(`${week}T12:00:00`);
  const end = new Date(d.getTime() + 6 * 86_400_000);
  const months = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
  void last;
  return d.getMonth() === end.getMonth() ? `du ${d.getDate()} au ${end.getDate()} ${months[end.getMonth()]}` : `du ${d.getDate()} ${months[d.getMonth()]} au ${end.getDate()} ${months[end.getMonth()]}`;
};

function Month({ status, reload }: { status: MonthStatus; reload: () => void }) {
  const [card, setCard] = useState<MonthView | null>(status.card);
  const [decisions, setDecisions] = useState<Record<string, "replace" | "keep">>({});
  const [done, setDone] = useState<MonthValidated | null>(null);
  const [budget, setBudget] = useState("");
  const [pendingWhat, setPendingWhat] = useState<string | null>(null);
  const compose = useApiMutation();
  const replace = useApiMutation();
  const validate = useApiMutation();
  const save = useApiMutation();
  const [ticked, setTicked] = useState<string[]>([]);
  const adding = useApiMutation();
  const [added, setAdded] = useState<string[] | null>(null);
  const writing = useApiMutation();
  const [writingWeek, setWritingWeek] = useState<string | null>(null);

  if (!status.ready) {
    return (
      <div className={styles.dayCard}>
        <p className={styles.lead} style={{ margin: 0 }}>
          Le menu du mois dans le budget s&apos;appuie sur vos habitudes. Il faut 6 menus validés (vous en avez {status.menus}) et vos tickets de caisse enregistrés, pour que MAAQ connaisse vos prix ({status.tickets} ticket{status.tickets > 1 ? "s" : ""} enregistré{status.tickets > 1 ? "s" : ""}).
        </p>
        <div className={family.wrapRow}>
          <Link href="/courses?menu=1" className={styles.scenarioCard} style={{ minHeight: 40, borderColor: "var(--primary)", color: "var(--primary)" }}>
            Composer un menu
          </Link>
          <Link href="/courses/ticket" className={styles.scenarioCard} style={{ minHeight: 40, borderColor: "var(--primary)", color: "var(--primary)" }}>
            Enregistrer un ticket
          </Link>
        </div>
      </div>
    );
  }

  if (status.budget === null) {
    return (
      <div className={styles.dayCard}>
        <p className={styles.lead} style={{ margin: 0 }}>
          Quel est votre budget mensuel des repas, hors restaurant, boissons et réceptions ?
        </p>
        <div className={styles.addRow}>
          <input className={family.input} inputMode="decimal" placeholder="Par exemple 420" aria-label="Budget mensuel des repas" value={budget} onChange={(e) => setBudget(e.target.value.replace(/[^0-9.,]/g, "").slice(0, 7))} />
          <Button
            loading={save.pending}
            disabled={!budget.trim()}
            onClick={async () => {
              if (await save.run("/api/courses/settings", { method: "PUT", body: { monthlyBudget: Number(budget.replace(",", ".")) } })) reload();
            }}
          >
            Enregistrer
          </Button>
        </div>
        {save.error && <Notice tone="error">{save.error.message}</Notice>}
      </div>
    );
  }

  async function run(body: Record<string, unknown>, what: string) {
    setPendingWhat(what);
    const result = await compose.run<{ card: MonthView }>("/api/courses/month", { method: "POST", body, timeoutMs: COMPOSE_TIMEOUT_MS });
    setPendingWhat(null);
    if (result) {
      setCard(result.card);
      setDecisions({});
      setDone(null);
    }
  }

  const replaceApiOf = (c: MonthView, week: string): ReplaceApi => ({
    options: async (kind: ReplaceKind, index: number) => {
      try {
        return (await apiRequest<{ options: ReplaceOptions }>("/api/courses/month", { method: "POST", body: { action: "options", messageId: c.messageId, week, kind, index } })).options;
      } catch {
        return null;
      }
    },
    replace: async (kind: ReplaceKind, index: number, choice: ReplaceChoice) => {
      const result = await replace.run<{ card: MonthView }>("/api/courses/month", { method: "POST", body: { action: "replace", messageId: c.messageId, week, kind, index, choice } });
      if (result) setCard(result.card);
      return !!result;
    },
  });

  async function validateAll(c: MonthView) {
    const keep = Object.entries(decisions).filter(([, v]) => v === "keep").map(([w]) => w);
    const result = await validate.run<{ result: MonthValidated }>("/api/courses/month", { method: "POST", body: { action: "validate", messageId: c.messageId, keep }, timeoutMs: COMPOSE_TIMEOUT_MS });
    if (result) setDone(result.result);
  }

  if (done && card) {
    const validatedText = done.validated.map((w) => rangeOf(w)).join(" ; ");
    return (
      <>
        <div className={styles.banner} role="status">
          <div style={{ fontWeight: 700 }}>
            ✓ {done.validated.length} menu{done.validated.length > 1 ? "s" : ""} enregistré{done.validated.length > 1 ? "s" : ""}
          </div>
          <div>
            Du {rangeOf(done.validated[0]).replace(/^du /, "").split(" au ")[0]} au {rangeOf(done.validated[done.validated.length - 1]).split(" au ")[1]}, pour {euro0(done.total)}. {done.validated.length > 1 ? "Leurs listes de courses sont prêtes." : "Sa liste de courses est prête."}
          </div>
          {done.kept.length > 0 && (
            <div>
              {done.kept.every((w) => card.existing.includes(w)) ? "Menu existant gardé" : "Non validée"} pour la semaine {done.kept.map((w) => rangeOf(w)).join(" ; ")}. Total recalculé : {euro0(done.total)} pour {done.validated.length} semaine{done.validated.length > 1 ? "s" : ""}.
            </div>
          )}
        </div>
        {done.groupWeeks.length >= 2 && (
          <Link href={`/courses/liste?group=${done.groupWeeks.join(",")}`} className={styles.scenarioCard} style={{ minHeight: 44, borderColor: "var(--primary)", color: "var(--primary)" }}>
            <span>Regrouper en une liste du mois</span>
            <span aria-hidden="true">›</span>
          </Link>
        )}
        {done.addable.length > 0 && added === null && (
          <div className={styles.dayCard}>
            <span className={styles.dayName}>Ajouter ces plats à vos plats ?</span>
            {done.addable.map((a) => {
              const id = `${a.week}|${a.slot}`;
              const on = ticked.includes(id);
              return (
                <label key={id} className={styles.choice}>
                  <input type="checkbox" checked={on} onChange={() => setTicked(on ? ticked.filter((x) => x !== id) : [...ticked, id])} />
                  <span>
                    {a.name} <span className={styles.meta}>· {rangeOf(a.week)}</span>
                  </span>
                </label>
              );
            })}
            <div className={family.wrapRow}>
              <Button variant="secondary" disabled={adding.pending} onClick={() => setAdded([])}>
                Non merci
              </Button>
              <Button
                loading={adding.pending}
                disabled={!ticked.length}
                onClick={async () => {
                  const names: string[] = [];
                  for (const week of [...new Set(ticked.map((t) => t.split("|")[0]))]) {
                    const slots = ticked.filter((t) => t.startsWith(`${week}|`)).map((t) => t.split("|")[1]);
                    const r = await adding.run<{ result: { added: string[] } }>("/api/courses/chat/menu/dishes", { method: "POST", body: { week, slots } });
                    if (r) names.push(...r.result.added);
                  }
                  setAdded(names);
                }}
              >
                Ajouter à mes plats
              </Button>
            </div>
            {adding.error && <Notice tone="error">{adding.error.message}</Notice>}
          </div>
        )}
        {added !== null && <p className={family.hint}>{added.length ? `C'est fait : ${added.join(", ")} ${added.length > 1 ? "entrent" : "entre"} dans « Mes plats ».` : "D'accord, aucun plat ajouté à « Mes plats »."}</p>}
        <Link href="/courses/liste" className={styles.link}>
          Ouvrir la liste de courses ›
        </Link>
      </>
    );
  }

  if (!card) {
    return (
      <div className={styles.dayCard}>
        <p className={styles.lead} style={{ margin: 0 }}>
          MAAQ compose 4 semaines de menus (7 dîners et 4 plats express chacune) avec vos plats habituels et des plats de saison, chiffrés avec vos prix, pour tenir dans votre budget de {euro(status.budget)}.
        </p>
        <Button onClick={() => void run({ action: "compose" }, "compose")} loading={compose.pending}>
          Composer le menu du mois
        </Button>
        {compose.pending && <span className={styles.meta}>{status.seasonIa ? "Je cherche des plats de saison… (jusqu'à deux minutes)" : "Je compose le menu du mois…"}</span>}
        {compose.error && <Notice tone="error">{compose.error.message}</Notice>}
      </div>
    );
  }

  const incomplete = card.weeks.filter((w) => !w.proposal.complete);
  const undecided = card.existing.filter((w) => !decisions[w]);
  const keepCount = Object.values(decisions).filter((v) => v === "keep").length;
  const toValidate = card.weeks.filter((w) => decisions[w.week] !== "keep");
  const blocked = toValidate.some((w) => !w.proposal.complete || w.proposal.blocked);

  return (
    <>
      <div className={styles.dayCard} role="status">
        <span className={styles.dayName}>
          {euro0(card.total)} pour 4 semaines · budget {euro0(card.budget)}
        </span>
        {card.overBy !== null ? (
          <>
            <span style={{ fontWeight: 700, fontSize: 13 }}>Dépasse votre budget de {euro0(card.overBy)}</span>
            {card.expensive.length > 0 && <span className={styles.meta}>Les {card.expensive.length} plats les plus chers sont signalés : remplacez-les.</span>}
          </>
        ) : (
          <span className={styles.meta}>Dans votre budget.</span>
        )}
        {card.unpricedProducts > 0 && (
          <span className={styles.meta}>
            {card.unpricedProducts} produit{card.unpricedProducts > 1 ? "s" : ""} sans prix connu : non compté{card.unpricedProducts > 1 ? "s" : ""} dans le total.
            {!card.notes.sharing ? " Partagez vos prix pour chiffrer plus de plats." : ""}
          </span>
        )}
        {card.notes.unusedOwn > 0 && <span className={styles.meta}>{card.notes.unusedOwn} de vos plats n&apos;{card.notes.unusedOwn > 1 ? "ont" : "a"} jamais été dans un menu : {card.notes.unusedOwn > 1 ? "ils ne sont pas proposés" : "il n'est pas proposé"}.</span>}
        {card.notes.seasonUnavailable && <span className={styles.meta}>Plats de saison indisponibles : menu calculé avec vos plats.</span>}
        {card.notes.missingDinners > 0 && (
          <span style={{ fontWeight: 700, fontSize: 13 }}>
            Pas assez de plats pour 4 semaines : {card.notes.missingDinners} dîner{card.notes.missingDinners > 1 ? "s" : ""} reste{card.notes.missingDinners > 1 ? "nt" : ""} à choisir.
          </span>
        )}
      </div>

      {card.weeks.map((w) => (
        <section key={w.week} className={styles.dayCard} aria-label={`Semaine ${rangeOf(w.week)}`}>
          <div className={styles.dayHead}>
            <span className={styles.dayName}>Semaine {rangeOf(w.week)}</span>
            <span className={styles.meta}>{euro(w.cost)}</span>
          </div>
          {!w.proposal.complete && <span style={{ fontSize: 12, fontWeight: 700 }}>Semaine incomplète : {7 - w.proposal.dinners.length} dîner{7 - w.proposal.dinners.length > 1 ? "s" : ""} à choisir ; elle ne se valide pas avec les autres.</span>}
          {w.proposal.dinners.map((d, i) => (
            <DishRow key={`${w.week}-d${i}-${d.name}`} day={DAY_LABELS[i] ?? ""} dish={d} kind="dinner" index={i} replacing={{ api: replaceApiOf(card, w.week), allowed: true }} flag={card.overBy !== null && card.expensive.some((e) => e.name === d.name) ? "Parmi les plus chers" : undefined} />
          ))}
          {w.proposal.express.length > 0 && <span className={styles.meta} style={{ textTransform: "uppercase", paddingTop: 6 }}>Plats express</span>}
          {w.proposal.express.map((d, i) => (
            <DishRow key={`${w.week}-x${i}-${d.name}`} day="Exp." dish={d} kind="express" index={i} replacing={{ api: replaceApiOf(card, w.week), allowed: true }} flag={card.overBy !== null && card.expensive.some((e) => e.name === d.name) ? "Parmi les plus chers" : undefined} />
          ))}
          <span className={styles.meta}>
            {sessionText(w.proposal)}
            {w.proposal.steps.length > 0 ? " Déroulé rédigé." : ""}
          </span>
          {status.seasonIa && w.proposal.complete && w.proposal.steps.length === 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
              <button
                type="button"
                disabled={writing.pending}
                className={styles.link}
                style={{ border: "1px solid var(--line)", borderRadius: 7, background: "transparent", minHeight: 32, padding: "0 10px", fontWeight: 700 }}
                onClick={async () => {
                  setWritingWeek(w.week);
                  const result = await writing.run<{ card: MonthView }>("/api/courses/month", { method: "POST", body: { action: "steps", messageId: card.messageId, week: w.week }, timeoutMs: COMPOSE_TIMEOUT_MS });
                  setWritingWeek(null);
                  if (result) setCard(result.card);
                }}
              >
                {writing.pending && writingWeek === w.week ? "Je rédige le déroulé…" : "Rédiger le déroulé"}
              </button>
              <span className={styles.meta}>Facultatif : l&apos;IA écrit le déroulé de la séance (compté dans la limite de menus).</span>
            </div>
          )}
          {!w.proposal.complete && !card.existing.includes(w.week) && (
            <div className={family.wrapRow}>
              <button type="button" className={family.chipToggle} aria-pressed={decisions[w.week] === "keep"} onClick={() => setDecisions((d) => ({ ...d, [w.week]: d[w.week] === "keep" ? "replace" : "keep" }))}>
                Laisser cette semaine de côté
              </button>
            </div>
          )}
          {card.existing.includes(w.week) && (
            <div className={family.wrapRow} role="group" aria-label={`Menu déjà validé pour la semaine ${rangeOf(w.week)}`}>
              <span className={styles.meta}>Un menu est déjà validé pour cette semaine.</span>
              {(["replace", "keep"] as const).map((choice) => (
                <button key={choice} type="button" className={family.chipToggle} aria-pressed={decisions[w.week] === choice} onClick={() => setDecisions((d) => ({ ...d, [w.week]: choice }))}>
                  {choice === "replace" ? "Remplacer" : "Garder le menu existant"}
                </button>
              ))}
            </div>
          )}
        </section>
      ))}

      {(compose.error || replace.error || validate.error || writing.error) && <Notice tone="error">{(compose.error ?? replace.error ?? validate.error ?? writing.error)!.message}</Notice>}
      {pendingWhat && <p className={styles.meta}>{pendingWhat === "more" && status.seasonIa ? "Je cherche des plats de saison…" : "Je compose le menu du mois…"}</p>}
      <div className={family.wrapRow}>
        <Button variant="ghost" disabled={compose.pending} onClick={() => void run({ action: "compose", startWeek: card.startWeek, variant: card.variant + 1, previous: card.messageId }, "next")}>
          Autre proposition
        </Button>
        {status.seasonIa && (
          <Button variant="ghost" disabled={compose.pending} onClick={() => void run({ action: "compose", startWeek: card.startWeek, variant: card.variant + 1, previous: card.messageId, more: true }, "more")}>
            Nouveaux plats de saison
          </Button>
        )}
      </div>
      {incomplete.length > 0 && keepCount < incomplete.length && <p className={family.hint}>Une semaine incomplète ne se valide pas : validez les autres, ou composez-la dans le tchat.</p>}
      <div className={styles.footer}>
        <Button block loading={validate.pending} disabled={compose.pending || undecided.length > 0 || toValidate.length === 0 || blocked} onClick={() => void validateAll(card)}>
          Valider les {toValidate.length === 4 ? "4 " : `${toValidate.length} `}menus
        </Button>
        {undecided.length > 0 && <span className={styles.meta}>Choisissez « Remplacer » ou « Garder le menu existant » pour chaque semaine déjà validée.</span>}
        {blocked && undecided.length === 0 && toValidate.length > 0 && <span className={styles.meta}>Une semaine est incomplète ou contient un conflit d&apos;allergie : remplacez le plat ou gardez la semaine existante.</span>}
      </div>
    </>
  );
}
