"use client";

import { useParams } from "next/navigation";
import { HomeworkPrintScreen } from "@/components/family/HomeworkScreens";

/** Version imprimable de la semaine de devoirs (US-119 RF4, CA 4.2). */
export default function HomeworkPrintPage() {
  const { id } = useParams<{ id: string }>();
  return <HomeworkPrintScreen id={id} />;
}
