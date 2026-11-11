"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { AppShell } from "@/components/app/AppShell";
import { Button, Loading, Notice, RetryNotice } from "@/components/ui";
import type { HomeworkSetting } from "@/server/assistant/homework/settings";
import type { HomeworkOptions } from "@/server/assistant/homework/weeks";
import { addDays, shortDate } from "./format";
import { weekHref, weekTitle } from "./homework-domains";
import styles from "./family.module.css";

/**
 * Préparer la semaine de devoirs avec l'aide Devoirs (US-119 RF2, RF3, RF10, RF11) : des questions à boutons, quatre étapes, le choix recommandé en premier.
 * Un parent l'ouvre à tout moment depuis la tâche « Préparer les devoirs » : la semaine en cours ou une des 4 suivantes, tous les enfants cochés au départ, les jours de
 * devoirs du foyer proposés d'abord. Une semaine déjà préparée s'ouvre pour être modifiée ; les jours déjà passés de la semaine en cours ne sont pas touchés.
 *   1. la semaine, les jours de travail et les enfants ; 2. les thématiques (maths et six catégories d'activités) ;
 *   3. pour chaque enfant, les blocs d'exercices de son niveau et les activités de son âge des devoirs ; 4. le jour de chaque élément, et les activités du parent.
 * Les choix sont gardés dans le navigateur (sessionStorage) : si la préparation n'aboutit pas, ils sont renvoyés tels quels avec « Réessayer » (RF10). Le serveur n'enregistre
 * rien avant la fin, en une seule transaction. L'aide ne place rien à la place du parent (RF3) : un exercice sans jour choisi n'est pas placé.
 */

const STORAGE_KEY = "maaq.homework.draft";
const MATHS = "maths";

/** « Les jours de devoirs du foyer » vient du réglage (US-118 RF7) ; un autre choix ne vaut que pour cette semaine. */
const HOUSEHOLD = "foyer";
const RHYTHMS: { key: string; label: string; days: number[] }[] = [
  { key: "school_weekend", label: "Soirs d'école et week-end", days: [1, 2, 4, 5, 6, 7] },
  { key: "wednesday_weekend", label: "Mercredi et week-end", days: [3, 6, 7] },
  { key: "all", label: "Tous les jours", days: [1, 2, 3, 4, 5, 6, 7] },
];

interface Custom {
  memberId: string;
  title: string;
  days: number[];
}

interface Draft {
  step: 1 | 2 | 3 | 4;
  weekStart: string;
  rhythm: string;
  memberIds: string[];
  /** Les enfants ont été choisis à la main : sinon, tous ceux qui ont un âge des devoirs sont cochés (RF11). */
  kidsChosen?: boolean;
  themes: string[];
  /** Éléments choisis par enfant : blocs de maths (`textbook:1,2,3,4,5`) et activités (`a:identifiant`). */
  picks: Record<string, string[]>;
  /** Jours de chaque élément : `memberId|clé de l'élément`. */
  days: Record<string, number[]>;
  customs: Custom[];
  /** Semaine déjà préparée : « Modifier » (recommandé) ouvre son écran, « Refaire » relance les 4 étapes (US-119 RF12). */
  mode?: "modifier" | "refaire";
}

const emptyDraft = (weekStart: string): Draft => ({ step: 1, weekStart, rhythm: HOUSEHOLD, memberIds: [], themes: [], picks: {}, days: {}, customs: [] });

function loadDraft(weekStart: string, asked: boolean): Draft {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    const draft = raw ? (JSON.parse(raw) as Draft) : null;
    // Un brouillon gardé reprend là où il en était, sauf si une autre semaine est demandée par l'adresse.
    if (draft && typeof draft.rhythm === "string" && (!asked || draft.weekStart === weekStart)) return draft;
  } catch {
    // Sans stockage de session, le brouillon reste dans l'écran : il vit tant que la page est ouverte.
  }
  return emptyDraft(weekStart);
}

function saveDraft(draft: Draft | null) {
  try {
    if (draft) window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
    else window.sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Voir loadDraft.
  }
}

const toggle = <T,>(list: T[], value: T): T[] => (list.includes(value) ? list.filter((x) => x !== value) : [...list, value]);
/** « lun. 2 nov. » : `shortDate` donne déjà le jour de la semaine. */
const dayName = (weekStart: string, iso: number) => shortDate(addDays(weekStart, iso - 1));

type ElementRef = { key: string; label: string; detail: string; item: { kind: "exercises"; textbook: string; numbers: number[] } | { kind: "activity"; activityId: string } };

/** Les éléments choisis pour un enfant, avec de quoi les afficher et les envoyer. */
function elementsOf(options: HomeworkOptions | undefined, picks: string[]): ElementRef[] {
  if (!options) return [];
  const out: ElementRef[] = [];
  for (const pick of picks) {
    if (pick.startsWith("a:")) {
      const id = pick.slice(2);
      const found = options.activities.flatMap((c) => c.options.map((o) => ({ ...o, category: c.label }))).find((o) => o.activityId === id);
      if (found) out.push({ key: pick, label: found.title, detail: `Activité · ${found.category}${found.needsAdult ? " · avec un adulte" : ""}`, item: { kind: "activity", activityId: id } });
    } else {
      const block = options.blocks.find((b) => `${b.textbook}:${b.numbers.join(",")}` === pick);
      if (block) out.push({ key: pick, label: `Exercices ${block.from} à ${block.to}`, detail: `Maths · ${block.textbookLabel}${block.novelty ? " · nouveauté" : ""} · ${block.themes}`, item: { kind: "exercises", textbook: block.textbook, numbers: block.numbers } });
    }
  }
  return out;
}

const WEEKDAY_NAMES = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
const BACK = { href: "/assistant/devoirs/tache", label: "Fermer", close: true };
/** « 16 novembre » */
const dayMonth = (weekStart: string) => weekTitle(weekStart).replace("Semaine du ", "");
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
/** « jeudi », « jeudi et vendredi », « lundi, jeudi et vendredi » */
const listOf = (list: string[]) => (list.length < 2 ? list.join("") : `${list.slice(0, -1).join(", ")} et ${list[list.length - 1]}`);
const desc = { display: "block", fontSize: 11, fontWeight: 500, opacity: 0.8, marginTop: 1 } as const;

/** « Refaire » une semaine déjà préparée (US-119 RF12) : pour les enfants choisis, ou pour un seul enfant depuis sa page de la semaine. */
export interface Redo {
  weekId: string;
  memberId: string | null;
}

export function HomeworkPlanner({ weekStart, asked = false, redo = null }: { weekStart: string; asked?: boolean; redo?: Redo | null }) {
  const router = useRouter();
  const setting = useApiQuery<{ setting: HomeworkSetting }>("/api/family/homework");
  const weeks = useApiQuery<{ today: string; weeks: { id: string; weekStart: string }[]; mondays: { weekStart: string; prepared: boolean; weekId: string | null }[] }>("/api/family/homework/weeks");
  const redoStart = redo ? (weeks.data?.weeks.find((w) => w.id === redo.weekId)?.weekStart ?? null) : null;
  const [draft, setDraft] = useState<Draft | null>(null);
  const [options, setOptions] = useState<Record<string, HomeworkOptions>>({});
  const [optionsError, setOptionsError] = useState<string | null>(null);
  const submit = useApiMutation();
  const [failed, setFailed] = useState(false);

  // Le brouillon vient du stockage du navigateur : il ne se lit qu'après l'affichage côté client.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => {
    // Refaire une semaine : un parcours neuf, sans brouillon gardé, aucun enfant coché (ou l'enfant de la page d'où l'on vient).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (redo) setDraft(redoStart ? { ...emptyDraft(redoStart), kidsChosen: true, memberIds: redo.memberId ? [redo.memberId] : [] } : null);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    else setDraft(loadDraft(weekStart, asked));
  }, [weekStart, asked, redo?.weekId, redo?.memberId, redoStart]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (draft && !redo) saveDraft(draft);
  }, [draft, redo]);

  const children = useMemo(() => (setting.data?.setting.children ?? []).filter((c) => c.homeworkAge !== null), [setting.data]);
  const change = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d));

  // Tous les enfants qui ont un âge des devoirs sont cochés au départ ; le parent peut en décocher (RF11).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (children.length) setDraft((d) => (d && !d.kidsChosen && d.memberIds.length !== children.length ? { ...d, memberIds: children.map((c) => c.memberId) } : d));
  }, [children]);

  // Les propositions de chaque enfant se chargent en arrivant à l'étape 3.
  const needed = draft && draft.step >= 3 ? draft.memberIds : [];
  const chosenWeek = draft?.weekStart ?? weekStart;
  useEffect(() => {
    let cancelled = false;
    for (const memberId of needed) {
      if (options[memberId]) continue;
      void fetch(`/api/family/homework/options?member=${memberId}&week=${chosenWeek}`, { credentials: "same-origin" })
        .then(async (response) => {
          if (!response.ok) throw new Error(String(response.status));
          return (await response.json()) as HomeworkOptions;
        })
        .then((data) => !cancelled && setOptions((o) => ({ ...o, [memberId]: data })))
        .catch(() => !cancelled && setOptionsError("Les propositions n'ont pas pu être chargées."));
    }
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [needed.join(","), chosenWeek]);

  // La croix ferme vers l'écran d'origine : la semaine si l'on vient de la page d'un enfant, sinon la tâche.
  const back = redo?.memberId ? { href: weekHref(redo.weekId, redo.memberId), label: "Fermer", close: true } : BACK;
  const baseTitle = redo ? "Refaire la semaine" : "Préparer la semaine";
  if (redo && weeks.data && !redoStart) return <AppShell title={baseTitle} eyebrow="Aide Devoirs" back={back}><Notice tone="info">Cette semaine n&apos;existe plus.</Notice></AppShell>;
  if (!draft) return <AppShell title={baseTitle} eyebrow="Aide Devoirs" back={back}><Loading /></AppShell>;
  const d = draft;
  const today = weeks.data?.today ?? null;
  const householdDays = setting.data?.setting.days ?? [1, 2, 4, 5];
  const rhythmDays = d.rhythm === HOUSEHOLD ? householdDays : (RHYTHMS.find((r) => r.key === d.rhythm)?.days ?? householdDays);
  // Semaine en cours : les jours déjà passés ne sont pas touchés (RF11).
  const workDays = today ? rhythmDays.filter((day) => addDays(d.weekStart, day - 1) >= today) : rhythmDays;
  const mondays = weeks.data?.mondays ?? [{ weekStart: d.weekStart, prepared: false, weekId: null }];
  // En refaisant une semaine, elle n'est plus traitée comme « déjà préparée » : le parcours continue.
  const picked = redo ? undefined : mondays.find((m) => m.weekStart === d.weekStart);
  // Semaine déjà préparée : « Modifier » (recommandé) ou « Refaire », qui continue ici même pour les enfants cochés.
  const mode = picked?.prepared && picked.weekId ? (d.mode ?? "modifier") : null;
  const eff: Redo | null = redo ?? (mode === "refaire" && picked?.weekId ? { weekId: picked.weekId, memberId: null } : null);
  const kidRedo = redo?.memberId ? (children.find((c) => c.memberId === redo.memberId)?.firstName ?? "") : null;
  const title = kidRedo ? `Refaire la semaine de ${kidRedo}` : eff ? "Refaire la semaine" : "Préparer la semaine";
  const redoNames = d.memberIds.map((id) => children.find((c) => c.memberId === id)?.firstName ?? "").filter(Boolean);
  const allKids = children.map((c) => c.memberId);
  const pickMode = (next: "modifier" | "refaire") => {
    if (next === mode) return;
    // « Refaire » : aucun enfant coché au départ ; « Modifier » : retour aux enfants du foyer.
    change(next === "refaire" ? { mode: next, memberIds: [], kidsChosen: true } : { mode: next, memberIds: allKids, kidsChosen: false });
  };
  const current = today !== null && mondays[0]?.weekStart === d.weekStart && d.weekStart <= today;
  // Changer de semaine repart des propositions de cette semaine-là : les choix d'exercices et de jours ne se reportent pas.
  const pickWeek = (start: string) => {
    if (start === d.weekStart) return;
    setOptions({});
    change({ weekStart: start, picks: {}, days: {}, customs: [], mode: undefined, ...(d.mode === "refaire" ? { memberIds: allKids, kidsChosen: false } : {}) });
  };
  const name = (id: string) => children.find((c) => c.memberId === id)?.firstName ?? "";
  const elements = (id: string) => elementsOf(options[id], d.picks[id] ?? []);

  const placedCount =
    d.memberIds.reduce((sum, id) => sum + elements(id).filter((e) => (d.days[`${id}|${e.key}`] ?? []).some((x) => workDays.includes(x))).length, 0) +
    d.customs.filter((c) => c.title.trim() && c.days.some((x) => workDays.includes(x))).length;

  async function send() {
    setFailed(false);
    const body = {
      weekStart: d.weekStart,
      workDays,
      children: d.memberIds.map((memberId) => ({
        memberId,
        items: [
          ...elements(memberId).flatMap((e) => {
            const days = (d.days[`${memberId}|${e.key}`] ?? []).filter((x) => workDays.includes(x));
            return days.length ? [{ ...e.item, days }] : [];
          }),
          ...d.customs
            .map((c) => ({ ...c, days: c.days.filter((x) => workDays.includes(x)) }))
            .filter((c) => c.memberId === memberId && c.title.trim() && c.days.length)
            .map((c) => ({ kind: "custom" as const, title: c.title.trim(), days: c.days })),
        ],
      })),
    };
    const result = eff
      ? await submit.run<{ weekId: string }>(`/api/family/homework/weeks/${eff.weekId}`, { method: "PUT", body: { workDays: body.workDays, children: body.children } })
      : await submit.run<{ weekId: string }>("/api/family/homework/weeks", { method: "POST", body });
    if (result) {
      if (!redo) saveDraft(null);
      // La semaine s'ouvre sur la page de l'enfant concerné : celui qu'on vient de refaire, ou le seul enfant de la préparation.
      router.push(weekHref(result.weekId, redo?.memberId ?? (d.memberIds.length === 1 ? d.memberIds[0] : null)));
    } else setFailed(true);
  }

  return (
    <AppShell title={title} eyebrow="Aide Devoirs" back={back}>
      {setting.error && <RetryNotice message={setting.error.message} onRetry={setting.reload} />}
      {setting.data && !setting.data.setting.enabled && <Notice tone="info">L&apos;aide Devoirs est désactivée : activez-la dans les réglages.</Notice>}
      {setting.data && setting.data.setting.enabled && children.length === 0 && <Notice tone="info">Indiquez l&apos;âge des devoirs d&apos;au moins un enfant dans les réglages.</Notice>}
      {setting.data?.setting.enabled && children.length > 0 && (
        <>
          <p className={styles.hint}>
            {kidRedo && d.step === 1
              ? `Refaire la semaine de ${kidRedo}, du ${dayMonth(d.weekStart)}. Les jours déjà passés ne sont pas proposés.`
              : `Semaine du ${shortDate(d.weekStart)} · étape ${d.step} sur 4. Vous choisissez tout : l'aide ne place rien à votre place.`}
          </p>

          {d.step === 1 && (
            <div className={styles.form}>
              {redo && !kidRedo && (
                <Notice tone="info">
                  Vous refaites la semaine du {dayMonth(d.weekStart)}. Les devoirs à venir des enfants choisis seront remplacés ; ce qui est déjà fait est gardé, et les autres enfants ne changent pas.
                </Notice>
              )}
              {!redo && (
                <>
                  <div className={styles.label}>Quelle semaine ?</div>
                  <div className={styles.wrapRow}>
                    {mondays.map((m, i) => {
                      const thisWeek = i === 0 && today !== null && m.weekStart <= today;
                      const left = thisWeek ? householdDays.filter((day) => addDays(m.weekStart, day - 1) >= today) : [];
                      const note = m.prepared
                        ? "Déjà préparée · à modifier ou à refaire"
                        : thisWeek && left.length > 0 && left.length < householdDays.length
                          ? `${capital(listOf(left.map((x) => WEEKDAY_NAMES[x - 1])))} ${left.length > 1 ? "restent" : "reste"} à venir`
                          : "";
                      return (
                        <button key={m.weekStart} type="button" className={styles.chipToggle} style={{ textAlign: "left" }} aria-pressed={d.weekStart === m.weekStart} onClick={() => pickWeek(m.weekStart)}>
                          {thisWeek ? `Cette semaine, du ${dayMonth(m.weekStart)}` : `Du ${dayMonth(m.weekStart)}`}
                          {i === 0 ? " (Recommandé)" : ""}
                          {note && <span style={desc}>{note}</span>}
                        </button>
                      );
                    })}
                  </div>
                  {current && <span className={styles.hint}>Les jours déjà passés ne sont pas proposés.</span>}
                </>
              )}
              {mode && (
                <>
                  <div className={styles.label}>Cette semaine est déjà préparée</div>
                  <div className={styles.wrapRow}>
                    <button type="button" className={styles.chipToggle} style={{ textAlign: "left" }} aria-pressed={mode === "modifier"} onClick={() => pickMode("modifier")}>
                      Modifier (Recommandé)
                      <span style={desc}>Ouvre « Semaine de devoirs »</span>
                    </button>
                    <button type="button" className={styles.chipToggle} style={{ textAlign: "left" }} aria-pressed={mode === "refaire"} onClick={() => pickMode("refaire")}>
                      Refaire
                      <span style={desc}>Relance les 4 étapes</span>
                    </button>
                  </div>
                </>
              )}
              {/* « Modifier » : les jours et les enfants ne servent à rien, ils ne sont pas demandés. */}
              {mode !== "modifier" && (
                <>
                  <div className={styles.label}>Quels jours ?</div>
                  <div className={styles.wrapRow}>
                    <button type="button" className={styles.chipToggle} style={{ textAlign: "left" }} aria-pressed={d.rhythm === HOUSEHOLD} onClick={() => change({ rhythm: HOUSEHOLD })}>
                      Les jours de devoirs du foyer (Recommandé)
                      <span style={desc}>{capital(householdDays.map((x) => WEEKDAY_NAMES[x - 1]).join(", "))}</span>
                    </button>
                    {RHYTHMS.map((r) => (
                      <button key={r.key} type="button" className={styles.chipToggle} aria-pressed={d.rhythm === r.key} onClick={() => change({ rhythm: r.key })}>
                        {r.label}
                      </button>
                    ))}
                  </div>
                  <span className={styles.hint}>
                    Un autre choix ne vaut que pour cette semaine.
                    {workDays.length === 0 ? " Ces jours sont déjà passés cette semaine : choisissez d'autres jours, ou une autre semaine." : ""}
                  </span>
                  {!kidRedo && (
                    <>
                      <div className={styles.label}>{eff ? "Quels enfants pour refaire la semaine ?" : "Pour quels enfants ?"}</div>
                      <div className={styles.wrapRow}>
                        {children.map((c) => (
                          <button key={c.memberId} type="button" className={styles.chipToggle} style={{ textAlign: "left" }} aria-pressed={d.memberIds.includes(c.memberId)} onClick={() => change({ memberIds: toggle(d.memberIds, c.memberId), kidsChosen: true })}>
                            {c.firstName}
                            {c.levelLabel && <span style={desc}>Niveau {c.levelLabel}</span>}
                          </button>
                        ))}
                      </div>
                      <span className={styles.hint} role={eff && d.memberIds.length === 0 ? "alert" : undefined}>
                        {eff ? (d.memberIds.length ? "Seule la semaine des enfants cochés est refaite." : "Cochez au moins un enfant.") : "Seuls les enfants qui ont un âge des devoirs sont proposés."}
                      </span>
                    </>
                  )}
                </>
              )}
              <div className={styles.actionsRow}>
                {mode === "modifier" && picked?.weekId ? (
                  <Link href={weekHref(picked.weekId)} className={styles.cta}>
                    Ouvrir la semaine du {dayMonth(d.weekStart)}
                  </Link>
                ) : (
                  <Button onClick={() => change({ step: 2 })} disabled={d.memberIds.length === 0 || workDays.length === 0}>
                    Suivant
                  </Button>
                )}
              </div>
            </div>
          )}

          {d.step === 2 && (
            <div className={styles.form}>
              <div className={styles.label}>Thématiques</div>
              <div className={styles.wrapRow}>
                {[{ key: MATHS, label: "Maths" }, ...(Object.values(options)[0]?.activities.map((a) => ({ key: a.category, label: a.label })) ?? DEFAULT_CATEGORIES)].map((t) => (
                  <button key={t.key} type="button" className={styles.chipToggle} aria-pressed={d.themes.includes(t.key)} onClick={() => change({ themes: toggle(d.themes, t.key) })}>
                    {t.label}
                  </button>
                ))}
              </div>
              <div className={styles.actionsRow}>
                <Button variant="ghost" onClick={() => change({ step: 1 })}>
                  Retour
                </Button>
                <Button onClick={() => change({ step: 3 })} disabled={d.themes.length === 0}>
                  Suivant
                </Button>
              </div>
            </div>
          )}

          {d.step === 3 && (
            <div className={styles.form}>
              {optionsError && <Notice tone="error">{optionsError}</Notice>}
              {d.memberIds.map((id) => {
                const o = options[id];
                if (!o) return <Loading key={id} label={`Propositions pour ${name(id)}…`} />;
                const picks = d.picks[id] ?? [];
                const pick = (key: string) => change({ picks: { ...d.picks, [id]: toggle(picks, key) } });
                return (
                  <div key={id} className={styles.form}>
                    <div className={styles.confirmTitle}>
                      {o.firstName} · niveau {o.levelLabel}
                    </div>
                    {d.themes.includes(MATHS) && (
                      <>
                        <div className={styles.label}>Maths</div>
                        <div className={styles.wrapRow}>
                          {orderedBlocks(o).map((b) => {
                            const key = `${b.textbook}:${b.numbers.join(",")}`;
                            return (
                              <button key={key} type="button" className={styles.chipToggle} aria-pressed={picks.includes(key)} onClick={() => pick(key)}>
                                Exercices {b.from} à {b.to} · {b.textbookLabel}
                                {b.novelty ? " · nouveauté" : ""}
                                {b.state !== "free" ? ` · ${STATE_LABEL[b.state]}` : ""}
                              </button>
                            );
                          })}
                        </div>
                      </>
                    )}
                    {o.activities
                      .filter((c) => d.themes.includes(c.category))
                      .map((c) => (
                        <div key={c.category}>
                          <div className={styles.label}>{c.label}</div>
                          <div className={styles.wrapRow}>
                            {c.options.map((a) => (
                              <div key={a.activityId} className={styles.field} style={{ flex: "1 1 100%" }}>
                                <button type="button" className={styles.chipToggle} aria-pressed={picks.includes(`a:${a.activityId}`)} onClick={() => pick(`a:${a.activityId}`)}>
                                  {a.title}
                                  {a.needsAdult ? " · avec un adulte" : ""}
                                  {a.state !== "free" ? ` · ${STATE_LABEL[a.state]}` : ""}
                                </button>
                                {a.description && <span className={styles.hint}>{a.description}</span>}
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    {o.suggestOlderAge && <p className={styles.hint}>{o.firstName} a validé tous les exercices de son niveau. Vous pouvez augmenter son âge des devoirs d&apos;un an dans les réglages.</p>}
                  </div>
                );
              })}
              <div className={styles.actionsRow}>
                <Button variant="ghost" onClick={() => change({ step: 2 })}>
                  Retour
                </Button>
                <Button onClick={() => change({ step: 4 })} disabled={d.memberIds.some((id) => !options[id])}>
                  Suivant
                </Button>
              </div>
            </div>
          )}

          {d.step === 4 && (
            <div className={styles.form}>
              {d.memberIds.map((id) => (
                <div key={id} className={styles.form}>
                  <div className={styles.confirmTitle}>{name(id)}</div>
                  {elements(id).length === 0 && <p className={styles.hint}>Aucun élément choisi : ajoutez vos propres activités ci-dessous, ou revenez en arrière.</p>}
                  {elements(id).map((e) => (
                    <div key={e.key} className={styles.field}>
                      <div className={styles.label}>{e.label}</div>
                      <div className={styles.hint}>{e.detail}</div>
                      <DayButtons weekStart={d.weekStart} workDays={workDays} value={d.days[`${id}|${e.key}`] ?? []} onChange={(days) => change({ days: { ...d.days, [`${id}|${e.key}`]: days } })} />
                    </div>
                  ))}
                </div>
              ))}
              <div className={styles.confirmTitle}>Vos activités</div>
              {d.customs.map((c, i) => (
                <div key={i} className={styles.field}>
                  <select className={styles.select} value={c.memberId} aria-label="Enfant" onChange={(e) => change({ customs: d.customs.map((x, j) => (j === i ? { ...x, memberId: e.target.value } : x)) })}>
                    {d.memberIds.map((id) => (
                      <option key={id} value={id}>
                        {name(id)}
                      </option>
                    ))}
                  </select>
                  <input className={styles.input} value={c.title} maxLength={100} placeholder="Ex. Lecture 15 min" aria-label="Titre de l'activité" onChange={(e) => change({ customs: d.customs.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)) })} />
                  <DayButtons weekStart={d.weekStart} workDays={workDays} value={c.days} onChange={(days) => change({ customs: d.customs.map((x, j) => (j === i ? { ...x, days } : x)) })} />
                  <Button variant="ghost" onClick={() => change({ customs: d.customs.filter((_, j) => j !== i) })}>
                    Retirer
                  </Button>
                </div>
              ))}
              <Button variant="secondary" onClick={() => change({ customs: [...d.customs, { memberId: d.memberIds[0], title: "", days: [] }] })}>
                Ajouter une activité à moi
              </Button>
              {eff &&
                redoNames.map((kid) => (
                  <Notice key={kid} tone="warning">
                    <b>Les devoirs à venir de {kid} cette semaine seront remplacés. Ce qui est déjà fait est gardé.</b>
                  </Notice>
                ))}
              {failed && <Notice tone="error">La préparation n&apos;a pas abouti. Vos choix sont gardés : réessayez.{submit.error && submit.error.kind !== "server" ? ` (${submit.error.message})` : ""}</Notice>}
              <div className={styles.actionsRow}>
                <Button variant="ghost" onClick={() => change({ step: 3 })} disabled={submit.pending}>
                  Retour
                </Button>
                <Button onClick={() => void send()} loading={submit.pending} disabled={placedCount === 0}>
                  {failed ? "Réessayer" : eff ? "Refaire la semaine" : "Préparer la semaine"}
                </Button>
              </div>
              <p className={styles.hint}>{placedCount === 0 ? "Choisissez au moins un jour pour un élément." : `${placedCount} élément${placedCount > 1 ? "s" : ""} placé${placedCount > 1 ? "s" : ""}.`}</p>
            </div>
          )}
        </>
      )}
    </AppShell>
  );
}

const DEFAULT_CATEGORIES = [
  { key: "nature", label: "Nature" },
  { key: "philosophy", label: "Philo" },
  { key: "stem", label: "STIM" },
  { key: "art", label: "Art" },
  { key: "imagination", label: "Imagination" },
  { key: "games_projects", label: "Jeux et projets" },
];

const STATE_LABEL = { free: "", planned: "déjà prévu", done: "déjà fait", validated: "déjà validé" } as const;

/** 2 à 4 blocs proposés : les libres d'abord (le recommandé en premier), puis ce qui est déjà prévu, fait ou validé, qui reste un choix valable (RF3). */
function orderedBlocks(o: HomeworkOptions) {
  const rank = (b: HomeworkOptions["blocks"][number]) => (b.state === "free" ? 0 : b.state === "planned" ? 1 : b.state === "done" ? 2 : 3);
  const foreign = o.blocks.filter((b) => b.novelty).slice(0, 1);
  const france = o.blocks.filter((b) => !b.novelty).sort((a, b) => rank(a) - rank(b) || a.from - b.from);
  return [...france.slice(0, foreign.length ? 3 : 4), ...foreign];
}

function DayButtons({ weekStart, workDays, value, onChange }: { weekStart: string; workDays: number[]; value: number[]; onChange: (days: number[]) => void }) {
  return (
    <div className={styles.wrapRow}>
      {workDays.map((day) => (
        <button key={day} type="button" className={styles.chipToggle} aria-pressed={value.includes(day)} onClick={() => onChange(toggle(value, day))}>
          {dayName(weekStart, day)}
        </button>
      ))}
    </div>
  );
}
