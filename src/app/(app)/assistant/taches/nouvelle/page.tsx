"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { NewTaskScreen } from "@/components/family/TasksScreen";

function Screen() {
  return <NewTaskScreen model={useSearchParams().get("modele")} />;
}

/** Nouvelle tâche (US-110 RF1) ; `?modele=preparation_devoirs` : tâche hebdomadaire de préparation des devoirs, préremplie (D69). */
export default function NewTaskPage() {
  return (
    <Suspense>
      <Screen />
    </Suspense>
  );
}
