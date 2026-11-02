// `npm run bench:ocr` : banc de lecture et de non-fuite de bout en bout (Contrats V2, C-16), sur des documents ENTIÈREMENT FICTIFS.
// Rend les documents du jeu annoté (scripts/lib/contract-corpus.ts) en « photos » (propre, penchée, sombre), les fait lire par le service interne, masque le texte lu et mesure :
// la lecture, ce qui reste visible (identifiants directs, noms) et ce qui est gardé. Échoue (code 1) si un identifiant direct reste lisible.
// Usage : npm run bench:ocr -- [--url https://…] ; le jeton d'identité vient de `gcloud auth print-identity-token` pour un service Cloud Run privé.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { maskDocument } from "../src/server/contracts/masking/engine";
import { CORPUS, household } from "./lib/contract-corpus";
import { loadEnv } from "./lib/load-env";

loadEnv();
const arg = process.argv.indexOf("--url");
const base = (arg > 0 ? process.argv[arg + 1] : process.env.CONTRACT_READER_URL)?.replace(/\/+$/, "");
if (!base) {
  console.error("Indiquez le service de lecture : --url https://… ou CONTRACT_READER_URL.");
  process.exit(2);
}
const headers: Record<string, string> = {};
if (new URL(base).hostname.endsWith(".run.app")) headers.Authorization = `Bearer ${execFileSync("gcloud", ["auth", "print-identity-token"], { encoding: "utf8", shell: true }).trim()}`;

const verbose = process.argv.includes("--verbose");
const dir = mkdtempSync(path.join(os.tmpdir(), "maaq-ocr-bench-"));
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]/g, "");
/** Identifiant direct : tout ce qui contient un chiffre ou un arobase (numéros, dates, email, téléphone, IBAN, plaque, adresse). */
const direct = (value: string) => /[\d@]/.test(value);

try {
  const pages: Record<string, string[]> = {};
  CORPUS.forEach((doc, i) => (pages[`doc${i + 1}`] = doc.pages));
  writeFileSync(path.join(dir, "pages.json"), JSON.stringify(pages), "utf8");
  execFileSync(process.platform === "win32" ? "python" : "python3", [path.join("services", "contract-reader", "bench", "render.py"), dir], { stdio: "inherit" });

  const totals: Record<string, { directLeaks: number; directTotal: number; nameLeaks: number; nameTotal: number; kept: number; keptTotal: number; confidence: number[]; residual: number }> = {};
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort()) {
    const [name, variant] = file.replace(".jpg", "").split("--");
    const doc = CORPUS[Number(name.replace("doc", "")) - 1];
    const form = new FormData();
    form.append("files", new Blob([readFileSync(path.join(dir, file))], { type: "image/jpeg" }), file);
    const response = await fetch(`${base}/read`, { method: "POST", body: form, headers, signal: AbortSignal.timeout(280_000) });
    if (!response.ok) throw new Error(`Lecture refusée (${response.status}) pour ${file}`);
    const read = (await response.json()) as { pages: { text: string; confidence: number; entities: { start: number; end: number; label: string }[] }[] };
    const masked = maskDocument(read.pages.map((p) => p.text), { household, now: new Date("2026-11-02T10:00:00Z"), entities: read.pages.map((p) => p.entities) });
    const seen = norm(masked.text);
    const t = (totals[variant] ??= { directLeaks: 0, directTotal: 0, nameLeaks: 0, nameTotal: 0, kept: 0, keptTotal: 0, confidence: [], residual: 0 });
    t.confidence.push(read.pages[0].confidence);
    for (const value of doc.leaks) {
      const key = norm(value);
      if (key.length < 3) continue;
      const leaked = seen.includes(key);
      if (leaked && verbose) console.log(`  fuite (${file}) : « ${value} »`);
      if (direct(value)) {
        t.directTotal += 1;
        if (leaked) t.directLeaks += 1;
      } else {
        t.nameTotal += 1;
        if (leaked) t.nameLeaks += 1;
      }
    }
    for (const value of doc.kept) {
      t.keptTotal += 1;
      if (seen.includes(norm(value))) t.kept += 1;
    }
    // Une suite de 9 chiffres ou plus qui survit (même lue de travers) est une fuite probable, que la valeur d'origine soit retrouvée ou non.
    const runs = masked.text.replace(/(?<=\d)[ .]+(?=\d)/g, "").match(/\d{9,}/g) ?? [];
    if (verbose && (runs.length || masked.residual.length)) console.log(`  résidu (${file}) : ${JSON.stringify(masked.residual)} ${runs.join(" ")}`);
    t.residual += runs.length + masked.residual.length;
  }

  let failed = false;
  console.log("variante   | confiance moy. | identifiants directs lisibles | noms lisibles | données utiles gardées | résidus signalés");
  for (const [variant, t] of Object.entries(totals)) {
    const avg = Math.round(t.confidence.reduce((a, b) => a + b, 0) / t.confidence.length);
    console.log(`${variant.padEnd(10)} | ${String(avg).padStart(3)} %          | ${t.directLeaks}/${t.directTotal}`.padEnd(66) + `| ${t.nameLeaks}/${t.nameTotal}`.padEnd(16) + `| ${t.kept}/${t.keptTotal}`.padEnd(25) + `| ${t.residual}`);
    if (t.directLeaks > 0 || t.residual > 0) failed = true;
  }
  if (failed) {
    console.error("\nÉCHEC : un identifiant direct reste lisible après masquage (seuil C-16 : aucun).");
    process.exitCode = 1;
  } else console.log("\nSeuil C-16 tenu sur ce jeu : aucun identifiant direct lisible.");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
