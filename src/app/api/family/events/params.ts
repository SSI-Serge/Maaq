import { z } from "zod";
import { Rejection } from "@/server/http";

/** Identifiant d'un rendez-vous dans l'adresse : tout ce qui n'est pas un identifiant valide est un rendez-vous introuvable. */
export async function eventIdOf(context: { params: Promise<{ id: string }> }): Promise<string> {
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) throw new Rejection("not_found", "Ce rendez-vous n'existe plus ou ne vous est pas accessible.", 404);
  return id;
}
