"use client";

import { useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { ConfirmDialog, ErrorLine } from "@/components/auth/parts";
import { Button, Field, Loading, Notice, RetryNotice } from "@/components/ui";
import type { MonthView } from "@/server/gifts/calendar";
import type { CalendarItem } from "@/server/gifts/model";
import styles from "./gifts.module.css";

/**
 * Calendrier des occasions de kdo_help, sur la fiche de l'agent : vue par mois façon calendrier du téléphone,
 * jour sélectionné avec ses entrées, ajout et modification d'un anniversaire (proche) ou d'une occasion.
 * Mêmes données que le tchat : ce qui est ajouté ici est connu de l'agent, et inversement.
 */

const WEEKDAYS = ["L", "M", "M", "J", "V", "S", "D"];
const KIND_LABEL: Record<string, string> = { christmas: "Noël", anniversary: "Anniversaire de mariage", namesday: "Fête", other: "Autre occasion" };

type Mode = { kind: "birthday" | "event"; item: CalendarItem | null };

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function monthLabel(year: number, month: number): string {
  return new Intl.DateTimeFormat("fr-FR", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(year, month - 1, 1)));
}

function dayLabel(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function GiftCalendar() {
  const now = new Date();
  const [cursor, setCursor] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 });
  const [chosen, setSelected] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const view = useApiQuery<MonthView>(`/api/gifts/calendar?year=${cursor.year}&month=${cursor.month}`);
  // Tant que la personne n'a rien choisi, le jour sélectionné est aujourd'hui.
  const selected = chosen ?? view.data?.today ?? null;

  function move(delta: number) {
    const date = new Date(Date.UTC(cursor.year, cursor.month - 1 + delta, 1));
    setCursor({ year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 });
    setMode(null);
  }

  function goToday() {
    if (!view.data) return;
    const [y, m] = view.data.today.split("-").map(Number);
    setCursor({ year: y, month: m });
    setSelected(view.data.today);
    setMode(null);
  }

  const items = view.data?.items ?? [];
  const byDay = new Map<string, CalendarItem[]>();
  for (const item of items) byDay.set(item.date, [...(byDay.get(item.date) ?? []), item]);

  // Grille : semaines du lundi au dimanche, avec les jours voisins en grisé.
  const first = new Date(Date.UTC(cursor.year, cursor.month - 1, 1));
  const leading = (first.getUTCDay() + 6) % 7;
  const daysInMonth = new Date(Date.UTC(cursor.year, cursor.month, 0)).getUTCDate();
  const cells: { iso: string; day: number; outside: boolean }[] = [];
  for (let i = 0; i < leading; i++) {
    const d = new Date(Date.UTC(cursor.year, cursor.month - 1, i - leading + 1));
    cells.push({ iso: d.toISOString().slice(0, 10), day: d.getUTCDate(), outside: true });
  }
  for (let d = 1; d <= daysInMonth; d++) cells.push({ iso: `${cursor.year}-${pad(cursor.month)}-${pad(d)}`, day: d, outside: false });
  while (cells.length % 7 !== 0) {
    const d = new Date(Date.UTC(cursor.year, cursor.month, cells.length - leading - daysInMonth + 1));
    cells.push({ iso: d.toISOString().slice(0, 10), day: d.getUTCDate(), outside: true });
  }

  const selectedItems = selected ? (byDay.get(selected) ?? []) : [];

  return (
    <div className={styles.calendar}>
      <div className={styles.monthBar}>
        <div className={styles.monthName}>{monthLabel(cursor.year, cursor.month)}</div>
        <div className={styles.monthNav}>
          <button type="button" className={styles.todayButton} onClick={goToday}>
            Aujourd&apos;hui
          </button>
          <button type="button" className={styles.navButton} aria-label="Mois précédent" onClick={() => move(-1)}>
            ‹
          </button>
          <button type="button" className={styles.navButton} aria-label="Mois suivant" onClick={() => move(1)}>
            ›
          </button>
        </div>
      </div>

      <div className={styles.weekdays}>
        {WEEKDAYS.map((w, i) => (
          <div key={i} className={styles.weekday}>
            {w}
          </div>
        ))}
      </div>
      <div className={styles.grid} role="grid">
        {cells.map((cell) => {
          const dayItems = byDay.get(cell.iso) ?? [];
          const isToday = view.data?.today === cell.iso;
          return (
            <button
              key={cell.iso}
              type="button"
              className={`${styles.day} ${cell.outside ? styles.dayOutside : ""} ${isToday ? styles.dayToday : ""} ${selected === cell.iso ? styles.daySelected : ""}`}
              aria-label={`${dayLabel(cell.iso)}${dayItems.length ? `, ${dayItems.length} occasion(s)` : ""}`}
              aria-pressed={selected === cell.iso}
              onClick={() => {
                if (cell.outside) {
                  const [y, m] = cell.iso.split("-").map(Number);
                  setCursor({ year: y, month: m });
                }
                setSelected(cell.iso);
                setMode(null);
              }}
            >
              <span className={styles.dayNumber}>{cell.day}</span>
              <span className={styles.dots} aria-hidden>
                {dayItems.slice(0, 3).map((item) => (
                  <span key={item.key} className={`${styles.dot} ${item.kind === "birthday" ? styles.dotBirthday : ""}`} />
                ))}
              </span>
            </button>
          );
        })}
      </div>

      {view.loading && !view.data && <Loading slow={view.slow} />}
      {view.error && !view.data && <RetryNotice message={view.error.message} onRetry={view.reload} />}

      {selected && view.data && (
        <div className={styles.dayPanel}>
          <div className={styles.dayHead}>
            <div className={styles.dayTitle}>{dayLabel(selected)}</div>
            {!mode && (
              <button type="button" className={styles.addButton} aria-label="Ajouter une occasion ce jour" onClick={() => setMode({ kind: "birthday", item: null })}>
                +
              </button>
            )}
          </div>

          {!mode && selectedItems.length === 0 && <p className={styles.itemMeta}>Rien ce jour. Appuyez sur + pour ajouter un anniversaire ou une occasion.</p>}
          {!mode &&
            selectedItems.map((item) => (
              <button key={item.key} type="button" className={styles.item} onClick={() => setMode({ kind: item.source.type === "person" ? "birthday" : "event", item })}>
                <span className={`${styles.itemBar} ${item.kind === "birthday" ? styles.itemBarBirthday : ""}`} aria-hidden />
                <span>
                  <div className={styles.itemTitle}>
                    {item.kind === "birthday" ? "🎂 " : ""}
                    {item.title}
                    {item.age !== null ? ` (${item.age} ans)` : ""}
                  </div>
                  <div className={styles.itemMeta}>
                    {item.kind !== "birthday" ? `${KIND_LABEL[item.kind] ?? item.kind} · ` : ""}
                    {item.recurring ? "chaque année" : "cette année seulement"}
                    {item.budgetAmount !== null ? ` · budget ${item.budgetAmount} €` : ""}
                    {item.sorted ? " · réglée" : ""}
                  </div>
                </span>
              </button>
            ))}

          {mode && (
            <EntryForm
              key={`${mode.kind}-${mode.item?.key ?? "new"}`}
              mode={mode}
              date={selected}
              people={view.data.people}
              onDone={() => {
                setMode(null);
                view.reload();
              }}
              onCancel={() => setMode(null)}
              onSwitch={(kind) => setMode({ kind, item: null })}
            />
          )}
        </div>
      )}
    </div>
  );
}

interface FormProps {
  mode: Mode;
  date: string;
  people: MonthView["people"];
  onDone: () => void;
  onCancel: () => void;
  onSwitch: (kind: "birthday" | "event") => void;
}

/** Formulaire d'un anniversaire (proche) ou d'une occasion, en création ou en modification. */
function EntryForm({ mode, date, people, onDone, onCancel, onSwitch }: FormProps) {
  const editing = mode.item;
  const [y, m, d] = date.split("-").map(Number);
  const [name, setName] = useState(editing?.personName ?? (mode.kind === "event" ? editing?.title ?? "" : ""));
  const [relationship, setRelationship] = useState("");
  const [kind, setKind] = useState(editing && editing.kind !== "birthday" ? editing.kind : "other");
  const [day, setDay] = useState(editing ? Number(editing.date.slice(8, 10)) : d);
  const [month, setMonth] = useState(editing ? Number(editing.date.slice(5, 7)) : m);
  const [yearKnown, setYearKnown] = useState(mode.kind === "birthday" ? Boolean(editing?.age !== null && editing !== null) : !(editing?.recurring ?? true));
  const [year, setYear] = useState(mode.kind === "birthday" ? (editing?.age !== null && editing ? y - editing.age : 2000) : y);
  const [personId, setPersonId] = useState(editing?.personId ?? "");
  const [budget, setBudget] = useState(editing?.budgetAmount !== null && editing ? String(editing.budgetAmount) : "");
  const [deleting, setDeleting] = useState(false);
  const save = useApiMutation();
  const remove = useApiMutation();
  const errors = (save.error?.body?.details as { path?: (string | number)[]; message: string }[] | undefined) ?? [];
  const errorFor = (field: string) => errors.find((e) => e.path?.[0] === field)?.message;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const budgetAmount = budget.trim() === "" ? null : Number(budget.replace(",", "."));
    let result: unknown;
    if (mode.kind === "birthday") {
      const body = { name, relationship: relationship.trim() || null, birthDay: day, birthMonth: month, birthYear: yearKnown ? year : null, budgetAmount };
      result = editing ? await save.run(`/api/gifts/people/${editing.source.id}`, { method: "PATCH", body }) : await save.run("/api/gifts/people", { method: "POST", body });
    } else {
      const body = { title: name, kind, eventDay: day, eventMonth: month, eventYear: yearKnown ? year : null, personId: personId || null, budgetAmount };
      result = editing ? await save.run(`/api/gifts/events/${editing.source.id}`, { method: "PATCH", body }) : await save.run("/api/gifts/events", { method: "POST", body });
    }
    if (result) onDone();
  }

  async function confirmDelete() {
    if (!editing) return;
    const result = await remove.run(editing.source.type === "person" ? `/api/gifts/people/${editing.source.id}` : `/api/gifts/events/${editing.source.id}`, { method: "DELETE" });
    if (result) {
      setDeleting(false);
      onDone();
    }
  }

  const isBirthday = mode.kind === "birthday";

  return (
    <form className={styles.form} onSubmit={submit}>
      {!editing && (
        <div className={styles.segments} role="tablist">
          <button type="button" role="tab" aria-selected={isBirthday} className={`${styles.segment} ${isBirthday ? styles.segmentOn : ""}`} onClick={() => onSwitch("birthday")}>
            Anniversaire
          </button>
          <button type="button" role="tab" aria-selected={!isBirthday} className={`${styles.segment} ${!isBirthday ? styles.segmentOn : ""}`} onClick={() => onSwitch("event")}>
            Occasion
          </button>
        </div>
      )}

      <Field label={isBirthday ? "Prénom" : "Titre"} value={name} onChange={(e) => setName(e.target.value)} error={errorFor(isBirthday ? "name" : "title")} placeholder={isBirthday ? "Léa" : "Noël, fête des mères…"} required />
      {isBirthday && !editing && <Field label="Lien (facultatif)" value={relationship} onChange={(e) => setRelationship(e.target.value)} placeholder="fille, frère, collègue…" />}
      {!isBirthday && (
        <label className={styles.checkbox} style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Type</span>
          <select className={styles.select} value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(KIND_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
      )}

      <div style={{ display: "flex", gap: 8 }}>
        <Field label="Jour" type="number" min={1} max={31} value={day} onChange={(e) => setDay(Number(e.target.value))} required />
        <Field label="Mois" type="number" min={1} max={12} value={month} onChange={(e) => setMonth(Number(e.target.value))} required />
        {yearKnown && <Field label={isBirthday ? "Année de naissance" : "Année"} type="number" min={1900} max={2100} value={year} onChange={(e) => setYear(Number(e.target.value))} />}
      </div>
      <label className={styles.checkbox}>
        <input type="checkbox" checked={yearKnown} onChange={(e) => setYearKnown(e.target.checked)} />
        {isBirthday ? "Je connais l'année de naissance (pour afficher l'âge)" : "Une seule fois, cette année-là (sinon chaque année)"}
      </label>

      {!isBirthday && people.length > 0 && (
        <label className={styles.checkbox} style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Pour un proche (facultatif)</span>
          <select className={styles.select} value={personId} onChange={(e) => setPersonId(e.target.value)}>
            <option value="">—</option>
            {people.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.relationship ? ` (${p.relationship})` : ""}
              </option>
            ))}
          </select>
        </label>
      )}

      <Field label="Budget cadeau (€, facultatif)" type="number" min={0} step="1" value={budget} onChange={(e) => setBudget(e.target.value)} />

      {errors.length === 0 && <ErrorLine error={save.error} />}
      <div className={styles.formActions}>
        <Button type="submit" loading={save.pending}>
          {editing ? "Enregistrer" : "Ajouter"}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Annuler
        </Button>
        {editing && (
          <button type="button" className={styles.danger} onClick={() => setDeleting(true)}>
            Supprimer
          </button>
        )}
      </div>
      {editing && <Notice tone="info">{isBirthday ? "Modifie la fiche du proche : le tchat de kdo_help verra le changement." : "Une suppression reste annulable 30 jours en demandant au tchat « annule la suppression »."}</Notice>}
      {deleting && editing && (
        <ConfirmDialog
          title={isBirthday ? `Supprimer ${editing.personName} ?` : `Supprimer « ${editing.title} » ?`}
          text={isBirthday ? "Le proche, son anniversaire et ses occasions disparaissent du calendrier. Annulable 30 jours depuis le tchat." : "L'occasion disparaît du calendrier. Annulable 30 jours depuis le tchat."}
          confirmLabel="Supprimer"
          onConfirm={confirmDelete}
          onCancel={() => setDeleting(false)}
          confirming={remove.pending}
        >
          <ErrorLine error={remove.error} />
        </ConfirmDialog>
      )}
    </form>
  );
}
