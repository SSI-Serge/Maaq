import { describe, expect, it } from "vitest";
import { estimateCostUsd } from "@/server/assistant/cost";
import { createModel } from "@/server/assistant/model";

const none = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0 };

describe("coût estimé d'un appel au modèle", () => {
  it("applique les tarifs de Sonnet 5.5 : entrée, sortie, lecture et écriture du cache", () => {
    expect(estimateCostUsd("claude-sonnet-5-5", { ...none, inputTokens: 1_000_000 })).toBe(2);
    expect(estimateCostUsd("claude-sonnet-5-5", { ...none, outputTokens: 1_000_000 })).toBe(10);
    expect(estimateCostUsd("claude-sonnet-5-5", { ...none, cacheRead: 1_000_000 })).toBe(0.2);
    expect(estimateCostUsd("claude-sonnet-5-5", { ...none, cacheWrite: 1_000_000 })).toBe(2.5);
  });

  it("additionne les quatre parts et arrondit au millionième de dollar", () => {
    // Une demande type du banc : environ 24 000 jetons lus ou neufs, 500 en sortie.
    const cost = estimateCostUsd("claude-sonnet-5-5", { inputTokens: 1_200, outputTokens: 504, cacheRead: 16_000, cacheWrite: 8_000 });
    expect(cost).toBe(0.0024 + 0.00504 + 0.0032 + 0.02);
  });

  it("n'invente pas de coût pour un modèle sans tarif connu ou sans identifiant", () => {
    expect(estimateCostUsd("un-autre-modele", { ...none, inputTokens: 1_000 })).toBeNull();
    expect(estimateCostUsd(undefined, { ...none, inputTokens: 1_000 })).toBeNull();
  });

  it("le modèle créé porte son identifiant, pour que les journaux le mentionnent", () => {
    expect(createModel({ provider: "anthropic", apiKey: "essai", model: "claude-sonnet-5-5" }).id).toBe("claude-sonnet-5-5");
  });
});
