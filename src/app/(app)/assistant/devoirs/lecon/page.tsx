"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { HomeworkLessonScreen } from "@/components/family/HomeworkLessonScreen";

function Screen() {
  const id = useSearchParams().get("enfant");
  return <HomeworkLessonScreen memberId={id && /^[0-9a-f-]{36}$/.test(id) ? id : null} />;
}

/** Créer des exercices à partir d'une leçon (US-180) : l'enfant pour lui-même, ou un parent pour l'enfant choisi (`?enfant=`). */
export default function HomeworkLessonPage() {
  return (
    <Suspense>
      <Screen />
    </Suspense>
  );
}
