"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Fragment, useEffect, useRef, useState } from "react";
import { useApiMutation, useApiQuery, useStreamAction } from "@/client/hooks";
import family from "@/components/family/family.module.css";
import { Button, Notice, RetryNotice } from "@/components/ui";
import { SCREENS, type ScreenKey } from "@/server/courses/chat/screens";
import type { CourseMessageView, CourseReply } from "@/server/courses/chat/service";
import type { CardView } from "@/server/courses/menu-ia/cards";
import type { MenuProgress } from "@/server/courses/menu-ia/progress";
import type { ValidatedMenuCard } from "@/server/courses/menu-ia/validate";
import type { WeekChoice } from "@/server/courses/list/weeks";
import type { OwnDish } from "@/server/courses/menu/dishes";
import { apiRequest } from "@/client/api";
import type { ReplaceChoice, ReplaceKind, ReplaceOptions } from "@/server/courses/menu-ia/replace";
import { AdjustCard } from "./AdjustCard";
import { MenuCard, type ReplaceApi } from "./MenuCard";
import { DAY_LABELS } from "./menu-text";
import styles from "./courses.module.css";

/** Un menu complet demande plus de 15 s : délai long avant le message de connexion lente (CC-3), comme pour la lecture des tickets. */
const CHAT_TIMEOUT_MS = 110_000;
const PAGE = 10;
const MENU_WORDS = /menu|plat|d[iî]ner|express|remplace|chang|semaine|batch|s[eé]ance|recette/i;

/** Texte d'une réponse de l'agent : les marqueurs `[[ecran:nom]]` deviennent des liens vers les écrans de l'application. */
function Rich({ text, couple }: { text: string; couple: boolean }) {
  const parts = text.split(/(\[\[ecran:[a-z_]+\]\])/g);
  return (
    <>
      {parts.map((part, i) => {
        const key = /^\[\[ecran:([a-z_]+)\]\]$/.exec(part)?.[1] as ScreenKey | undefined;
        const screen = key ? SCREENS[key] : undefined;
        if (!screen || (screen.couple && !couple)) return <Fragment key={i}>{key ? "" : part}</Fragment>;
        return (
          <Link key={i} href={screen.href} className={styles.link} style={{ fontWeight: 700 }}>
            {screen.label} ›
          </Link>
        );
      })}
    </>
  );
}

/**
 * Tchat de l'agent « Courses et repas » (CR-Tchat) : bandeau « Vous échangez avec une IA », fil des échanges (4 jours), zone de saisie et bouton appareil photo vers l'écran des
 * tickets. Le menu de la semaine se compose ici, en conversation : choix de 1 ou 2 plats de « Mes plats », échange libre avec l'IA, menu en carte avec « Valider le menu » (CR-42).
 * `startMenu` : compteur incrémenté par le bouton « Liste de courses et menu de la semaine » de l'accueil.
 */
export function ChatPanel({ couple, startMenu = 0, fromTicket = 0, weeks = [] }: { couple: boolean; startMenu?: number; fromTicket?: number; weeks?: WeekChoice[] }) {
  const history = useApiQuery<{ messages: CourseMessageView[] }>("/api/courses/chat");
  const send = useStreamAction<CourseReply, MenuProgress>("/api/courses/chat", CHAT_TIMEOUT_MS);
  const validate = useApiMutation();
  const adding = useApiMutation();
  const replacing = useApiMutation();
  const adjusting = useApiMutation();
  const [adjustingId, setAdjustingId] = useState<string | null>(null);
  const router = useRouter();
  const [text, setText] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const request = useRef<string>(crypto.randomUUID());
  const lastText = useRef("");
  const end = useRef<HTMLDivElement>(null);
  const messages = history.data?.messages ?? [];

  // parcours « Liste de courses et menu de la semaine » : 1 ou 2 plats de Mes plats, ou un plat écrit
  const [starter, setStarter] = useState(false);
  // semaine du menu (CR-54) : demandée au départ du parcours, puis envoyée avec chaque message tant que la conversation reste ouverte
  const [week, setWeek] = useState<string | null>(null);
  const [fromReceipt, setFromReceipt] = useState(false);
  const weekLabel = weeks.find((w) => w.week === week)?.range ?? "";
  const [picks, setPicks] = useState<string[]>([]);
  const [shown, setShown] = useState(PAGE);
  const [validating, setValidating] = useState<string | null>(null);
  const [validated, setValidated] = useState<ValidatedMenuCard | null>(null);
  const own = useApiQuery<{ form: { dishes: OwnDish[] } }>(starter ? "/api/courses/dishes" : null);
  const dishes = own.data?.form.dishes ?? [];
  const lastStart = useRef(0);

  useEffect(() => {
    if (startMenu > lastStart.current) {
      lastStart.current = startMenu;
      setStarter(true);
      setFromReceipt(false);
      setWeek(null);
      setPicks([]);
      setShown(PAGE);
    }
  }, [startMenu]);

  // « Menu à partir d'un ticket » : le tchat lance le menu avec les produits du dernier ticket (l'agent les lit lui-même, sans prix)
  const lastTicket = useRef(0);
  useEffect(() => {
    if (fromTicket > lastTicket.current) {
      lastTicket.current = fromTicket;
      // le parcours commence aussi par « Pour quelle semaine ? » ; le menu part dès que la semaine est choisie
      setStarter(true);
      setFromReceipt(true);
      setWeek(null);
    }
  }, [fromTicket]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages.length, pending, starter]);

  const hasOpenCard = messages.some((m) => m.card?.status === "open" || m.card?.status === "incomplete");
  const menuIntent = starter || hasOpenCard || MENU_WORDS.test(pending ?? "");

  async function submit(override?: string, forcedWeek?: string) {
    const value = (override ?? text).trim();
    if (!value || send.pending) return;
    lastText.current = value;
    setPending(value);
    setFailed(null);
    const result = await send.run({ requestId: request.current, text: value, week: forcedWeek ?? week ?? undefined });
    setPending(null);
    if (result && !result.failed) {
      request.current = crypto.randomUUID();
      setText("");
      setStarter(false);
      history.reload();
    } else if (result?.failed) {
      setFailed(result.reply);
    }
  }

  async function validateCard(card: CardView) {
    setValidating(card.messageId);
    const response = await validate.run<{ result: ValidatedMenuCard }>("/api/courses/chat/menu", { method: "POST", body: { messageId: card.messageId }, timeoutMs: CHAT_TIMEOUT_MS });
    setValidating(null);
    if (response) {
      setValidated(response.result);
      history.reload();
      // « Valider le menu » ouvre la page Liste de courses (US-156 RF12) ; la question « Ajouter ces plats à vos plats ? » attend dans le tchat
      router.push(`/courses/liste?week=${card.proposal.week}`);
    }
  }

  /** Copie les plats cochés dans Mes plats ; sans plat, le foyer a refusé (« Non merci »). */
  async function addDishes(card: CardView, slots: string[]): Promise<string[] | null> {
    const response = await adding.run<{ result: { added: string[] } }>("/api/courses/chat/menu/dishes", { method: "POST", body: { messageId: card.messageId, week: card.proposal.week, slots } });
    return response ? response.result.added : null;
  }

  /** « Remplacer » (CR-57) : MAAQ change le plat de la carte sans IA ; le fil est rechargé avec la carte mise à jour. */
  function replaceApiOf(card: CardView): ReplaceApi {
    return {
      options: async (kind: ReplaceKind, index: number) => {
        try {
          return (await apiRequest<{ options: ReplaceOptions }>(`/api/courses/chat/menu/replace?messageId=${card.messageId}&kind=${kind}&index=${index}`)).options;
        } catch (err) {
          setFailed(err instanceof Error ? err.message : "Impossible de charger les plats.");
          return null;
        }
      },
      replace: async (kind: ReplaceKind, index: number, choice: ReplaceChoice) => {
        const done = await replacing.run("/api/courses/chat/menu/replace", { method: "POST", body: { messageId: card.messageId, kind, index, choice } });
        if (done) history.reload();
        return !!done;
      },
    };
  }

  const error = failed ?? send.error?.message ?? null;
  const retryable = failed !== null || send.error?.retryable === true;

  return (
    <section aria-label="Tchat Courses et repas" style={{ marginTop: 16 }}>
      <p className={styles.banner} style={{ fontWeight: 400, fontSize: 11, background: "var(--warning-bg)" }}>
        Vous échangez avec une IA. Ses réponses peuvent contenir des erreurs.
      </p>
      <div role="log" aria-live="polite" style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {messages.map((m) =>
          m.adjust ? (
            <AdjustCard
              key={m.id}
              view={m.adjust}
              busy={adjustingId === m.adjust.messageId}
              onAction={async (action, key) => {
                setAdjustingId(m.adjust!.messageId);
                const done = await adjusting.run("/api/courses/chat/adjust", { method: "POST", body: { action, messageId: m.adjust!.messageId, ...(key ? { key } : {}) }, timeoutMs: CHAT_TIMEOUT_MS });
                setAdjustingId(null);
                if (done) history.reload();
                return !!done;
              }}
            />
          ) : m.card ? (
            <MenuCard key={m.id} card={m.card} busy={validating === m.card.messageId} onValidate={(c) => void validateCard(c)} onAdd={addDishes} replaceApi={couple ? replaceApiOf(m.card) : undefined} />
          ) : (
            <div key={m.id} className={m.role === "user" ? undefined : styles.dayCard} style={m.role === "user" ? { alignSelf: "flex-end", maxWidth: "85%", padding: "8px 12px", borderRadius: "12px 12px 2px 12px", background: "var(--primary)", color: "var(--primary-ink)", fontSize: 14 } : { fontSize: 14, lineHeight: 1.4 }}>
              {m.role === "user" ? m.text : <Rich text={m.text} couple={couple} />}
            </div>
          ),
        )}
        {starter && !pending && week === null && (
          <>
            <div className={styles.dayCard} style={{ fontSize: 14, lineHeight: 1.45 }}>
              Pour quelle semaine ?
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "nowrap", overflowX: "auto", paddingBottom: 6 }}>
              {weeks.map((w) => (
                <button
                  key={w.week}
                  type="button"
                  className={family.chipToggle}
                  style={{ flex: "0 0 auto", whiteSpace: "nowrap" }}
                  aria-pressed={false}
                  onClick={() => {
                    setWeek(w.week);
                    if (fromReceipt) {
                      setStarter(false);
                      void submit("Composons le menu de cette semaine à partir de ce que je viens d'acheter.", w.week);
                    }
                  }}
                >
                  {w.label}
                  {w.hasMenu ? " · menu validé" : ""}
                </button>
              ))}
            </div>
          </>
        )}
        {starter && !pending && week !== null && (
          <>
            <div className={styles.dayCard} style={{ fontSize: 14, lineHeight: 1.45 }}>
              {own.loading && !own.data
                ? `On prépare le menu de la semaine ${weekLabel} ?`
                : dishes.length
                  ? `On prépare le menu de la semaine ${weekLabel} ? Choisissez 1 ou 2 plats pour cette semaine. Vous pouvez aussi écrire un autre plat.`
                  : `On prépare le menu de la semaine ${weekLabel} ? Quel plat vous ferait plaisir cette semaine ?`}
            </div>
            {dishes.length > 0 && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {dishes.slice(0, shown).map((d) => {
                    const on = picks.includes(d.name);
                    return (
                      <button
                        key={d.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setPicks(on ? picks.filter((x) => x !== d.name) : picks.length >= 2 ? picks : [...picks, d.name])}
                        style={{ minHeight: 36, padding: "0 12px", borderRadius: 100, fontSize: 12, fontWeight: 700, border: `1px solid ${on ? "var(--primary)" : "var(--line)"}`, background: on ? "var(--primary)" : "var(--bg-raised)", color: on ? "var(--primary-ink)" : "var(--ink)" }}
                      >
                        {d.name}
                      </button>
                    );
                  })}
                </div>
                {shown < dishes.length && (
                  <button type="button" className={styles.link} style={{ alignSelf: "flex-start", background: "none", border: "none", padding: "4px 0" }} onClick={() => setShown(shown + PAGE)}>
                    Voir d&apos;autres plats ›
                  </button>
                )}
                <span className={styles.meta}>{picks.length ? `${picks.length} plat${picks.length > 1 ? "s" : ""} choisi${picks.length > 1 ? "s" : ""} sur 2.` : "Touchez 1 ou 2 plats."}</span>
                <Button onClick={() => void submit(`Composons le menu de la semaine ${weekLabel} en partant de : ${picks.join(" et ")}.`)} disabled={!picks.length} style={{ alignSelf: "flex-start" }}>
                  Proposer le menu
                </Button>
              </div>
            )}
          </>
        )}
        {pending && (
          <>
            <div style={{ alignSelf: "flex-end", maxWidth: "85%", padding: "8px 12px", borderRadius: "12px 12px 2px 12px", background: "var(--primary)", color: "var(--primary-ink)", fontSize: 14 }}>{pending}</div>
            <div className={styles.dayCard} role="status">
              <span className={styles.meta}>{menuIntent ? (send.slow ? "Je prépare votre menu… Toujours en cours…" : "Je prépare votre menu…") : "Courses et repas écrit…"}</span>
              {send.progress && (send.progress.dinners.length > 0 || send.progress.express.length > 0) && (
                <ol aria-label="Menu en cours d'écriture" style={{ margin: "6px 0 0", paddingLeft: 18, fontSize: 13, lineHeight: 1.5 }}>
                  {send.progress.dinners.map((name, i) => (
                    <li key={`d${i}`}>
                      <span className={styles.meta}>{DAY_LABELS[i] ?? ""}</span> {name}
                    </li>
                  ))}
                  {send.progress.express.length > 0 && <li style={{ listStyle: "none", marginLeft: -18 }} className={styles.meta}>Plats express : {send.progress.express.join(" · ")}</li>}
                </ol>
              )}
            </div>
          </>
        )}
        <div ref={end} />
      </div>
      {error && (retryable ? <RetryNotice message={error} onRetry={() => void submit(lastText.current)} /> : <Notice tone="error">{error}</Notice>)}
      {validate.error && <Notice tone="error">{validate.error.message}</Notice>}
      {adding.error && <Notice tone="error">{adding.error.message}</Notice>}
      {replacing.error && <Notice tone="error">{replacing.error.message}</Notice>}
      {adjusting.error && <Notice tone="error">{adjusting.error.message}</Notice>}
      {validated && <p className={styles.banner}>Menu enregistré : {validated.listed} produit{validated.listed > 1 ? "s" : ""} dans votre liste de courses.</p>}
      <div className={styles.addRow} style={{ marginTop: 10 }}>
        <input
          className={family.input}
          aria-label="Écrire à Courses et repas"
          placeholder="Écrire à Courses et repas…"
          value={text}
          maxLength={2000}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && void submit()}
        />
        {couple && (
          <Link href="/courses/ticket" aria-label="Envoyer une photo de ticket" className={styles.toggleBox} style={{ display: "grid", placeItems: "center", width: 44, height: 44, textDecoration: "none" }}>
            📷
          </Link>
        )}
        <Button onClick={() => void submit()} loading={send.pending} disabled={!text.trim()}>
          Envoyer
        </Button>
      </div>
    </section>
  );
}
