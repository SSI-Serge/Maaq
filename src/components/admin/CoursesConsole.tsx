"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useRef, useState } from "react";
import { useApiMutation, useApiQuery } from "@/client/hooks";
import { Button, Loading, Notice, RetryNotice } from "@/components/ui";
import type { ConsoleRow, ConsoleSummary, ConsoleTable, FormField, ObjectKey, RowAction } from "@/server/courses/console/types";
import { PageHead } from "./AdminShell";
import styles from "./admin.module.css";

interface Nav {
  nav: { key: ObjectKey; label: string }[];
  summary: ConsoleSummary;
}

const TONE: Record<NonNullable<ConsoleRow["tone"]>, string> = { ok: styles.badgeOk, info: styles.badgeNeutral, warn: styles.badgeWarn, muted: styles.badgeNeutral };

/** Console du catalogue commun de « Courses et repas » (maquette Admin-Courses) : la liste des objets, puis un tableau, des filtres et des actions par ligne. */
export function CoursesConsole() {
  const params = useSearchParams();
  const router = useRouter();
  const object = (params.get("objet") ?? "plats") as ObjectKey;
  const nav = useApiQuery<Nav>("/api/admin/courses/summary");
  return (
    <>
      <nav aria-label="Courses et repas" style={{ display: "flex", gap: 24, alignItems: "flex-start" }}>
        <div style={{ width: 250, flex: "none" }}>
          <div className={`${styles.small} ${styles.muted}`} style={{ margin: "0 0 8px", fontWeight: 700 }}>
            Agent natif · Courses et repas
          </div>
          {nav.data?.nav.map((item) => {
            const available = nav.data!.summary.available.includes(item.key);
            const count = nav.data!.summary.counts[item.key];
            return (
              <button
                key={item.key}
                type="button"
                disabled={!available}
                aria-current={item.key === object ? "page" : undefined}
                className={`${styles.navLink} ${item.key === object ? styles.navActive : ""}`}
                style={{ width: "100%", textAlign: "left", color: "inherit", opacity: available ? 1 : 0.45 }}
                onClick={() => router.replace(`/admin/courses?objet=${item.key}`)}
              >
                <span style={{ flex: 1 }}>{item.label}</span>
                {!available && <span className={`${styles.small}`}>bientôt</span>}
                {available && count && (
                  <span className={`${styles.badge} ${count.todo ? styles.badgeWarn : styles.badgeNeutral}`} aria-label={count.todo ? `${count.n} à traiter` : `${count.n}`}>
                    {count.n}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <p className={styles.small} style={{ margin: "0 0 6px" }}>
            <Link href="/admin/agents">Agents</Link> › Courses et repas
          </p>
          <ObjectView key={object} object={object} onChanged={nav.reload} />
        </div>
      </nav>
    </>
  );
}

function ObjectView({ object, onChanged }: { object: ObjectKey; onChanged: () => void }) {
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Record<string, string>>({});
  const qs = new URLSearchParams();
  if (q.trim()) qs.set("q", q.trim());
  for (const [k, v] of Object.entries(filters)) if (v) qs.set(`f_${k}`, v);
  const suffix = qs.toString() ? `?${qs}` : "";
  const query = useApiQuery<{ table: ConsoleTable }>(`/api/admin/courses/${object}${suffix}`);
  const act = useApiMutation();
  const [done, setDone] = useState<string | null>(null);
  const [dialog, setDialog] = useState<{ row: ConsoleRow | null; action: RowAction } | null>(null);
  const [adding, setAdding] = useState(false);

  const table = query.data?.table;

  async function run(action: string, id: string, values: Record<string, string>) {
    const ok = await act.run("/api/admin/courses/" + object, { method: "POST", body: { action, id, values } });
    if (ok) {
      setDone("✓ Fait. Inscrit au journal d'administration.");
      setDialog(null);
      setAdding(false);
      query.reload();
      onChanged();
    }
  }

  function start(row: ConsoleRow, action: RowAction) {
    setDone(null);
    if (action.fields || action.confirm || action.readOnly) setDialog({ row, action });
    else void run(action.key, row.id, {});
  }

  if (query.loading && !table) return <Loading slow={query.slow} />;
  if (query.error && !table) {
    const unavailable = query.error.body?.code === "not_available";
    return unavailable ? <Notice tone="info">Cet écran de la console n&apos;est pas encore disponible.</Notice> : <RetryNotice message={query.error.message} onRetry={query.reload} />;
  }
  if (!table) return null;

  const downloadUrl = (file: string) => `/api/admin/courses/${object}/download?file=${file}${qs.toString() ? `&${qs}` : ""}`;

  return (
    <>
      <PageHead title={table.title} lead={table.intro} />
      {(table.tools.downloads?.length || table.tools.add) && (
        <div className={styles.row} style={{ marginBottom: 12 }}>
          {table.tools.downloads?.map((d) => (
            <a key={d.key} className={styles.linkButton} href={downloadUrl(d.key)} download>
              {d.label}
            </a>
          ))}
          {table.tools.add && (
            <Button variant="ghost" onClick={() => { setDone(null); setAdding(true); }}>
              + {table.tools.add.label}
            </Button>
          )}
        </div>
      )}
      {table.tools.import && <ImportTool object={object} replaceAll={table.tools.import.replaceAll} check={!!table.tools.import.check} checkOnly={!!table.tools.import.checkOnly} onDone={(msg) => { setDone(msg); query.reload(); onChanged(); }} />}
      {table.tools.lookup && <LookupTool object={object} label={table.tools.lookup.label} placeholder={table.tools.lookup.placeholder} />}
      {done && (
        <p role="status" className={`${styles.badge} ${styles.badgeOk}`} style={{ marginBottom: 10 }}>
          {done}
        </p>
      )}
      {act.error && !dialog && !adding && <Notice tone="error">{act.error.message}</Notice>}
      {table.info && <p className={`${styles.small} ${styles.muted}`}>{table.info}</p>}
      {(table.search || table.filters.length > 0) && (
        <div className={styles.row} style={{ marginBottom: 12 }}>
          {table.search && <input className={styles.search} type="search" aria-label="Rechercher" placeholder="Rechercher" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />}
          {table.filters.map((f) => (
            <select key={f.key} aria-label={f.label} value={filters[f.key] ?? f.value} onChange={(e) => setFilters({ ...filters, [f.key]: e.target.value })} style={{ padding: "8px 10px", borderRadius: 8, border: "1px solid var(--line)", background: "var(--bg-raised)" }}>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          ))}
        </div>
      )}
      <table className={styles.table}>
        <thead>
          <tr>
            {table.columns.map((c) => (
              <th key={c.key} scope="col" className={c.align === "right" ? styles.cellRight : undefined}>
                {c.label}
              </th>
            ))}
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {table.rows.length === 0 && (
            <tr>
              <td colSpan={table.columns.length + 1} className={styles.empty}>
                Aucune ligne.
              </td>
            </tr>
          )}
          {table.rows.map((r) => (
            <tr key={r.id} style={r.tone === "muted" ? { opacity: 0.6 } : undefined}>
              {table.columns.map((c) => (
                <td key={c.key} className={c.align === "right" ? styles.cellRight : undefined}>
                  {r.cells[c.key] === null || r.cells[c.key] === "" ? "—" : String(r.cells[c.key])}
                </td>
              ))}
              <td>
                {r.tone && r.tone !== "muted" && <span className={`${styles.badge} ${TONE[r.tone]}`} style={{ marginRight: 6 }} aria-hidden="true">●</span>}
                {r.actions.map((a) => (
                  <button key={a.key} type="button" className={`${styles.linkButton} ${a.confirm ? styles.dangerLink : ""}`} disabled={act.pending} onClick={() => start(r, a)}>
                    {a.label}
                  </button>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className={`${styles.small} ${styles.muted}`}>
        {table.total > table.rows.length ? `Les ${table.rows.length} premières lignes sur ${table.total}. Affinez avec la recherche ou les filtres.` : `${table.total} ligne${table.total > 1 ? "s" : ""}.`} {table.footer}
      </p>

      {dialog && (
        <FormDialog
          title={dialog.action.label}
          confirm={dialog.action.confirm}
          fields={dialog.action.fields ?? []}
          readOnly={dialog.action.readOnly}
          pending={act.pending}
          error={act.error?.message}
          onCancel={() => setDialog(null)}
          onSubmit={(values) => void run(dialog.action.key, dialog.row?.id ?? "", values)}
        />
      )}
      {adding && table.tools.add && (
        <FormDialog title={table.tools.add.label} fields={table.tools.add.fields} pending={act.pending} error={act.error?.message} onCancel={() => setAdding(false)} onSubmit={(values) => void run("add", "", values)} />
      )}
    </>
  );
}

function FormDialog({ title, confirm, fields, pending, error, readOnly, onCancel, onSubmit }: { title: string; confirm?: string; fields: FormField[]; pending: boolean; error?: string; readOnly?: boolean; onCancel: () => void; onSubmit: (values: Record<string, string>) => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.key, f.value === null || f.value === undefined ? (f.options?.[0]?.value ?? "") : String(f.value)])));
  return (
    <div className={styles.backdrop}>
      <form
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={styles.dialog}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(values);
        }}
      >
        <h2 className={styles.dialogTitle}>{title}</h2>
        {confirm && <p style={{ margin: 0 }}>{confirm}</p>}
        {fields.map((f) =>
          f.type === "info" ? (
            <div key={f.key} className={styles.label}>
              {f.label}
              <div style={{ whiteSpace: "pre-wrap", fontWeight: 400, fontSize: 13, lineHeight: 1.5 }}>{String(f.value ?? "")}</div>
            </div>
          ) : f.type === "chips" ? (
            <div key={f.key} className={styles.label} role="group" aria-label={f.label}>
              {f.label}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, paddingTop: 4 }}>
                {f.options?.map((o) => {
                  const picked = (values[f.key] ?? "").split(",").filter(Boolean);
                  const on = picked.includes(o.value);
                  return (
                    <button
                      key={o.value}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setValues({ ...values, [f.key]: (on ? picked.filter((x) => x !== o.value) : [...picked, o.value]).join(",") })}
                      style={{ minHeight: 30, padding: "0 12px", borderRadius: 100, fontSize: 12, fontWeight: 700, border: `1px solid ${on ? "var(--primary)" : "var(--line)"}`, background: on ? "var(--primary)" : "var(--bg-raised)", color: on ? "var(--primary-ink)" : "var(--ink)", cursor: "pointer" }}
                    >
                      {o.label}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
          <label key={f.key} className={styles.label}>
            {f.label}
            {f.type === "select" ? (
              <select value={values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} style={{ width: "100%", padding: 8 }}>
                {f.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : f.type === "textarea" ? (
              <textarea className={styles.textarea} value={values[f.key]} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} />
            ) : (
              <input type={f.type === "number" ? "number" : "text"} value={values[f.key]} required={f.required} onChange={(e) => setValues({ ...values, [f.key]: e.target.value })} style={{ width: "100%", padding: 8 }} />
            )}
            {f.help && <span style={{ display: "block", fontWeight: 400, fontSize: 12, lineHeight: 1.4, color: "var(--ink-soft)", paddingTop: 2 }}>{f.help}</span>}
          </label>
          ),
        )}
        {error && <Notice tone="error">{error}</Notice>}
        <div className={styles.actions}>
          <Button variant="ghost" type="button" onClick={onCancel}>
            {readOnly ? "Fermer" : "Annuler"}
          </Button>
          {!readOnly && (
            <Button type="submit" loading={pending}>
              {fields.length || !confirm ? "Enregistrer" : "Confirmer"}
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

function ImportTool({ object, replaceAll, check, checkOnly, onDone }: { object: ObjectKey; replaceAll: boolean; check: boolean; checkOnly: boolean; onDone: (message: string) => void }) {
  const send = useApiMutation();
  const input = useRef<HTMLInputElement>(null);
  const [replace, setReplace] = useState(false);
  const [dryChoice, setDry] = useState(false);
  const dry = dryChoice || checkOnly;
  const [lines, setLines] = useState<string[]>([]);
  const [issues, setIssues] = useState<string[]>([]);

  async function pick(file: File | undefined) {
    if (!file) return;
    setLines([]);
    setIssues([]);
    const body = new FormData();
    body.append("file", file);
    if (replace) body.append("replace", "1");
    if (dry) body.append("dry", "1");
    const result = await send.run<{ count: number; lines: string[] }>(`/api/admin/courses/${object}/import`, { method: "POST", body });
    if (input.current) input.current.value = "";
    if (result) {
      setLines(result.lines);
      if (!dry) onDone(`✓ Fichier vérifié et importé : ${result.count} ligne${result.count > 1 ? "s" : ""} ${replace ? "remplacée" : "ajoutée ou mise à jour"}${result.count > 1 ? "s" : ""}. Inscrit au journal d'administration.`);
    } else {
      setIssues(((send.error?.body?.details as { issues?: string[] } | undefined)?.issues) ?? []);
    }
  }

  return (
    <div className={styles.panel} style={{ marginBottom: 12 }}>
      <div className={styles.row}>
        {replaceAll && !dry && (
          <label className={styles.row} style={{ gap: 6 }}>
            <input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} /> Tout remplacer
          </label>
        )}
        {check && !checkOnly && (
          <label className={styles.row} style={{ gap: 6 }}>
            <input type="checkbox" checked={dry} onChange={(e) => setDry(e.target.checked)} /> Contrôler sans importer
          </label>
        )}
        <Button variant="ghost" onClick={() => input.current?.click()} loading={send.pending}>
          {dry ? "Contrôler un fichier" : "Importer un fichier"}
        </Button>
        <input ref={input} type="file" hidden accept=".csv,.xlsx,text/csv" onChange={(e) => void pick(e.target.files?.[0])} />
      </div>
      {send.error && (
        <Notice tone="error">
          <strong>{send.error.message}</strong>
          {issues.map((i) => (
            <div key={i}>{i}</div>
          ))}
        </Notice>
      )}
      {lines.length > 0 && (
        <div className={`${styles.small}`} role="status" style={{ marginTop: 8 }}>
          {lines.map((l) => (
            <div key={l}>{l}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function LookupTool({ object, label, placeholder }: { object: ObjectKey; label: string; placeholder: string }) {
  const run = useApiMutation();
  const [value, setValue] = useState("");
  const [lines, setLines] = useState<string[]>([]);
  async function go() {
    const result = await run.run<{ lines: string[] }>(`/api/admin/courses/${object}/lookup`, { method: "POST", body: { value } });
    if (result) setLines(result.lines);
  }
  return (
    <div className={styles.panel} style={{ marginBottom: 12 }}>
      <div className={styles.row}>
        <input className={styles.search} aria-label={placeholder} placeholder={placeholder} value={value} onChange={(e) => setValue(e.target.value)} style={{ maxWidth: 280 }} />
        <Button variant="ghost" onClick={() => void go()} loading={run.pending} disabled={!value.trim()}>
          {label}
        </Button>
      </div>
      {run.error && <Notice tone="error">{run.error.message}</Notice>}
      {lines.length > 0 && (
        <p role="status" className={styles.small} style={{ margin: "8px 0 0" }}>
          Plus proches du catalogue : {lines.join(" · ")}
        </p>
      )}
    </div>
  );
}
