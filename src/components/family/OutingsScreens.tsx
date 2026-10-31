"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell, Section } from "@/components/app/AppShell";
import { Button, Loading, Notice, RetryNotice } from "@/components/ui";
import type { EventType } from "@/server/assistant/calendar";
import type { IdeaFormView, IdeaView, ProposalView } from "@/server/assistant/outings/proposals";
import { longDate, shortDate } from "./format";
import styles from "./family.module.css";

const BACK = { href: "/assistant", label: "Assistant Famille" };
const euro = (value: number) => `${value.toLocaleString("fr-FR", { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 2 })} €`;

/**
 * Carte privée « L'heure de penser à vous » de l'accueil (US-115 RF5) : le jour visé et le nombre d'idées. « Annuler » retire toute la proposition, sans confirmation ;
 * « Proposition retirée » reste dix secondes avec un bouton « Annuler » pour revenir en arrière (US-116 RF1). Aucun message ne commente l'abandon (AT-9).
 */
export function OutingHomeCard() {
  const card = useApiQuery<{ card: { id: string; targetDate: string; ideas: number } | null }>("/api/family/outings/home");
  const mutation = useApiMutation();
  const [removed, setRemoved] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  const current = card.data?.card ?? null;

  async function remove(id: string) {
    const done = await mutation.run(`/api/family/outings/proposals/${id}/dismiss`, { method: "POST" });
    if (done === undefined) return;
    setRemoved(id);
    card.reload();
    timer.current = setTimeout(() => setRemoved(null), 10_000);
  }
  async function restore(id: string) {
    const done = await mutation.run(`/api/family/outings/proposals/${id}/restore`, { method: "POST" });
    if (done === undefined) return;
    if (timer.current) clearTimeout(timer.current);
    setRemoved(null);
    card.reload();
  }

  if (removed)
    return (
      <div className={styles.form} role="status">
        <span>Proposition retirée</span>
        <Button variant="ghost" onClick={() => void restore(removed)} loading={mutation.pending}>
          Annuler
        </Button>
      </div>
    );
  if (!current) return null;
  return (
    <Section title="L'heure de penser à vous">
      <div className={styles.listItem} style={{ alignItems: "center" }}>
        <Link href={`/assistant/sorties/${current.id}`} className={styles.listBody} style={{ textDecoration: "none", color: "inherit" }}>
          <strong>Pour le {longDate(current.targetDate)}</strong>
          <br />
          <span className={styles.hint}>
            {current.ideas} {current.ideas > 1 ? "idées de sorties" : "idée de sortie"} · proposition privée
          </span>
        </Link>
        <button type="button" className={styles.dangerLink} onClick={() => void remove(current.id)} disabled={mutation.pending} aria-label="Retirer la proposition">
          Annuler
        </button>
      </div>
      {mutation.error && <Notice tone="error">La proposition n&apos;a pas pu être retirée.</Notice>}
    </Section>
  );
}

/** Écran « Idées de sorties » (US-115 RF5) : en-tête, « Dans le budget » par thème, « Nouveautés hors budget », note finale. Privé au parent qui l'a reçue (US-117). */
export function OutingScreen({ id }: { id: string }) {
  const query = useApiQuery<{ proposal: ProposalView }>(`/api/family/outings/proposals/${id}`);
  const proposal = query.data?.proposal;
  const gone = query.error?.body?.code === "not_found";
  const ideas = (proposal?.ideas ?? []).filter((i) => i.status !== "dismissed");
  const budgetIdeas = ideas.filter((i) => i.section === "in_budget");
  const themes = [...new Set(budgetIdeas.map((i) => i.themeLabel ?? ""))];
  const novelties = ideas.filter((i) => i.section === "novelty");
  return (
    <AppShell title="Idées de sorties" back={BACK}>
      {query.loading && !proposal && <Loading slow={query.slow} />}
      {gone && <Notice tone="info">Cette page n&apos;existe plus ou ne vous est pas accessible.</Notice>}
      {query.error && !gone && <RetryNotice message={query.error.kind === "server" ? "La proposition n'a pas pu être chargée." : query.error.message} onRetry={query.reload} />}
      {proposal && (
        <>
          <p className={styles.hint}>
            {longDate(proposal.targetDate)} · départ {proposal.place} · budget {euro(proposal.budget)} pour {proposal.people} {proposal.people > 1 ? "personnes" : "personne"}
            {proposal.checkedOn ? ` · prix relevés le ${shortDate(proposal.checkedOn)}` : ""}
          </p>
          {proposal.status !== "ready" && ideas.length === 0 && <Notice tone="info">Cette proposition est retirée.</Notice>}
          {themes.map((theme) => (
            <Section key={theme} title={theme ? `Dans le budget · ${theme}` : "Dans le budget"}>
              <div className={styles.taskList}>
                {budgetIdeas.filter((i) => (i.themeLabel ?? "") === theme).map((idea) => (
                  <IdeaCard key={idea.id} idea={idea} budget={proposal.budget} onChanged={query.reload} />
                ))}
              </div>
            </Section>
          ))}
          {novelties.length > 0 && (
            <Section title="Nouveautés hors budget">
              <p className={styles.hint}>Ce sont des nouveautés présentées par curiosité, hors du budget fixé, à découvrir sans pression.</p>
              <div className={styles.taskList}>
                {novelties.map((idea) => (
                  <IdeaCard key={idea.id} idea={idea} budget={proposal.budget} onChanged={query.reload} />
                ))}
              </div>
            </Section>
          )}
          <p className={styles.hint}>{proposal.note}</p>
        </>
      )}
    </AppShell>
  );
}

function IdeaCard({ idea, budget, onChanged }: { idea: IdeaView; budget: number; onChanged: () => void }) {
  const mutation = useApiMutation();
  async function pass() {
    const done = await mutation.run(`/api/family/outings/ideas/${idea.id}/dismiss`, { method: "POST", body: {} });
    if (done !== undefined) onChanged();
  }
  // Une nouveauté n'a ni jauge ni repère de budget ; son prix est précédé de « ≈ » s'il est estimé (RF3).
  const price = idea.section === "novelty" ? `${idea.estimated ? "≈ " : ""}${euro(idea.priceEur)}` : `${euro(idea.priceEur)}${idea.estimated ? " (estimé)" : ""}`;
  return (
    <div className={styles.proposalCard}>
      {idea.openedYear && idea.section === "novelty" && <span className={styles.badge}>Ouvert en {idea.openedYear}</span>}
      <div className={styles.hint} style={{ textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {idea.place}
      </div>
      <div className={styles.proposalTitle}>{idea.name}</div>
      <div>
        <strong>{price}</strong>
        {idea.estimated && idea.priceBasis && <span className={styles.hint}> · {idea.priceBasis}</span>}
      </div>
      {idea.section === "in_budget" && idea.budgetPercent !== null && (
        <div>
          <div role="img" aria-label={`${idea.budgetPercent} % du budget`} style={{ height: 8, borderRadius: 4, background: "var(--bg-sunken)", overflow: "hidden" }}>
            <div style={{ width: `${idea.budgetPercent}%`, height: "100%", background: "var(--primary)" }} />
          </div>
          <div className={styles.hint} style={{ display: "flex", justifyContent: "space-between" }}>
            <span>{idea.budgetPercent} % du budget</span>
            <span>{euro(budget)}</span>
          </div>
        </div>
      )}
      <p>{idea.description}</p>
      {idea.details && <p className={styles.hint}>{idea.details}</p>}
      <a href={idea.url} target="_blank" rel="noopener noreferrer" className={styles.link}>
        Voir l&apos;offre
      </a>
      {idea.status === "added" ? (
        <p className={styles.hint}>Ajoutée au calendrier</p>
      ) : (
        <div className={styles.actionsRow}>
          <Link href={`/assistant/sorties/idee/${idea.id}`} className={styles.cta}>
            Ajouter au calendrier
          </Link>
          <button type="button" className={styles.dangerLink} onClick={() => void pass()} disabled={mutation.pending}>
            Pas cette fois
          </button>
        </div>
      )}
      {mutation.error && <Notice tone="error">L&apos;idée n&apos;a pas pu être retirée.</Notice>}
    </div>
  );
}

const TYPES: { value: EventType; label: string }[] = [
  { value: "family", label: "Familial" },
  { value: "personal", label: "Personnel" },
];

interface Conflict {
  conflicts: { id: string; title: string | null; start: string; end: string }[];
  alternatives: { start: string; end: string }[];
}

/**
 * Formulaire de RDV « Depuis une idée de sortie » (US-120, US-121) : prérempli (titre, lieu, note avec description, prix et lien, type, membres) mais sans date ni heure : le jour
 * visé n'est que suggéré. Au-dessus du bouton, l'avertissement de visibilité (sauf sans autre parent) et l'aide « titre discret ». « Plus tard » ferme sans rien enregistrer.
 */
export function OutingIdeaFormScreen({ id }: { id: string }) {
  const router = useRouter();
  const form = useApiQuery<{ form: IdeaFormView }>(`/api/family/outings/ideas/${id}/form`);
  const data = form.data?.form;
  const gone = form.error?.body?.code === "not_found";
  return (
    <AppShell title="Ajouter au calendrier" back={{ href: "/assistant", label: "Assistant Famille" }}>
      {form.loading && !data && <Loading slow={form.slow} />}
      {gone && <Notice tone="info">Cette page n&apos;existe plus ou ne vous est pas accessible.</Notice>}
      {form.error && !gone && <RetryNotice message={form.error.message} onRetry={form.reload} />}
      {data && <IdeaForm id={id} initial={data} onLater={() => router.back()} onAdded={(eventId) => router.push(`/calendrier/rdv/${eventId}`)} />}
    </AppShell>
  );
}

function IdeaForm({ id, initial, onLater, onAdded }: { id: string; initial: IdeaFormView; onLater: () => void; onAdded: (eventId: string) => void }) {
  const save = useApiMutation();
  const [title, setTitle] = useState(initial.title);
  const [place, setPlace] = useState(initial.place);
  const [notes, setNotes] = useState(initial.notes);
  const [type, setType] = useState<EventType>(initial.type);
  const [memberIds, setMemberIds] = useState<string[]>(initial.memberId ? [initial.memberId] : []);
  const [date, setDate] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [visibility, setVisibility] = useState(initial.warning);

  // Les personnes concernées changent qui verra le RDV : l'avertissement suit (US-121 RF5).
  async function members(next: string[]) {
    setMemberIds(next);
    const response = await fetch(`/api/family/outings/ideas/${id}/form?members=${next.join(",")}`, { credentials: "same-origin" }).catch(() => null);
    const body = response?.ok ? ((await response.json()) as { form: IdeaFormView }) : null;
    if (body) setVisibility(body.form.warning);
  }

  const missing = !date || !from || !to || to <= from || !title.trim() || memberIds.length === 0;

  async function submit(allowConflict = false, slot?: { start: string; end: string }) {
    const start = slot?.start ?? `${date}T${from}`;
    const end = slot?.end ?? `${date}T${to}`;
    const result = await save.run<{ event: { id: string } }>(`/api/family/outings/ideas/${id}/calendar`, { method: "POST", body: { title: title.trim(), place: place.trim() || null, notes: notes.trim() || null, type, memberIds, start, end, allowConflict } });
    if (result) onAdded(result.event.id);
  }

  // Un conflit (US-74) est montré avant l'enregistrement, avec ses créneaux alternatifs (RF7).
  const found = save.error?.body?.code === "conflict" ? (save.error.body.details as Conflict | undefined) : undefined;
  const conflict = found ?? null;

  return (
    <div className={styles.form}>
      <div className={styles.confirmTitle}>Depuis une idée de sortie</div>
      <p className={styles.hint}>Proposé pour le {longDate(initial.suggestedDate)}</p>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="outing-title">
          Titre
        </label>
        <input id="outing-title" className={styles.input} value={title} maxLength={100} onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="outing-event-place">
          Lieu
        </label>
        <input id="outing-event-place" className={styles.input} value={place} maxLength={200} onChange={(e) => setPlace(e.target.value)} />
      </div>
      <div className={styles.label}>Type</div>
      <div className={styles.wrapRow}>
        {TYPES.map((t) => (
          <button key={t.value} type="button" className={styles.chipToggle} aria-pressed={type === t.value} onClick={() => setType(t.value)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className={styles.label}>Qui est concerné</div>
      <div className={styles.wrapRow}>
        {initial.members.map((m) => (
          <button key={m.id} type="button" className={styles.chipToggle} aria-pressed={memberIds.includes(m.id)} onClick={() => void members(memberIds.includes(m.id) ? memberIds.filter((x) => x !== m.id) : [...memberIds, m.id])}>
            {m.firstName}
          </button>
        ))}
      </div>
      <div className={styles.two}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="outing-date">
            Date
          </label>
          <input id="outing-date" type="date" className={styles.input} value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="outing-from">
            Début
          </label>
          <input id="outing-from" type="time" className={styles.input} value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="outing-to">
            Fin
          </label>
          <input id="outing-to" type="time" className={styles.input} value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
      </div>
      <div className={styles.field}>
        <label className={styles.label} htmlFor="outing-notes">
          Note
        </label>
        <textarea id="outing-notes" className={styles.textarea} value={notes} maxLength={500} onChange={(e) => setNotes(e.target.value)} />
      </div>

      {conflict && (
        <Notice tone="warning">
          Ce créneau chevauche un autre rendez-vous
          {conflict.conflicts[0]?.title ? ` (${conflict.conflicts[0].title})` : ""}.
          {conflict.alternatives.length > 0 && (
            <div className={styles.wrapRow}>
              {conflict.alternatives.map((a) => (
                <button key={a.start} type="button" className={styles.chipToggle} onClick={() => void submit(false, a)}>
                  {shortDate(a.start.slice(0, 10))} {a.start.slice(11, 16)}
                </button>
              ))}
            </div>
          )}
          <Button variant="ghost" onClick={() => void submit(true)} loading={save.pending}>
            Enregistrer malgré tout
          </Button>
        </Notice>
      )}
      {save.error && !found && <Notice tone="error">{save.error.kind === "server" ? "Le rendez-vous n'a pas pu être enregistré : le formulaire reste rempli, réessayez." : save.error.message}</Notice>}

      {visibility && <Notice tone="info">{visibility}</Notice>}
      <p className={styles.hint}>{initial.help}</p>
      <div className={styles.actionsRow}>
        <Button variant="ghost" onClick={onLater} disabled={save.pending}>
          Plus tard
        </Button>
        <Button onClick={() => void submit()} loading={save.pending} disabled={missing}>
          Ajouter au calendrier
        </Button>
      </div>
    </div>
  );
}
