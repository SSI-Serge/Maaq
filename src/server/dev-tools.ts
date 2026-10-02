import { NextResponse } from "next/server";

/**
 * Outils de développement : boîte de test, Digitorn simulé, charte. Ils existent en développement local et dans
 * une zone de test en ligne (MAAQ_ZONE=test), où `src/proxy.ts` les réserve à qui détient la clé
 * MAAQ_DEV_TOOLS_KEY. Jamais en production.
 */
export function isDevToolsEnabled(): boolean {
  return process.env.NODE_ENV !== "production" || process.env.MAAQ_ZONE === "test";
}

/** Réponse 404 si une route de développement est appelée en production. */
export function devOnlyGuard(): NextResponse | null {
  return isDevToolsEnabled() ? null : new NextResponse(null, { status: 404 });
}

// Profil et agent fictifs de la page de démonstration du simulateur Digitorn.
export const DEMO_USER = "demo-camille";
export const DEMO_AGENT = "demo-agent-administratif";
