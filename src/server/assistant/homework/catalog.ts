import { sql, type Kysely } from "kysely";
import type { DB, HomeworkActivityCategory, HomeworkLevel } from "@/server/db/schema.generated";
import data from "./catalogue.json";

/**
 * Catalogue de l'aide Devoirs (US-119 RT4) : exercices de maths des manuels France, Singapour et Chine (CP à CM2, 25 par niveau) et activités d'éveil
 * (six catégories, une carte illustrée chacune). Il est préparé une fois à partir des manuels et des fiches dont MAAQ a les droits (D64, S-09). La base garde ce
 * qui sert aux règles : numéro, thème et corrigé des exercices, âge et carte des activités. Les énoncés, les étapes et le matériel sont dans `catalogue.json`,
 * à côté du code : ils ne servent qu'à l'affichage et ne concernent aucune donnée de famille.
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
  description: string;
  materiel: string;
  etapes: string[];
}
const file = data as unknown as { maths: Record<string, Record<string, FileExercise[]>>; activites: FileActivity[] };

/** Énoncé d'un exercice, pour l'écran de la semaine. */
export function exerciseStatement(textbook: string, level: HomeworkLevel, number: number): string {
  return file.maths[textbook]?.[level]?.find((x) => x.n === number)?.enonce ?? "";
}

export interface ActivityContent {
  description: string;
  materials: string;
  steps: string[];
  needsAdult: boolean;
  cardRef: string;
}

/** Contenu d'une activité du catalogue, retrouvée par sa catégorie et son titre. */
export function activityContent(category: HomeworkActivityCategory, title: string): ActivityContent | null {
  const found = file.activites.find((a) => CATEGORY_OF_FILE[a.cat] === category && a.titre === title);
  return found ? { description: found.description, materials: found.materiel, steps: found.etapes, needsAdult: found.adulte, cardRef: found.id } : null;
}

export const cardUrl = (cardRef: string | null): string | null => (cardRef ? `/devoirs/cartes/${cardRef}.png` : null);

export interface CatalogLoad {
  exercises: number;
  activities: number;
}

/**
 * Charge le catalogue dans la base. Rejouable : une ligne existante est mise à jour sans être supprimée (les progrès la désignent). Une activité qui convient à
 * plusieurs âges (« 6-7 ans ») a une ligne par âge, avec la même carte : la sélection « à un an près » se fait alors sur la seule colonne d'âge.
 */
export async function loadHomeworkCatalog(db: Db): Promise<CatalogLoad> {
  let exercises = 0;
  for (const [textbook, levels] of Object.entries(file.maths)) {
    for (const [level, list] of Object.entries(levels)) {
      for (const x of list) {
        await db
          .insertInto("homework_exercises")
          .values({ textbook_key: textbook, level: level as HomeworkLevel, number: x.n, theme: x.theme, answer: x.corrige || null })
          .onConflict((oc) => oc.columns(["textbook_key", "level", "number"]).doUpdateSet({ theme: x.theme, answer: x.corrige || null }))
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
        .values({ category: CATEGORY_OF_FILE[a.cat], title: a.titre, age, needs_adult: a.adulte, card_ref: a.id })
        .onConflict((oc) => oc.columns(["category", "title", "age"]).doUpdateSet({ needs_adult: a.adulte, card_ref: a.id }))
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
