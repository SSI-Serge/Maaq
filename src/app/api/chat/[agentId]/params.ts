import { Rejection } from "@/server/http";

/** Identifiant d'agent de l'adresse ; un identifiant mal formé n'existe pas. */
export async function agentIdOf(context: { params: Promise<{ agentId: string }> }): Promise<string> {
  const { agentId } = await context.params;
  if (!/^\d{1,18}$/.test(agentId)) throw new Rejection("not_found", "Cet agent n'est pas sur votre dashboard.", 404);
  return agentId;
}
