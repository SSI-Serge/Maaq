"use client";

import { useParams, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { HomeworkWeekScreen } from "@/components/family/HomeworkScreens";

function Screen() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const child = params.get("enfant");
  return <HomeworkWeekScreen id={id} childId={child && /^[0-9a-f-]{36}$/.test(child) ? child : null} fromHistory={params.get("retour") === "historique"} />;
}

/** Écran « Semaine de devoirs » (US-119 RF4) ; `?enfant=` ouvre la page de cet enfant. */
export default function HomeworkWeekPage() {
  return (
    <Suspense>
      <Screen />
    </Suspense>
  );
}
