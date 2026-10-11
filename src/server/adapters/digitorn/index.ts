import { localBrains } from "@/server/agents";
import { env } from "@/server/env";
import { LiveDigitorn } from "./live";
import { MockDigitorn } from "./mock";
import { projectsFromDatabase } from "./projects";
import type { DigitornClient } from "./types";

declare global {
  // Le client garde son état en mémoire (simulateur) : une seule instance malgré le rechargement à chaud.
  var __maaqDigitorn: DigitornClient | undefined;
}

/**
 * Client Digitorn. « mock » : simulateur seul. « live » : appels réels pour ce que la documentation de Digitorn décrit
 * (agents, tchat embarqué, utilisateurs), le simulateur gardant le reste tant que Digitorn ne l'a pas livré.
 */
export function digitorn(): DigitornClient {
  globalThis.__maaqDigitorn ??= create();
  return globalThis.__maaqDigitorn;
}

function create(): DigitornClient {
  // Les agents exécutés par MAAQ (kdo_help…) vivent dans le simulateur, aussi en mode « live » : le client réel lui
  // délègue ce que Digitorn ne couvre pas encore, dont les demandes à ces agents.
  const simulator = new MockDigitorn({ brains: localBrains() });
  if (env().DIGITORN_MODE !== "live") return simulator;
  return new LiveDigitorn({ baseUrl: env().DIGITORN_API_URL, ...projectsFromDatabase, fallback: simulator });
}

export type * from "./types";
export { DigitornError } from "./errors";

/** Simulateur Digitorn, pour les pages et routes de développement (consentement Google simulé). */
export function devDigitorn(): MockDigitorn {
  const client = digitorn();
  const simulator = (client as { simulator?: DigitornClient }).simulator ?? client;
  // Pas de `instanceof` : en développement, routes et pages reçoivent chacune leur copie de la classe.
  if (typeof (simulator as Partial<MockDigitorn>).completeConsent !== "function") throw new Error("Le simulateur Digitorn n'est pas actif.");
  return simulator as MockDigitorn;
}
