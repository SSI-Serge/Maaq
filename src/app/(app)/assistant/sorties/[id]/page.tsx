"use client";

import { useParams } from "next/navigation";
import { OutingScreen } from "@/components/family/OutingsScreens";

/** Écran « Idées de sorties » (US-115 RF5) : privé au parent qui a reçu la proposition. */
export default function OutingPage() {
  const { id } = useParams<{ id: string }>();
  return <OutingScreen id={id} />;
}
