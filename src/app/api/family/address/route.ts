import { NextResponse } from "next/server";
import { AddressServiceError, suggestAddresses } from "@/server/assistant/address";
import { requireProfile } from "@/server/auth/http";
import { handler, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

/**
 * Suggestions d'adresses pour le champ « Adresse » d'un rendez-vous (US-107 RT2) : jusqu'à 5 propositions pour `?q=`, avec leurs coordonnées. Réservé aux profils connectés ; le texte
 * tapé n'est pas journalisé. Service indisponible : 503, l'écran garde le texte saisi et dit que le suivi du trajet n'est pas possible sans adresse choisie.
 */
export const GET = handler(async (request: Request) => {
  await requireProfile({ passive: true });
  const q = new URL(request.url).searchParams.get("q") ?? "";
  try {
    return NextResponse.json({ suggestions: await suggestAddresses(q) });
  } catch (error) {
    if (error instanceof AddressServiceError) throw new Rejection("address_unavailable", "Les suggestions d'adresses ne sont pas disponibles pour le moment.", 503);
    throw error;
  }
});
