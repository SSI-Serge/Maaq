import { readFileSync } from "node:fs";
import path from "node:path";
import { sql, type Kysely } from "kysely";
import type { DB, HomeworkActivityCategory, HomeworkLevel } from "@/server/db/schema.generated";

/**
 * Catalogue de l'aide Devoirs (US-119 RT4) : exercices de maths des manuels France, Singapour et Chine (CP à CM2, 25 par niveau) et activités d'éveil
 * (six catégories, une carte illustrée chacune). Il est préparé une fois à partir des manuels et des fiches dont MAAQ a les droits (D64, S-09) et porté par la base
 * (D66) : numéro, thème, énoncé et corrigé des exercices ; âge, étapes, matériel et carte des activités. Ce sont des contenus de référence, sans donnée de famille.
 * Le fichier source `data/catalogue-devoirs.json` ne sert qu'au chargement (`scripts/load-homework-catalog.ts`) : l'application ne le lit plus.
 */

type Db = Kysely<DB>;

export const LEVELS: HomeworkLevel[] = ["cp", "ce1", "ce2", "cm1", "cm2"];
export const LEVEL_LABEL: Record<HomeworkLevel, string> = { cp: "CP", ce1: "CE1", ce2: "CE2", cm1: "CM1", cm2: "CM2" };

/** Les six catégories d'activités, dans l'ordre proposé au parent. */
export const ACTIVITY_CATEGORIES: { key: HomeworkActivityCategory; label: string }[] = [
  { key: "nature", label: "Nature" },
  { key: "philosophy", label: "Philo" },
  { key: "stem", label: "STIM" },
  { key: "art", label: "Art" },
  { key: "imagination", label: "Imagination" },
  { key: "games_projects", label: "Jeux et projets" },
];
export const categoryLabel = (key: HomeworkActivityCategory | string): string => ACTIVITY_CATEGORIES.find((c) => c.key === key)?.label ?? key;

/** Nom des catégories dans le fichier du catalogue, celui des scripts d'origine, vers celui de la base. */
const CATEGORY_OF_FILE: Record<string, HomeworkActivityCategory> = { nature: "nature", philo: "philosophy", stim: "stem", art: "art", imagination: "imagination", projets: "games_projects" };

export const TEXTBOOKS = { france: "france", singapore: "singapore", china: "china" } as const;

export const cardUrl = (cardRef: string | null): string | null => (cardRef ? `/devoirs/cartes/${cardRef}.png` : null);

interface FileExercise {
  n: number;
  theme: string;
  enonce: string;
  corrige: string;
}
interface FileActivity {
  id: string;
  cat: string;
  titre: string;
  ageMin: number;
  ageMax: number;
  adulte: boolean;
  materiel: string;
  etapes: string[];
}
export interface CatalogFile {
  maths: Record<string, Record<string, FileExercise[]>>;
  activites: FileActivity[];
}

/** Les étapes d'une activité sont portées par un seul texte, une étape par ligne. */
export const joinSteps = (steps: string[]): string | null => steps.map((s) => s.trim()).filter(Boolean).join("\n") || null;
export const splitSteps = (steps: string | null): string[] => (steps ? steps.split("\n").filter(Boolean) : []);

/** Fichier source du catalogue, lu seulement par le chargement. */
export function readCatalogFile(file = path.join(process.cwd(), "data", "catalogue-devoirs.json")): CatalogFile {
  return JSON.parse(readFileSync(file, "utf8")) as CatalogFile;
}

export interface CatalogLoad {
  exercises: number;
  activities: number;
}

/**
 * Charge le catalogue dans la base. Rejouable : une ligne existante est mise à jour sans être supprimée (les progrès la désignent). Une activité qui convient à
 * plusieurs âges (« 6-7 ans ») a une ligne par âge, avec la même carte : la sélection « à un an près » se fait alors sur la seule colonne d'âge.
 */
export async function loadHomeworkCatalog(db: Db, file: CatalogFile = readCatalogFile()): Promise<CatalogLoad> {
  let exercises = 0;
  for (const [textbook, levels] of Object.entries(file.maths)) {
    for (const [level, list] of Object.entries(levels)) {
      for (const x of list) {
        await db
          .insertInto("homework_exercises")
          .values({ textbook_key: textbook, level: level as HomeworkLevel, number: x.n, theme: x.theme, answer: x.corrige || null, statement: x.enonce.trim() || null })
          .onConflict((oc) => oc.columns(["textbook_key", "level", "number"]).doUpdateSet({ theme: x.theme, answer: x.corrige || null, statement: x.enonce.trim() || null }))
          .execute();
        exercises += 1;
      }
    }
  }
  let activities = 0;
  for (const a of file.activites) {
    for (let age = a.ageMin; age <= a.ageMax; age++) {
      await db
        .insertInto("homework_activities")
        .values({ category: CATEGORY_OF_FILE[a.cat], title: a.titre, age, needs_adult: a.adulte, card_ref: a.id, steps: joinSteps(a.etapes), materials: a.materiel.trim() || null })
        .onConflict((oc) => oc.columns(["category", "title", "age"]).doUpdateSet({ needs_adult: a.adulte, card_ref: a.id, steps: joinSteps(a.etapes), materials: a.materiel.trim() || null }))
        .execute();
      activities += 1;
    }
  }
  return { exercises, activities };
}

/** Vrai si le catalogue est chargé (sans lui, l'aide ne peut rien proposer). */
export async function homeworkCatalogLoaded(db: Db): Promise<boolean> {
  const row = await db.selectFrom("homework_exercises").select(sql<number>`count(*)::int`.as("n")).executeTakeFirstOrThrow();
  return row.n > 0;
}
