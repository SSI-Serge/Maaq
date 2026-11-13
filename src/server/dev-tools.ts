import { cookies } from "next/headers";
import { NextResponse } from "next/server";

/**
 * Outils de développement : boîte de test, Digitorn simulé, charte. Ils existent en développement local et dans
 * une zone de test en ligne (MAAQ_ZONE=test), où `src/proxy.ts` les réserve à qui détient la clé
 * MAAQ_DEV_TOOLS_KEY. Jamais en production.
 */
export function isDevToolsEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.MAAQ_ZONE === "test";
}

/**
 * Une action serveur des pages /dev peut être postée sur n'importe quelle adresse, donc hors du contrôle de `src/proxy.ts` : sur la zone de test en ligne, elle revérifie
 * elle-même que l'appelant détient la clé des outils de test (cookie posé par le proxy).
 */
export async function devActionAllowed(): Promise<boolean> {
  if (!isDevToolsEnabled()) return false;
  if (process.env.NODE_ENV !== "production") return true;
  const key = process.env.MAAQ_DEV_TOOLS_KEY;
  if (!key || key.length < 16) return false;
  return (await cookies()).get("maaq_dev")?.value === key;
}

/** Réponse 404 si une route de développement est appelée en production. */
export function devOnlyGuard(): NextResponse | null {
  return isDevToolsEnabled() ? null : new NextResponse(null, { status: 404 });
}

// Profil et agent fictifs de la page de démonstration du simulateur Digitorn.
export const DEMO_USER = "demo-camille";
export const DEMO_AGENT = "demo-agent-administratif";
