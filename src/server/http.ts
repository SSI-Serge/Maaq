import { NextResponse } from "next/server";

/** Refus métier : le client l'affiche tel quel, sans proposer « Réessayer » automatiquement. */
export class Rejection extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number = 422,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "Rejection";
  }
}

export function rejected(code: string, message: string, status = 422, details?: unknown): NextResponse {
  return NextResponse.json({ error: { code, message, details } }, { status });
}

/**
 * Enveloppe commune des routes d'API : un refus métier devient une réponse 4xx lisible ;
 * toute autre erreur est journalisée et devient un 500 sans détail technique (CC-2).
 */
export function handler<Args extends unknown[]>(
  fn: (...args: Args) => Promise<Response>,
): (...args: Args) => Promise<Response> {
  return async (...args: Args) => {
    try {
      return await fn(...args);
    } catch (error) {
      if (error instanceof Rejection) return rejected(error.code, error.message, error.status, error.details);
      console.error(error);
      return NextResponse.json({ error: { code: "server_error", message: "Erreur interne" } }, { status: 500 });
    }
  };
}
