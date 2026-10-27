// Importe les vacances scolaires des zones A, B et C dans `school_holiday_periods` (US-109 RT3).
//
// Source : calendrier scolaire publié par le ministère de l'Éducation nationale (data.education.gouv.fr, jeu « fr-en-calendrier-scolaire », Licence Ouverte).
// À lancer à la main par l'équipe, jamais par l'application : le service n'est jamais appelé en production. Relire le résumé avant de publier.
//
//   npx tsx scripts/import-school-holidays.ts --annees 2026-2027,2027-2028 --dry-run   # affiche seulement
//   npx tsx scripts/import-school-holidays.ts --annees 2026-2027,2027-2028             # écrit dans DATABASE_URL
//
// Convention de dates de la source : `start_date` est l'instant (UTC) du premier jour sans classe, minuit à Paris ; `end_date` est celui du jour de la rentrée, donc
// exclu : la dernière journée de vacances est la veille. Les dates sont converties en jours locaux (Europe/Paris) et `ends_on` est la veille de la rentrée.
import { Pool } from "pg";
import { poolOptions } from "../src/server/db/pool-options";
import { loadEnv } from "./lib/load-env";

const API = "https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets/fr-en-calendrier-scolaire/records";
/** Une académie représentative par zone : les dates sont les mêmes pour toute la zone. */
const REPRESENTATIVE: Record<"A" | "B" | "C", string> = { A: "Lyon", B: "Rennes", C: "Paris" };
const VACATIONS = ["Vacances de la Toussaint", "Vacances de Noël", "Vacances d'Hiver", "Vacances de Printemps", "Vacances d'Été"];

interface Record_ {
  description: string;
  start_date: string;
  end_date: string;
  zones: string;
  annee_scolaire: string;
  population: string;
}

const localDay = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
const dayBefore = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function fetchYear(zone: "A" | "B" | "C", year: string): Promise<{ zone: string; school_year: string; label: string; starts_on: string; ends_on: string }[]> {
  const params = new URLSearchParams({
    limit: "100",
    select: "description,start_date,end_date,zones,annee_scolaire,population",
    where: `annee_scolaire="${year}" AND location="${REPRESENTATIVE[zone]}" AND zones="Zone ${zone}"`,
  });
  const response = await fetch(`${API}?${params}`);
  if (!response.ok) throw new Error(`La source a répondu ${response.status} pour la zone ${zone}, ${year}.`);
  const body = (await response.json()) as { results: Record_[] };
  return body.results
    .filter((r) => VACATIONS.includes(r.description) && ["-", "Élèves"].includes(r.population))
    .map((r) => ({ zone, school_year: year, label: r.description.slice(0, 80), starts_on: localDay(r.start_date), ends_on: dayBefore(localDay(r.end_date)) }))
    .sort((a, b) => a.starts_on.localeCompare(b.starts_on));
}

loadEnv();
const years = (option("annees") ?? "").split(",").map((y) => y.trim()).filter(Boolean);
if (!years.length || years.some((y) => !/^\d{4}-\d{4}$/.test(y))) {
  console.error("Indiquez les années scolaires : --annees 2026-2027,2027-2028");
  process.exit(2);
}
const dryRun = process.argv.includes("--dry-run");

const rows = [];
for (const year of years) for (const zone of ["A", "B", "C"] as const) rows.push(...(await fetchYear(zone, year)));

for (const year of years) {
  for (const zone of ["A", "B", "C"]) {
    const mine = rows.filter((r) => r.school_year === year && r.zone === zone);
    console.log(`${year} zone ${zone} : ${mine.length} période(s)${mine.length === VACATIONS.length ? "" : "  ⚠ incomplet"}`);
    for (const r of mine) console.log(`   ${r.starts_on} → ${r.ends_on}  ${r.label}`);
  }
}
if (dryRun) {
  console.log("Simulation : rien n'a été écrit.");
  process.exit(0);
}

const pool = new Pool(poolOptions());
try {
  for (const r of rows) {
    await pool.query(
      `INSERT INTO school_holiday_periods (zone, school_year, label, starts_on, ends_on) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (zone, starts_on) DO UPDATE SET school_year = EXCLUDED.school_year, label = EXCLUDED.label, ends_on = EXCLUDED.ends_on`,
      [r.zone, r.school_year, r.label, r.starts_on, r.ends_on],
    );
  }
  console.log(`${rows.length} période(s) écrite(s).`);
} finally {
  await pool.end();
}
