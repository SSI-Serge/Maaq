import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { deriveDishTags, linkPlans, Matcher, type Dish, type Plan } from "@/server/courses/engine";
import { parseCsv } from "@/server/courses/imports/table";

/**
 * Parité avec courses.py (agent Digitorn) : les fixtures viennent du classeur de référence et de l'exécution du script par le BA le 06/11/2026
 * (semaine du 2026-11-09, mois de novembre, historique vide). Écarts voulus, la spec primant : plats express limités à 15 minutes (US-156 RF4).
 */
const dir = path.join(process.cwd(), "tests", "fixtures", "courses");
interface CatalogDish { id: string; cuisine: string; name: string; ing: string; recipe: string; health: string; batch: string; time: string; minutes: number; tags: string[] }
const catalog = JSON.parse(readFileSync(path.join(process.cwd(), "db", "seed", "courses", "catalog.json"), "utf8")) as { dishes: CatalogDish[]; plans: Plan[]; allege: { id: string; remove: string[]; add: string[] }[] };

const dishes: Dish[] = catalog.dishes.map((d) => ({ ...d, tags: new Set(d.tags) }));

describe("Parité avec courses.py : le catalogue", () => {
  it("les 60 plats et leurs étiquettes déduites sont identiques à celles du script", () => {
    expect(dishes).toHaveLength(60);
    for (const d of catalog.dishes) {
      expect([...deriveDishTags(d.name, d.ing)].sort(), `étiquettes de ${d.id}`).toEqual(d.tags);
    }
  });

  it("34 plats sur 60 ont une version allégée structurée", () => {
    expect(catalog.allege.filter((a) => a.remove.length || a.add.length)).toHaveLength(34);
  });
});

describe("Parité avec courses.py : semaines types et correspondances", () => {
  const linked = linkPlans(catalog.plans, dishes);

  it("12 semaines, 4 bloquées (AS2, AS4, FS1, FS3), plats reliés par semaine", () => {
    expect(linked).toHaveLength(12);
    const blocked = linked.filter((p) => p.match.some((m) => m[1] === "absent")).map((p) => p.id);
    expect(blocked).toEqual(["AS2", "AS4", "FS1", "FS3"]);
    const sure = Object.fromEntries(linked.map((p) => [p.id, p.match.filter((m) => m[1] === "ok").length]));
    expect(sure).toEqual({ AS1: 4, AS2: 2, AS3: 2, AS4: 1, FS1: 4, FS2: 3, FS3: 4, FS4: 5, IS1: 5, IS2: 5, IS3: 5, IS4: 5 });
  });

  it("15 plats sans correspondance sûre : 4 absents, 11 à confirmer, ligne par ligne comme le fichier du script", () => {
    const expected = parseCsv(readFileSync(path.join(dir, "plats_planning_sans_catalogue.csv"), "utf8")).slice(1);
    const days = ["Lundi", "Mardi", "Mercredi", "Jeudi", "Vendredi"];
    const rows: string[][] = [];
    for (const p of linked) {
      p.match.forEach((m, j) => {
        if (m[1] === "ok") return;
        rows.push([p.id, days[j], m[1] === "absent" ? "absent_du_catalogue" : "correspondance_a_confirmer", m[3] ?? "", String(Math.round(m[2] * 100)), m[1] === "absent" ? "oui" : "non"]);
      });
    }
    expect(rows).toHaveLength(15);
    expect(rows.filter((r) => r[5] === "oui")).toHaveLength(4);
    const pick = (r: string[]) => [r[0], r[1], r[5], r[6], r[8], r[10]];
    expect(rows).toEqual(expected.map((r) => [r[0], r[1], r[5], r[6], r[8], r[10]]));
    void pick;
  });

  it("pourcentage de correspondance d'un nom de plat : 58 %, 48 % et 100 % comme le script", () => {
    const m = new Matcher(dishes);
    const top = (name: string) => m.top(name, 3).map((x) => `${x.id}:${Math.round(x.score * 100)}`);
    expect(top("Velouté de courge butternut")[0]).toBe("F1:58");
    expect(top("Boulettes de bœuf mijotées à la sauce tomate")).toEqual(["F14:48", "A15:45", "I16:34"]);
    expect(top("Poulet yassa")[0]).toBe("A14:100");
  });
});
