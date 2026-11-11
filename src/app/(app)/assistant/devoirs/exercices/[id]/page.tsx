"use client";

import { useParams } from "next/navigation";
import { HomeworkPageScreen } from "@/components/family/HomeworkPageScreen";

/** Une page d'exercices (US-180 RF5, RF7) : l'énoncé, et la fiche réponse pour un parent. */
export default function HomeworkExercisePage() {
  const { id } = useParams<{ id: string }>();
  return <HomeworkPageScreen id={id} />;
}
