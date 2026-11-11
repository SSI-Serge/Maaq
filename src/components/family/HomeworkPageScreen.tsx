"use client";

import Link from "next/link";
import { Fragment, type ReactNode } from "react";
import { useApiQuery } from "@/client/hooks";
import { Loading, Notice, RetryNotice } from "@/components/ui";
import { BLANK, LEVEL_NAME, type Answer, type Exercise, type Question } from "@/server/assistant/homework/page-format";
import type { PageView } from "@/server/assistant/homework/pages";
import { plainDate } from "./format";
import s from "./homework-page.module.css";

const LETTERS = "abcdefgh";
const points = (n: number) => `${n} point${n > 1 ? "s" : ""}`;

/** « 3/4 » s'affiche comme une fraction, le numérateur au-dessus du dénominateur. */
function rich(text: string): ReactNode {
  const parts = text.split(/(\b\d{1,4}\/\d{1,4}\b)/);
  return parts.map((part, i) => {
    const m = /^(\d{1,4})\/(\d{1,4})$/.exec(part);
    return m ? (
      <span key={i} className={s.frac} aria-label={`${m[1]} sur ${m[2]}`}>
        <span>{m[1]}</span>
        <span>{m[2]}</span>
      </span>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    );
  });
}

/** Un texte à trous : chaque « ___ » est un trait à compléter, ou la réponse en vert sur la fiche réponse. */
function withBlanks(text: string, answers?: string[]): ReactNode {
  const parts = text.split(BLANK);
  return parts.map((part, i) => (
    <Fragment key={i}>
      {rich(part)}
      {i < parts.length - 1 && (answers ? <span className={s.ans}>{rich(answers[i] ?? "")}</span> : <span className={s.blank} />)}
    </Fragment>
  ));
}

const Box = () => <span className={s.box} />;

/** Une question de l'énoncé, ou la même avec sa réponse quand `answer` est donné (fiche réponse, parents seulement). */
function QuestionView({ q, letter, answer }: { q: Question; letter: string; answer?: Answer }) {
  const label = <>{letter}. </>;
  switch (q.form) {
    case "multiple_choice": {
      const correct = answer?.form === "multiple_choice" ? answer.correct : -1;
      return (
        <div className={s.q}>
          <div className={s.t}>
            {label}
            {rich(q.text)}
          </div>
          <div className={s.opts}>
            {q.options.map((o, i) => (
              <span key={i} className={`${s.opt} ${i === correct ? s.ok : ""}`}>
                <Box />
                {rich(o)}
              </span>
            ))}
          </div>
        </div>
      );
    }
    case "true_false":
    case "true_false_correction": {
      const known = answer && (answer.form === "true_false" || answer.form === "true_false_correction") ? answer : null;
      return (
        <div className={s.q}>
          <table className={s.vf}>
            <thead>
              <tr>
                <th>Phrase</th>
                <th>Vrai</th>
                <th>Faux</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>
                  {label}
                  {rich(q.text)}
                </td>
                <td className={s.c}>{known ? known.value ? <span className={s.ans}>✓</span> : null : <Box />}</td>
                <td className={s.c}>{known ? !known.value ? <span className={s.ans}>✓</span> : null : <Box />}</td>
              </tr>
            </tbody>
          </table>
          {q.form === "true_false_correction" && !known && (
            <>
              <div className={s.fix}>Si c&apos;est faux, corrige la phrase :</div>
              <div className={s.line} />
            </>
          )}
          {known && known.form === "true_false_correction" && known.correction && (
            <div className={s.fix}>
              Correction : <span className={s.ans}>{rich(known.correction)}</span>
            </div>
          )}
        </div>
      );
    }
    case "equations_to_complete":
    case "fill_in_blanks": {
      const blanks = answer && (answer.form === "equations_to_complete" || answer.form === "fill_in_blanks") ? answer.blanks : undefined;
      return (
        <div className={`${s.q} ${s.eq}`} style={q.form === "fill_in_blanks" ? { fontSize: 15 } : undefined}>
          {label}
          {withBlanks(q.text, blanks)}
        </div>
      );
    }
    case "matching": {
      const pairs = answer?.form === "matching" ? answer.pairs : null;
      if (pairs)
        return (
          <div className={s.q}>
            {q.left.map((l, i) => (
              <div key={i} style={{ fontSize: 14, marginBottom: 4 }}>
                {i === 0 ? label : ""}
                {rich(l)} → <span className={s.ans}>{rich(q.right[pairs[i]] ?? "")}</span>
              </div>
            ))}
          </div>
        );
      return (
        <div className={s.q}>
          <div className={s.relier}>
            {q.left.map((l, i) => (
              <Fragment key={i}>
                <div className={s.l}>
                  <span>{rich(l)}</span>
                  <span className={s.dot} />
                </div>
                <span />
                <div className={s.l}>
                  <span className={s.dot} />
                  <span>{rich(q.right[i] ?? "")}</span>
                </div>
              </Fragment>
            ))}
          </div>
        </div>
      );
    }
    case "ordering": {
      const order = answer?.form === "ordering" ? answer.order : null;
      return (
        <div className={s.q}>
          <div className={s.t}>
            {label}
            {rich(q.text)}
          </div>
          {order ? (
            <span className={s.ans}>{order.map((o, i) => <Fragment key={i}>{i > 0 ? " · " : ""}{rich(o)}</Fragment>)}</span>
          ) : (
            <>
              <p style={{ margin: "0 0 6px", fontSize: 15 }}>{q.items.map((o, i) => <Fragment key={i}>{i > 0 ? " · " : ""}{rich(o)}</Fragment>)}</p>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
                {q.items.map((_, i) => (
                  <span key={i} className={s.blank} />
                ))}
              </div>
            </>
          )}
        </div>
      );
    }
    case "problem": {
      const known = answer?.form === "problem" ? answer : null;
      return (
        <div className={s.q}>
          <div className={s.t} style={{ fontWeight: 600 }}>
            {label}
            {rich(q.text)}
          </div>
          {known ? (
            <div className={s.calc}>
              {known.calculation && (
                <span>
                  Calcul : <span className={s.ans}>{rich(known.calculation)}</span>
                </span>
              )}
              <span>
                Réponse : <span className={s.ans}>{rich(known.result)}</span>
              </span>
            </div>
          ) : (
            <div className={s.calc}>
              <span>Calcul : ____________</span>
              <span>Réponse : ____________</span>
            </div>
          )}
        </div>
      );
    }
    case "written_answer": {
      const known = answer?.form === "written_answer" ? answer : null;
      return (
        <div className={s.q}>
          <div className={s.t} style={{ fontWeight: 600 }}>
            {label}
            {rich(q.text)}
          </div>
          {known ? (
            <>
              <div className={s.fix}>Réponse type :</div>
              <span className={s.ans} style={{ display: "inline-block" }}>
                {rich(known.model)}
              </span>
              <div className={s.fix}>Toute réponse proche est acceptée.</div>
            </>
          ) : (
            Array.from({ length: q.lines }, (_, i) => <div key={i} className={s.line} />)
          )}
        </div>
      );
    }
  }
}

function ExerciseCard({ exercise, index, answers }: { exercise: Exercise; index: number; answers?: Answer[] }) {
  return (
    <div className={s.ex}>
      <div className={s.exHead}>
        <span className={s.num}>{index + 1}</span>
        <h2>{exercise.title}</h2>
        <span className={`${s.badge} ${s[exercise.level]}`}>{LEVEL_NAME[exercise.level]}</span>
        {!answers && <span className={s.pts}>{points(exercise.points)}</span>}
      </div>
      <div className={s.exBody}>
        {!answers && <p className={s.consigne}>{exercise.instruction}</p>}
        {!answers && exercise.context && <p className={s.context}>{rich(exercise.context)}</p>}
        {exercise.questions.map((q, i) => (
          <QuestionView key={i} q={q} letter={LETTERS[i] ?? String(i + 1)} answer={answers?.[i]} />
        ))}
      </div>
    </div>
  );
}

/** Le thème, avec son mot clé en valeur : « Les fractions ». */
function Theme({ theme, keyword }: { theme: string; keyword: string | null }) {
  if (!keyword || !theme.includes(keyword)) return <>{theme}</>;
  const at = theme.indexOf(keyword);
  return (
    <>
      {theme.slice(0, at)}
      <em>{keyword}</em>
      {theme.slice(at + keyword.length)}
    </>
  );
}

/**
 * La page d'exercices (US-180 RF3 à RF5, S-37) : l'énoncé, à imprimer pour l'enfant ; puis, pour un parent seulement, la fiche réponse « pour l'adulte qui corrige » et le
 * barème sur 20. La fiche réponse n'existe dans la page que si le serveur l'a envoyée, donc jamais pour le profil d'un enfant ; elle ne s'imprime jamais.
 */
export function ExerciseSheet({ page }: { page: PageView }) {
  const { content } = page;
  return (
    <>
      <div className={s.sheet}>
        <div className={s.top}>
          <div>
            <span className={s.eyebrow}>{content.subject} · Je retiens</span>
            <h1>
              <Theme theme={content.theme} keyword={content.keyword} />
            </h1>
          </div>
          <div className={s.fields}>
            <div className={s.field}>
              Prénom <i />
            </div>
            <div className={s.field}>
              Date <i />
            </div>
          </div>
        </div>
        <p className={s.consigne}>Relis la leçon « Je retiens » puis fais les exercices.</p>
        {content.exercises.map((e, i) => (
          <ExerciseCard key={i} exercise={e} index={i} />
        ))}
      </div>
      {page.answers && page.grading && (
        <div className={`${s.sheet} ${s.corr}`}>
          <span className={s.eyebrow}>Fiche réponse · pour l&apos;adulte qui corrige</span>
          {content.exercises.map((e, i) => (
            <ExerciseCard key={i} exercise={e} index={i} answers={page.answers![i] ?? []} />
          ))}
          <div className={s.kickSoft}>Barème conseillé</div>
          <table className={s.bareme}>
            <tbody>
              {page.grading.map((g, i) => (
                <tr key={i}>
                  <td>
                    Exercice {i + 1} · {LEVEL_NAME[g.level]}
                  </td>
                  <td>{g.points} pts</td>
                </tr>
              ))}
              <tr className={s.tot}>
                <td>Total</td>
                <td>{page.grading.reduce((sum, g) => sum + g.points, 0)} pts</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** Écran d'une page d'exercices : « Mes exercices » pour l'enfant, dossier « Exercices » pour un parent. « Imprimer » ne sort que l'énoncé. */
export function HomeworkPageScreen({ id }: { id: string }) {
  const query = useApiQuery<{ page: PageView }>(`/api/family/homework/pages/${id}`);
  const page = query.data?.page;
  const gone = query.error?.body?.code === "not_found";
  const parent = page?.role === "parent";
  return (
    <div className={s.root}>
      <div className={s.bar}>
        <Link href={parent ? "/assistant/devoirs/exercices" : "/assistant/devoirs/tache"} aria-label="Retour" className={s.back}>
          ‹
        </Link>
        <div style={{ flex: 1 }}>
          <div className={s.kick}>{page ? (parent ? `Dossier « Exercices » · ${page.firstName}` : "Mes exercices") : "Exercices"}</div>
          <h1 className={s.barTitle}>{page ? `Exercices — ${page.content.theme}` : "Exercices"}</h1>
        </div>
        {page && (
          <button type="button" className={s.print} onClick={() => window.print()}>
            Imprimer
          </button>
        )}
      </div>
      <div className={s.body}>
        {query.loading && !page && <Loading slow={query.slow} />}
        {gone && <Notice tone="info">Cette page n&apos;existe plus.</Notice>}
        {query.error && !gone && <RetryNotice message={query.error.kind === "server" ? "La page n'a pas pu être chargée." : query.error.message} onRetry={query.reload} />}
        {page && parent && (
          <p className={s.note}>
            Page de {page.firstName}, créée le {plainDate(page.created)}. L&apos;énoncé, puis la fiche réponse et le barème.
          </p>
        )}
        {page && <ExerciseSheet page={page} />}
        {page && parent && <p className={s.note}>À l&apos;impression, seul l&apos;énoncé sort, sans la fiche réponse ni page blanche.</p>}
      </div>
    </div>
  );
}
