"use client";

import { useParams } from "next/navigation";
import { HomeworkWeekScreen } from "@/components/family/HomeworkScreens";

/** Écran « Semaine de devoirs » (US-119 RF4). */
export default function HomeworkWeekPage() {
  const { id } = useParams<{ id: string }>();
  return <HomeworkWeekScreen id={id} />;
}
