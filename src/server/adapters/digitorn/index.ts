import { env } from "@/server/env";
import { MockDigitorn } from "./mock";
import type { DigitornClient } from "./types";

declare global {
  // Le simulateur garde son état en mémoire : une seule instance malgré le rechargement à chaud.
  var __maaqDigitorn: DigitornClient | undefined;
}

/** Client Digitorn. Tant que l'API réelle n'est pas publiée, seul le simulateur est disponible. */
export function digitorn(): DigitornClient {
  if (env().DIGITORN_MODE === "live") {
    throw new Error("L'API Digitorn n'est pas encore disponible : utiliser DIGITORN_MODE=mock.");
  }
  globalThis.__maaqDigitorn ??= new MockDigitorn();
  return globalThis.__maaqDigitorn;
}

export type * from "./types";
