import { z } from "zod";
import { Rejection } from "@/server/http";

/** Identifiant d'un membre dans l'adresse : tout ce qui n'est pas un identifiant valide est un membre introuvable. */
export async function memberIdOf(context: { params: Promise<{ id: string }> }): Promise<string> {
  const { id } = await context.params;
  if (!z.uuid().safeParse(id).success) throw new Rejection("not_found", "Ce membre n'existe pas ou a été retiré.", 404);
  return id;
}
