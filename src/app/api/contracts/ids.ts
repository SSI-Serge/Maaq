import { Rejection } from "@/server/http";

/** Identifiant numérique d'une adresse ; un identifiant mal formé n'existe pas. */
export async function numericParam(params: Promise<Record<string, string>>, name: string): Promise<string> {
  const value = (await params)[name];
  if (!/^\d{1,18}$/.test(value ?? "")) throw new Rejection("not_found", "Ce contrat ou ce document n'existe pas.", 404);
  return value;
}
