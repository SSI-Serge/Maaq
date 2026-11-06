import { sql } from "kysely";
import type { Ctx, SessionContext } from "@/server/auth/service";
import { buildBudget, type Budget } from "./engine";
import { loadSettings, requireAccess } from "./household/settings";

/**
 * Budget par rayon (US-163) : calculé seulement à partir des tickets enregistrés (les achats cochés sans ticket n'y figurent pas). Dépenses du mois passé, moyenne mensuelle
 * de l'année en cours et d'une année précédente (deux au plus). Réservé au couple ; la base ne rend rien à un invité secondaire (CR-10).
 */

export interface BudgetView {
  budget: Budget;
  empty: boolean;
  /** Mois passé, pour l'en-tête (« Oct. 2026 »). */
  monthLabel: string;
  /** Jour du budget choisi dans les réglages (1 à 31). */
  budgetDay: number;
}

const MONTHS = ["Janv.", "Févr.", "Mars", "Avr.", "Mai", "Juin", "Juil.", "Août", "Sept.", "Oct.", "Nov.", "Déc."];

export async function budgetView(ctx: Ctx, session: SessionContext, previousYear?: number | null): Promise<BudgetView> {
  const who = await requireAccess(ctx, session, "couple");
  const [rows, aisles, settings] = await Promise.all([
    sql<{ aisle_id: number; spend_month: Date | string; total: string }>`select aisle_id, spend_month, total from grocery_monthly_spend_for(${who.userId}::uuid)`.execute(ctx.db),
    ctx.db.selectFrom("grocery_aisles").select(["id", "name"]).execute(),
    loadSettings(ctx.db, who.accountId),
  ]);
  const name = new Map(aisles.map((a) => [a.id, a.name]));
  const day = (value: Date | string) => (typeof value === "string" ? value.slice(0, 10) : `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`);
  const lines = rows.rows.map((r) => ({ date: day(r.spend_month), rayon: name.get(r.aisle_id) ?? "Autres", total: Number(r.total) }));
  const budget = buildBudget(lines, ctx.now, previousYear);
  const [year, month] = budget.lastMonth.split("-").map(Number);
  return { budget, empty: lines.length === 0, monthLabel: `${MONTHS[month - 1]} ${year}`, budgetDay: settings.budgetDay };
}
