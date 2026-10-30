"use client";

import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { HomeworkPlanner } from "@/components/family/HomeworkPlanner";
import { todayLocal, weekStart } from "@/components/family/format";

function Planner() {
  const asked = useSearchParams().get("semaine");
  const week = asked && /^\d{4}-\d{2}-\d{2}$/.test(asked) ? asked : weekStart(todayLocal());
  return <HomeworkPlanner weekStart={week} />;
}

/** Préparer la semaine de devoirs avec l'aide Devoirs (US-119 RF2, RF9). */
export default function PreparePage() {
  return (
    <Suspense>
      <Planner />
    </Suspense>
  );
}
