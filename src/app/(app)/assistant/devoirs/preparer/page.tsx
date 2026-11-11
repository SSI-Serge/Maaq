"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { HomeworkPlanner } from "@/components/family/HomeworkPlanner";
import { todayLocal, weekStart } from "@/components/family/format";

function Planner() {
  const params = useSearchParams();
  const asked = params.get("semaine");
  const week = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : weekStart(todayLocal());
  // « Refaire » une semaine déjà préparée (US-119 RF12) : `?refaire=<semaine>` et, depuis la page d'un enfant, `&enfant=<membre>`.
  const id = /^[0-9a-f-]{36}$/;
  const redoWeek = params.get("refaire");
  const child = params.get("enfant");
  const redo = redoWeek && id.test(redoWeek) ? { weekId: redoWeek, memberId: child && id.test(child) ? child : null } : null;
  return <HomeworkPlanner weekStart={week} asked={Boolean(asked)} redo={redo} />;
}

/** Préparer la semaine de devoirs avec l'aide Devoirs (US-119 RF2, RF9, RF11) : sans semaine demandée, le parent choisit la semaine en cours ou une des 4 suivantes. */
export default function PreparePage() {
  return (
    <Suspense>
      <Planner />
    </Suspense>
  );
}
