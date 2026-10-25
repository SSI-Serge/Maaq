"use client";

import { useParams } from "next/navigation";
import { DayScreen } from "@/components/family/DayScreen";

/** Vue Jour du calendrier familial (US-78 RF9). */
export default function DayPage() {
  const { date } = useParams<{ date: string }>();
  return <DayScreen day={date} />;
}
