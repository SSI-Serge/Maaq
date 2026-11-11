"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { HomeworkTaskScreen } from "@/components/family/HomeworkTaskScreen";

function Screen() {
  const id = useSearchParams().get("tache");
  return <HomeworkTaskScreen taskId={id && /^[0-9a-f-]{36}$/.test(id) ? id : null} />;
}

/** Tâche « Préparer les devoirs » (US-119 RF1) : vue parent ou vue de l'enfant selon le profil. */
export default function HomeworkTaskPage() {
  return (
    <Suspense>
      <Screen />
    </Suspense>
  );
}
