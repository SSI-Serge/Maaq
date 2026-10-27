"use client";

import { useParams } from "next/navigation";
import { TravelScreen } from "@/components/family/TravelScreen";

/** Suivi du trajet vers un rendez-vous (US-107 RF6) : adresse ouverte par la notification « Ouvrez MAAQ pour suivre votre trajet ». */
export default function TravelPage() {
  const { id } = useParams<{ id: string }>();
  return <TravelScreen key={id} id={id} />;
}
