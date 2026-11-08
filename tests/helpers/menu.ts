import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import type { Ctx } from "@/server/auth/service";
import type { DB } from "@/server/db/schema.generated";
import { loadSettings } from "@/server/courses/household/settings";
import { loadEngineData } from "@/server/courses/menu/data";
import { menuInput } from "@/server/courses/menu-ia/contract";
import { buildProposal } from "@/server/courses/menu-ia/proposal";
import { saveValidatedMenu } from "@/server/courses/menu-ia/validate";
import type { CoupleFamily } from "./couple";

/**
 * Menu validé pour un essai, sans passer par le tchat : sept dîners (les plats demandés d'abord, puis les premiers plats du catalogue), quatre plats express si demandés. C'est
 * l'équivalent de l'ancien « proposer puis valider » des essais de la liste, des tickets et du budget.
 */
export async function validateTestMenu(
  db: Kysely<DB>,
  f: CoupleFamily,
  options: { picks?: string[]; week?: string; express?: boolean; now?: Date } = {},
): Promise<{ dinners: string[]; express: string[] }> {
  const now = options.now ?? new Date(2026, 10, 6, 10, 0, 0);
  const ctx: Ctx = { db, now };
  const settings = await loadSettings(db, f.accountId);
  const data = await loadEngineData(db, f.accountId, settings);
  const cuisines = await db.selectFrom("meal_cuisines").select(["id", "name"]).execute();
  const picks = options.picks ?? [];
  const ids = [...picks, ...data.dishes.filter((d) => !d.mine && !picks.includes(d.id)).map((d) => d.id)];
  const dinners = ids.slice(0, 7);
  const express = options.express ? ids.slice(7, 11) : [];
  const nameOf = (id: string) => data.dishes.find((d) => d.id === id)!.name;
  const input = menuInput.parse({ semaine: options.week, diners: dinners.map((id) => ({ plat_id: id, nom: nameOf(id) })), express: express.map((id) => ({ plat_id: id, nom: nameOf(id) })) });
  const built = buildProposal(input, { data, cuisines, householdSize: settings.householdSize, now, newId: randomUUID });
  if (!built.ok) throw new Error(built.errors.join(" | "));
  await saveValidatedMenu(ctx, f.accountId, f.userIds.sophie, built.proposal, data);
  return { dinners, express };
}
