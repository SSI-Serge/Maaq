import { describe, expect, it } from "vitest";
import { MockDigitorn } from "@/server/adapters/digitorn/mock";
import type { ActionProposal, SubmitRequestInput } from "@/server/adapters/digitorn/types";

function request(overrides: Partial<SubmitRequestInput> = {}): SubmitRequestInput {
  return {
    requestId: "r1",
    userRef: "camille",
    agentRef: "agent-admin",
    text: "Prends rendez-vous chez le notaire",
    context: { rank: "primary_user", autoParticipants: ["dominique@maaq.test"], ccAddresses: [], info: {} },
    ...overrides,
  };
}

async function firstProposal(mock: MockDigitorn): Promise<ActionProposal> {
  const events = await mock.getConversation("camille", "agent-admin");
  const card = events.find((e) => e.type === "action_proposal");
  if (!card || card.type !== "action_proposal") throw new Error("pas de proposition");
  return card.proposal;
}

describe("Digitorn simulé", () => {
  it("propose une action à valider pour un rendez-vous, avec les participants automatiques (D2)", async () => {
    const mock = new MockDigitorn({ replyDelayMs: 0, executionDelayMs: 0 });
    await mock.submitRequest(request());
    const proposal = await firstProposal(mock);
    expect(proposal).toMatchObject({ kind: "appointment", status: "pending", participants: ["dominique@maaq.test"] });
  });

  it("répond simplement à une demande sans action sensible", async () => {
    const mock = new MockDigitorn({ replyDelayMs: 0 });
    await mock.submitRequest(request({ text: "Classe ma facture d'électricité" }));
    const events = await mock.getConversation("camille", "agent-admin");
    expect(events.map((e) => e.type)).toEqual(["user_message", "agent_message"]);
  });

  it("US-38 RT2 : une demande renvoyée n'est exécutée qu'une fois", async () => {
    const mock = new MockDigitorn({ replyDelayMs: 0 });
    await mock.submitRequest(request());
    await mock.submitRequest(request());
    const events = await mock.getConversation("camille", "agent-admin");
    expect(events.filter((e) => e.type === "user_message")).toHaveLength(1);
  });

  it("US-39 RT1 : une action validée deux fois n'est exécutée qu'une fois", async () => {
    const mock = new MockDigitorn({ replyDelayMs: 0, executionDelayMs: 0 });
    await mock.submitRequest(request());
    const { proposalId } = await firstProposal(mock);
    const first = await mock.decideAction({ proposalId, userRef: "camille", decision: "validate" });
    const second = await mock.decideAction({ proposalId, userRef: "camille", decision: "validate" });
    expect(first.status).toBe("succeeded");
    expect(second.status).toBe("succeeded");
    const done = (await mock.fetchLogbook(new Date(0))).filter((i) => i.type === "action_done");
    expect(done).toHaveLength(1);
  });

  it("US-39 RF3 : refuser annule l'action et l'agent propose de modifier la demande", async () => {
    const mock = new MockDigitorn({ replyDelayMs: 0 });
    await mock.submitRequest(request());
    const { proposalId } = await firstProposal(mock);
    const result = await mock.decideAction({ proposalId, userRef: "camille", decision: "refuse" });
    expect(result.status).toBe("refused");
    const events = await mock.getConversation("camille", "agent-admin");
    expect(events.at(-1)).toMatchObject({ type: "agent_message" });
  });

  it("US-39 RF5 : seul l'auteur de la demande peut décider", async () => {
    const mock = new MockDigitorn({ replyDelayMs: 0 });
    await mock.submitRequest(request());
    const { proposalId } = await firstProposal(mock);
    await expect(mock.decideAction({ proposalId, userRef: "dominique", decision: "validate" })).rejects.toThrow();
  });

  it("US-39 RF8 : effacer le tchat abandonne les cartes sans décision", async () => {
    const mock = new MockDigitorn({ replyDelayMs: 0 });
    await mock.submitRequest(request());
    const { proposalId } = await firstProposal(mock);
    await mock.eraseConversation("camille", "agent-admin");
    expect(await mock.getConversation("camille", "agent-admin")).toEqual([]);
    await expect(mock.decideAction({ proposalId, userRef: "camille", decision: "validate" })).rejects.toThrow();
  });

  it("alimente le carnet de bord, filtré par date", async () => {
    let now = new Date("2026-10-01T08:00:00Z");
    const mock = new MockDigitorn({ replyDelayMs: 0, now: () => now });
    await mock.submitRequest(request({ requestId: "a", text: "Classe ce document" }));
    now = new Date("2026-10-01T12:00:00Z");
    await mock.submitRequest(request({ requestId: "b", text: "Range mes factures" }));
    const items = await mock.fetchLogbook(new Date("2026-10-01T10:00:00Z"));
    expect(items.map((i) => i.text)).toEqual(["Range mes factures"]);
  });
});
