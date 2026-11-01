"use client";

import { useParams } from "next/navigation";
import { ContractDetail } from "@/components/contracts/ContractDetail";

/** Détail d'un contrat de la famille (maquette CT-Contrat-Detail). */
export default function ContractPage() {
  const { id } = useParams<{ id: string }>();
  return <ContractDetail id={id} />;
}
