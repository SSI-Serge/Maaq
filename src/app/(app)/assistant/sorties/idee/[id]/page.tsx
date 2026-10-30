"use client";

import { useParams } from "next/navigation";
import { OutingIdeaFormScreen } from "@/components/family/OutingsScreens";

/** Formulaire « Depuis une idée de sortie » (US-120, US-121). */
export default function OutingIdeaPage() {
  const { id } = useParams<{ id: string }>();
  return <OutingIdeaFormScreen id={id} />;
}
