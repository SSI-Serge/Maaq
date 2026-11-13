"use client";

import { useParams, useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { ChoreScreen } from "@/components/family/ChoreScreen";

function Screen() {
  const { id } = useParams<{ id: string }>();
  const bin = useSearchParams().get("bac");
  return <ChoreScreen taskId={id} binId={bin && /^\d{1,9}$/.test(bin) ? Number(bin) : null} />;
}

/** Pas à pas d'une tâche ménagère guidée (US-182). */
export default function ChorePage() {
  return (
    <Suspense>
      <Screen />
    </Suspense>
  );
}
