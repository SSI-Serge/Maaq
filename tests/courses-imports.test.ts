import { zipSync, strToU8 } from "fflate";
import { describe, expect, it } from "vitest";
import { describeIssues, validateTable } from "@/server/courses/imports/spec";
import { PLANNINGS_SPEC, VERSIONS_SPEC } from "@/server/courses/imports/specs";
import { ImportFileError, parseCsv, readTable, toCsv } from "@/server/courses/imports/table";

const csv = (text: string, name = "fichier.csv") => readTable({ name, content: Buffer.from(text, "utf8") });

const HEAD = "id_semaine;cuisine;theme;lundi;mardi;mercredi;jeudi;vendredi;ids;etapes;temps_total_min;mutualisation_pct";
const GOOD = "AS1;Français;Classiques;Poulet rôti;Gratin;Quiche;Soupe;Blanquette;F1|F2|F3|F4|F5;Cuire | Mixer;110;40";

function xlsx(rows: string[][]): Buffer {
  const cell = (v: string, c: number, r: number) => `<c r="${String.fromCharCode(65 + c)}${r + 1}" t="inlineStr"><is><t>${v.replace(/&/g, "&amp;")}</t></is></c>`;
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
    .map((row, r) => `<row r="${r + 1}">${row.map((v, c) => cell(v, c, r)).join("")}</row>`)
    .join("")}</sheetData></worksheet>`;
  const files = {
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ),
    "_rels/.rels": strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    "xl/workbook.xml": strToU8('<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Feuille1" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
    "xl/worksheets/sheet1.xml": strToU8(sheet),
  };
  return Buffer.from(zipSync(files));
}

describe("Imports de la console Courses et repas : lecture des fichiers", () => {
  it("CSV : séparateur ; ou , détecté, BOM retiré, guillemets et retours à la ligne dans une cellule", () => {
    expect(parseCsv("﻿a;b\r\n1;2\r\n")).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsv('a,b\n"x, y","il dit ""oui"""\n"ligne 1\nligne 2",z')).toEqual([["a", "b"], ["x, y", 'il dit "oui"'], ["ligne 1\nligne 2", "z"]]);
  });

  it("les lignes vides sont sautées, les numéros de ligne restent ceux du fichier", async () => {
    const t = await csv("a;b\n1;2\n\n;\n3;4\n");
    expect(t.rows).toEqual([["a", "b"], ["1", "2"], ["3", "4"]]);
    expect(t.lines).toEqual([1, 2, 5]);
  });

  it("xlsx : première feuille lue comme un CSV", async () => {
    const t = await readTable({ name: "plannings.xlsx", content: xlsx([HEAD.split(";"), GOOD.split(";")]) });
    expect(t.rows[1][0]).toBe("AS1");
    const out = validateTable(PLANNINGS_SPEC, t, undefined);
    expect(out.issues).toEqual([]);
    expect(out.rows).toHaveLength(1);
  });

  it("fichier vide, format inconnu ou xlsx illisible : refusés", async () => {
    await expect(csv("")).rejects.toMatchObject({ code: "empty" });
    await expect(csv("a", "notes.pdf")).rejects.toBeInstanceOf(ImportFileError);
    await expect(readTable({ name: "x.xlsx", content: Buffer.from("pas un classeur") })).rejects.toMatchObject({ code: "unreadable" });
  });

  it("le modèle à télécharger est un CSV ; avec BOM, accents et guillemets corrects", () => {
    const out = toCsv(["id", "texte"], [["A1", 'dit "oui"; fin'], ["A2", null]]);
    expect(out).toBe('﻿id;texte\r\nA1;"dit ""oui""; fin"\r\nA2;\r\n');
    expect(parseCsv(out)[1]).toEqual(["A1", 'dit "oui"; fin']);
  });
});

describe("Imports de la console Courses et repas : vérification de tout le fichier", () => {
  it("fichier valide : les lignes sont lues avec leurs valeurs typées", async () => {
    const out = validateTable(PLANNINGS_SPEC, await csv(`${HEAD}\n${GOOD}\n`), undefined);
    expect(out.issues).toEqual([]);
    expect(out.rows[0].values).toMatchObject({
      id_semaine: "AS1",
      ids: ["F1", "F2", "F3", "F4", "F5"],
      etapes: ["Cuire", "Mixer"],
      temps_total_min: 110,
      mutualisation_pct: 40,
    });
  });

  it("une ligne sans durée refuse tout l'import et nomme la ligne et la colonne", async () => {
    const bad = "AS2;Italien;;Lasagnes;Risotto;Pizza;Gnocchi;Tiramisu;;;;";
    const out = validateTable(PLANNINGS_SPEC, await csv(`${HEAD}\n${GOOD}\n${bad}\n`), undefined);
    expect(out.rows).toEqual([]);
    expect(describeIssues(out.issues)).toEqual(["ligne 3, colonne « temps_total_min » : valeur obligatoire manquante."]);
  });

  it("durée non numérique, pourcentage hors limites, ids qui ne comptent pas 5 valeurs : chacun signalé", async () => {
    const row = "AS3;Italien;;a;b;c;d;e;X|Y;;abc;150";
    const out = validateTable(PLANNINGS_SPEC, await csv(`${HEAD}\n${row}\n`), undefined);
    expect(out.issues.map((i) => i.column).sort()).toEqual(["ids", "mutualisation_pct", "temps_total_min"]);
    expect(out.issues.every((i) => i.line === 2)).toBe(true);
  });

  it("colonne obligatoire absente : refus avec son nom", async () => {
    const out = validateTable(PLANNINGS_SPEC, await csv("id_semaine;cuisine\nAS1;Français\n"), undefined);
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0].message).toContain("lundi");
    expect(out.rows).toEqual([]);
  });

  it("deux lignes avec le même identifiant : refusé", async () => {
    const out = validateTable(PLANNINGS_SPEC, await csv(`${HEAD}\n${GOOD}\n${GOOD}\n`), undefined);
    expect(describeIssues(out.issues)).toEqual(["ligne 3, colonne « id_semaine » : identifiant « AS1 » déjà présent à la ligne 2."]);
  });

  it("en-têtes tolérants : majuscules, accents et espaces", async () => {
    const head = "Id semaine;Cuisine;Thème;Lundi;Mardi;Mercredi;Jeudi;Vendredi;IDS;Étapes;Temps total min;Mutualisation pct";
    const out = validateTable(PLANNINGS_SPEC, await csv(`${head}\n${GOOD}\n`), undefined);
    expect(out.issues).toEqual([]);
    expect(out.rows[0].values.theme).toBe("Classiques");
  });

  it("versions allégées : un identifiant de plat inconnu refuse tout l'import", async () => {
    const ctx = { knownDishIds: new Set(["F1", "F2"]) };
    const file = "id_plat;plat;retirer;ajouter;texte_source\nF1;Lasagnes;pates|creme;pates semi-completes;Texte\nZ99;Inconnu;;;\n";
    const out = validateTable(VERSIONS_SPEC, await csv(file), ctx);
    expect(out.rows).toEqual([]);
    expect(describeIssues(out.issues)).toEqual(["ligne 3, colonne « id_plat » : identifiant « Z99 » inconnu dans le catalogue."]);
    const ok = validateTable(VERSIONS_SPEC, await csv(file.split("\n").slice(0, 2).join("\n")), ctx);
    expect(ok.rows[0].values).toMatchObject({ retirer: ["pates", "creme"], ajouter: ["pates semi-completes"] });
  });

  it("le rapport s'arrête à 100 problèmes", async () => {
    const lines = Array.from({ length: 150 }, (_, i) => `S${i};Fr;;a;b;c;d;e;;;0;`).join("\n");
    const out = validateTable(PLANNINGS_SPEC, await csv(`${HEAD}\n${lines}\n`), undefined);
    expect(out.issues).toHaveLength(101);
    expect(out.issues[100].message).toMatch(/autre\(s\) problème/);
  });
});
