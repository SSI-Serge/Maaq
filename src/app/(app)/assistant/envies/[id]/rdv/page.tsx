"use client";

import { useParams } from "next/navigation";
import { SourceFormScreen } from "@/components/family/OutingsScreens";

/** « En faire un RDV » (US-151) : le formulaire de RDV prérempli avec le titre de l'envie ; l'envie disparaît à l'enregistrement. */
export default function WishToEventPage() {
  const { id } = useParams<{ id: string }>();
  return <SourceFormScreen api={`/api/family/wishes/${id}`} heading="Depuis une envie" title="En faire un RDV" back={{ href: "/assistant/envies", label: "Nos envies" }} />;
}
