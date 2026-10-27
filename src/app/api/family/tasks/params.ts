import { z } from "zod";
import { Rejection } from "@/server/http";

/** Identifiant d'une tâche dans l'adresse : tout ce qui n'est pas un identifiant valide est une tâche introuvable. */
export async function taskIdOf(context: { params: Promise<{ id: string }> }): Promise<string> {
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) throw new Rejection("not_found", "Cette tâche n'existe plus ou ne vous est pas accessible.", 404);
  return id;
}
