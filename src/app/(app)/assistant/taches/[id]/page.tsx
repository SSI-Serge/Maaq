"use client";

import { useParams } from "next/navigation";
import { EditTaskScreen } from "@/components/family/TasksScreen";

/** Détail et modification d'une tâche (US-110 RF5, US-96). */
export default function TaskPage() {
  const { id } = useParams<{ id: string }>();
  return <EditTaskScreen id={id} />;
}
