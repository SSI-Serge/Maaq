"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { HomeworkListScreen } from "@/components/family/HomeworkScreens";

function Screen() {
  return <HomeworkListScreen from={useSearchParams().get("retour") === "tache" ? "tache" : "reglages"} />;
}

/** Écran « Devoirs » (S-52) : l'historique des semaines préparées ; `?retour=tache` quand on vient de la tâche « Préparer les devoirs ». */
export default function HomeworkPage() {
  return (
    <Suspense>
      <Screen />
    </Suspense>
  );
}
