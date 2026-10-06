import { NextResponse } from "next/server";
import type { z } from "zod";

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

/** Lit et valide le corps JSON d'une requête ; un corps invalide devient un refus 400. */
export async function parseBody<S extends z.ZodType>(request: Request, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    throw new Rejection("invalid_body", "Requête invalide.", 400);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new Rejection("invalid_body", "Requête invalide.", 400, parsed.error.issues);
  return parsed.data;
}
