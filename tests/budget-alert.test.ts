import { summarize } from "../scripts/cost-report";
import { describe, expect, it } from "vitest";
import { resetBudgetAlert, runBudgetAlert, type LogReader } from "@/server/budget-alert";
import type { Ctx } from "@/server/auth/service";

const ctx = (iso: string) => ({ db: null as never, now: new Date(iso) }) as Ctx;

/** Journaux simulés : les coûts du mois, et les alertes déjà notées. */
function logs(costs: number[], alerts: { month: string; threshold: number }[] = []) {
  const asked: Date[] = [];
  const reader: LogReader = {
    async entries(since, field) {
      asked.push(since);
      return field === "apiCostUsd" ? costs.map((apiCostUsd) => ({ event: "model_call", apiCostUsd })) : alerts.map((a) => ({ event: "budget_alert", ...a }));
    },
  };
  return { reader, asked };
}
function mailbox() {
  const mails: { subject: string; text: string }[] = [];
  return { mails, alert: async (subject: string, text: string) => void mails.push({ subject, text }) };
}

describe("alerte avant la limite de dépense de la clé Anthropic", () => {
  it("sans budget réglé : rien", async () => {
    resetBudgetAlert();
    expect(await runBudgetAlert(ctx("2026-11-20T10:02:00Z"), { budgetUsd: 0, reader: logs([400]).reader })).toEqual({ status: "off" });
  });

  it("sous 50 % : la dépense est additionnée depuis le 1er du mois, aucun email", async () => {
    resetBudgetAlert();
    const l = logs([100, 49.5, 0.037]);
    const box = mailbox();
    const result = await runBudgetAlert(ctx("2026-11-20T10:02:00Z"), { budgetUsd: 500, reader: l.reader, alert: box.alert });
    expect(result).toMatchObject({ status: "checked", month: "2026-11", sent: [] });
    expect(result.status === "checked" && result.spentUsd).toBeCloseTo(149.537, 3);
    expect(l.asked[0].toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(box.mails).toEqual([]);
  });

  it("50 % atteints : un email, avec le montant, le pourcentage et la mention d'estimation ; une seule vérification par heure", async () => {
    resetBudgetAlert();
    const box = mailbox();
    const result = await runBudgetAlert(ctx("2026-11-20T10:02:00Z"), { budgetUsd: 500, reader: logs([200, 60]).reader, alert: box.alert });
    expect(result).toMatchObject({ status: "checked", sent: [50] });
    expect(box.mails).toHaveLength(1);
    expect(box.mails[0].subject).toBe("Dépense IA du mois : 50 % du budget atteints");
    expect(box.mails[0].text).toContain("260,00 $ sur 500 $ pour 2026-11, soit 52 % du budget");
    expect(box.mails[0].text).toContain("la facture d'Anthropic fait foi");
    expect(await runBudgetAlert(ctx("2026-11-20T10:07:00Z"), { budgetUsd: 500, reader: logs([200, 60]).reader, alert: box.alert })).toEqual({ status: "not_due" });
    expect(box.mails).toHaveLength(1);
  });

  it("un palier déjà annoncé ce mois-ci n'est pas renvoyé ; un saut de palier ne donne qu'un email, pour le plus haut", async () => {
    resetBudgetAlert();
    const box = mailbox();
    const again = await runBudgetAlert(ctx("2026-11-20T11:00:00Z"), { budgetUsd: 500, reader: logs([260], [{ month: "2026-11", threshold: 50 }]).reader, alert: box.alert });
    expect(again).toMatchObject({ sent: [] });
    expect(box.mails).toEqual([]);
    const jump = await runBudgetAlert(ctx("2026-11-20T12:00:00Z"), { budgetUsd: 500, reader: logs([480], [{ month: "2026-11", threshold: 50 }]).reader, alert: box.alert });
    expect(jump).toMatchObject({ sent: [80, 95] });
    expect(box.mails).toHaveLength(1);
    expect(box.mails[0].subject).toContain("95 %");
    // Une alerte du mois précédent ne compte pas pour ce mois-ci.
    const next = await runBudgetAlert(ctx("2026-12-10T12:00:00Z"), { budgetUsd: 500, reader: logs([260], [{ month: "2026-11", threshold: 50 }]).reader, alert: box.alert });
    expect(next).toMatchObject({ month: "2026-12", sent: [50] });
  });
});

describe("relevé des coûts par type d'appel", () => {
  it("additionne par type, du plus coûteux au moins coûteux, avec le coût moyen et les recherches web", () => {
    expect(
      summarize([
        { kind: "assistant", apiCostUsd: 0.03, webSearches: 0 },
        { kind: "sortie", apiCostUsd: 0.12, webSearches: 4 },
        { kind: "assistant", apiCostUsd: 0.05, webSearches: 0 },
      ]).map((r) => [r.kind, r.calls, Number(r.costUsd.toFixed(2)), Number(r.averageUsd.toFixed(2)), r.webSearches]),
    ).toEqual([["sortie", 1, 0.12, 0.12, 4], ["assistant", 2, 0.08, 0.04, 0]]);
    expect(summarize([])).toEqual([]);
  });
});
