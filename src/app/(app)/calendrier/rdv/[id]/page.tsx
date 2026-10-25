"use client";

import { useParams } from "next/navigation";
import { EventScreen } from "@/components/family/EventScreen";

/** Un rendez-vous : confirmation d'un RDV proposé (US-75) ou détail d'un RDV confirmé (US-79). Adresse stable pour les notifications. */
export default function EventPage() {
  const { id } = useParams<{ id: string }>();
  return <EventScreen key={id} id={id} />;
}
