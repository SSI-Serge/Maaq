/**
 * Page d'exercices créée à partir d'une leçon (US-180) : sa forme, et le contrôle fait par le code avant tout enregistrement (RT1). Sans dépendance serveur : l'écran
 * l'utilise pour afficher la page. L'énoncé et la fiche réponse sont deux objets séparés dès ce contrôle : l'énoncé ne porte jamais de réponse (S-36).
 */

/** Liste fermée des formes de question (D72 S-42), les mêmes que le type `homework_question_form` de la base. */
export const QUESTION_FORMS = ["multiple_choice", "true_false", "true_false_correction", "equations_to_complete", "fill_in_blanks", "matching", "ordering", "problem", "written_answer"] as const;
export type QuestionForm = (typeof QUESTION_FORMS)[number];

export const LEVELS = ["facile", "moyen", "difficile"] as const;
export type ExerciseLevel = (typeof LEVELS)[number];
export const LEVEL_NAME: Record<ExerciseLevel, string> = { facile: "Facile", moyen: "Moyen", difficile: "Difficile" };

/** Un trou à compléter, dans une égalité ou un texte à trous. */
export const BLANK = "___";

export type Question =
  | { form: "multiple_choice"; text: string; options: string[] }
  | { form: "true_false"; text: string }
  | { form: "true_false_correction"; text: string }
  | { form: "equations_to_complete"; text: string }
  | { form: "fill_in_blanks"; text: string }
  | { form: "matching"; left: string[]; right: string[] }
  | { form: "ordering"; text: string; items: string[] }
  | { form: "problem"; text: string }
  | { form: "written_answer"; text: string; lines: number };

export type Answer =
  | { form: "multiple_choice"; correct: number }
  | { form: "true_false"; value: boolean }
  | { form: "true_false_correction"; value: boolean; correction: string | null }
  | { form: "equations_to_complete"; blanks: string[] }
  | { form: "fill_in_blanks"; blanks: string[] }
  | { form: "matching"; pairs: number[] }
  | { form: "ordering"; order: string[] }
  | { form: "problem"; calculation: string; result: string }
  | { form: "written_answer"; model: string };

export interface Exercise {
  title: string;
  level: ExerciseLevel;
  points: number;
  instruction: string;
  /** Court texte commun aux questions (un problème, par exemple). */
  context: string | null;
  questions: Question[];
}

export interface PageContent {
  theme: string;
  /** Mot du thème mis en valeur dans le titre. */
  keyword: string | null;
  subject: string;
  level: string;
  exercises: Exercise[];
}

/** Fiche réponse : pour chaque exercice, la réponse de chaque question, dans le même ordre. */
export type PageAnswers = Answer[][];
export type GradingScale = { level: ExerciseLevel; points: number }[];

export type ModelPage = { status: "unreadable" } | { status: "off_topic" } | { status: "ok"; content: PageContent; answers: PageAnswers; grading: GradingScale; forms: QuestionForm[] };

/** La page ne passe pas le contrôle : elle n'est pas enregistrée (RT1). Le message sert au journal, jamais à l'écran. */
export class InvalidPage extends Error {}

const bad = (why: string): never => {
  throw new InvalidPage(why);
};
const text = (value: unknown, what: string, max = 600): string => {
  if (typeof value !== "string" || !value.trim()) return bad(`${what} manquant`);
  const clean = value.trim().replace(/[\u0000-\u0008\u000b-\u001f]/g, "");
  if (clean.length > max) return bad(`${what} trop long`);
  return clean;
};
const list = (value: unknown, what: string, min: number, max: number): unknown[] => {
  if (!Array.isArray(value) || value.length < min || value.length > max) return bad(`${what} : entre ${min} et ${max} attendus`);
  return value;
};
const blanksIn = (value: string) => value.split(BLANK).length - 1;

function question(raw: unknown, where: string): { question: Question; answer: Answer } {
  const q = (raw ?? {}) as Record<string, unknown>;
  const form = q.forme as QuestionForm;
  if (!QUESTION_FORMS.includes(form)) return bad(`${where} : forme inconnue`);
  switch (form) {
    case "multiple_choice": {
      const options = list(q.choix, `${where} choix`, 2, 4).map((o) => text(o, `${where} choix`, 200));
      if (new Set(options).size !== options.length) bad(`${where} : deux choix identiques`);
      if (!Number.isInteger(q.reponse) || (q.reponse as number) < 0 || (q.reponse as number) >= options.length) bad(`${where} : bonne réponse absente`);
      return { question: { form, text: text(q.texte, where), options }, answer: { form, correct: q.reponse as number } };
    }
    case "true_false": {
      if (typeof q.reponse !== "boolean") bad(`${where} : vrai ou faux attendu`);
      return { question: { form, text: text(q.texte, where) }, answer: { form, value: q.reponse as boolean } };
    }
    case "true_false_correction": {
      if (typeof q.reponse !== "boolean") bad(`${where} : vrai ou faux attendu`);
      const value = q.reponse as boolean;
      // Une phrase fausse a toujours sa correction (RF4).
      const correction = value ? null : text(q.correction, `${where} correction`);
      return { question: { form, text: text(q.texte, where) }, answer: { form, value, correction } };
    }
    case "equations_to_complete":
    case "fill_in_blanks": {
      // Un trou s'écrit « ___ » ; un trait plus long du modèle (« _____ ») est le même trou.
      const statement = text(q.texte, where).replace(/_{3,}/g, BLANK);
      const blanks = list(q.reponse, `${where} réponses`, 1, 8).map((b) => text(typeof b === "number" ? String(b) : b, `${where} réponse`, 120));
      if (blanksIn(statement) !== blanks.length) bad(`${where} : ${blanksIn(statement)} trou(s) pour ${blanks.length} réponse(s)`);
      return { question: { form, text: statement }, answer: { form, blanks } };
    }
    case "matching": {
      const left = list(q.gauche, `${where} gauche`, 2, 6).map((x) => text(x, `${where} gauche`, 120));
      const right = list(q.droite, `${where} droite`, left.length, left.length).map((x) => text(x, `${where} droite`, 120));
      const pairs = list(q.reponse, `${where} réponses`, left.length, left.length);
      if (!pairs.every((p) => Number.isInteger(p)) || [...(pairs as number[])].sort((a, b) => a - b).some((p, i) => p !== i)) bad(`${where} : chaque élément de droite est relié une fois`);
      return { question: { form, left, right }, answer: { form, pairs: pairs as number[] } };
    }
    case "ordering": {
      const items = list(q.elements, `${where} éléments`, 2, 8).map((x) => text(typeof x === "number" ? String(x) : x, `${where} élément`, 120));
      const order = list(q.reponse, `${where} réponse`, items.length, items.length).map((x) => text(typeof x === "number" ? String(x) : x, `${where} réponse`, 120));
      if ([...items].sort().join("\u0001") !== [...order].sort().join("\u0001")) bad(`${where} : la réponse ne reprend pas les éléments`);
      return { question: { form, text: text(q.texte, where), items }, answer: { form, order } };
    }
    case "problem": {
      const r = (q.reponse ?? {}) as Record<string, unknown>;
      return { question: { form, text: text(q.texte, where) }, answer: { form, calculation: typeof r.calcul === "string" ? r.calcul.trim().slice(0, 300) : "", result: text(typeof r.resultat === "number" ? String(r.resultat) : r.resultat, `${where} résultat`, 300) } };
    }
    case "written_answer": {
      const lines = Number.isInteger(q.lignes) ? Math.min(4, Math.max(1, q.lignes as number)) : 2;
      return { question: { form, text: text(q.texte, where), lines }, answer: { form, model: text(q.reponse, `${where} réponse type`) } };
    }
  }
}

/**
 * Lit la réponse du modèle et contrôle la page (US-180 RT1) : 3 exercices dans l'ordre facile, moyen, difficile ; un barème de nombres entiers, croissant, dont le total vaut
 * exactement 20 ; des formes de la liste fermée ; une réponse pour chaque question. Tout écart lève `InvalidPage` : la page n'est pas enregistrée.
 */
export function readModelPage(raw: string): ModelPage {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return bad("réponse sans objet JSON");
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return bad("JSON illisible");
  }
  if (data.statut === "illisible") return { status: "unreadable" };
  if (data.statut === "hors_sujet") return { status: "off_topic" };
  if (data.statut !== "ok") return bad("statut inconnu");
  const exercises = list(data.exercices, "exercices", 3, 3).map((e, i): { exercise: Exercise; answers: Answer[] } => {
    const x = (e ?? {}) as Record<string, unknown>;
    if (x.niveau !== LEVELS[i]) bad(`exercice ${i + 1} : niveau « ${LEVELS[i]} » attendu`);
    // « 5 » écrit entre guillemets reste 5 points ; tout autre écart est refusé.
    if (typeof x.points === "string" && /^\d{1,2}$/.test(x.points)) x.points = Number(x.points);
    if (!Number.isInteger(x.points) || (x.points as number) < 1) bad(`exercice ${i + 1} : points entiers attendus`);
    const questions = list(x.questions, `exercice ${i + 1} questions`, 1, 6).map((q, j) => question(q, `exercice ${i + 1}, question ${j + 1}`));
    return {
      exercise: {
        title: text(x.titre, `exercice ${i + 1} titre`, 60), level: LEVELS[i], points: x.points as number, instruction: text(x.consigne, `exercice ${i + 1} consigne`, 300),
        context: typeof x.enonce === "string" && x.enonce.trim() ? text(x.enonce, `exercice ${i + 1} énoncé`, 800) : null, questions: questions.map((q) => q.question),
      },
      answers: questions.map((q) => q.answer),
    };
  });
  const points = exercises.map((e) => e.exercise.points);
  if (!(points[0] < points[1] && points[1] < points[2])) bad("barème non croissant");
  if (points[0] + points[1] + points[2] !== 20) bad(`barème de ${points[0] + points[1] + points[2]} points au lieu de 20`);
  const theme = text(data.theme, "thème", 80);
  const keyword = typeof data.mot_cle === "string" && data.mot_cle.trim() && theme.includes(data.mot_cle.trim()) ? data.mot_cle.trim() : null;
  const content: PageContent = { theme, keyword, subject: text(data.matiere, "matière", 40), level: text(data.niveau, "niveau", 20), exercises: exercises.map((e) => e.exercise) };
  const forms = QUESTION_FORMS.filter((f) => content.exercises.some((e) => e.questions.some((q) => q.form === f)));
  return { status: "ok", content, answers: exercises.map((e) => e.answers), grading: content.exercises.map((e) => ({ level: e.level, points: e.points })), forms };
}
