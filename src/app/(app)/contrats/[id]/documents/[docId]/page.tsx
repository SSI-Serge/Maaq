"use client";

import { useParams } from "next/navigation";
import { MaskedPreview } from "@/components/contracts/MaskedPreview";

/** Aperçu du texte masqué d'un document de contrat (US-137). */
export default function MaskedPreviewPage() {
  const { id, docId } = useParams<{ id: string; docId: string }>();
  return <MaskedPreview contractId={id} documentId={docId} />;
}
