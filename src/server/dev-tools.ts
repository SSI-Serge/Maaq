import { NextResponse } from "next/server";

/** Outils réservés au développement local : boîte de test, Digitorn simulé, charte. */
export function isDevToolsEnabled(): boolean {
  return process.env.NODE_ENV !== "production";
}

/** Réponse 404 si une route de développement est appelée en production. */
export function devOnlyGuard(): NextResponse | null {
  return isDevToolsEnabled() ? null : new NextResponse(null, { status: 404 });
}

// Profil et agent fictifs de la page de démonstration du simulateur Digitorn.
export const DEMO_USER = "demo-camille";
export const DEMO_AGENT = "demo-agent-administratif";
