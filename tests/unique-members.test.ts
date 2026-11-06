import { describe, expect, it } from "vitest";
import { uniqueMembers } from "@/components/family/parts";
import type { MemberChip } from "@/server/assistant/events";

const chip = (id: string): MemberChip => ({ id, firstName: id, color: "#123456" }) as MemberChip;

describe("Pastilles des membres", () => {
  it("un membre présent sur plusieurs rendez-vous n'apparaît qu'une fois, dans l'ordre d'apparition", () => {
    const all = [chip("a"), chip("b"), chip("a"), chip("c"), chip("b")];
    expect(uniqueMembers(all).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });

  it("la limite de trois pastilles de la semaine porte sur des membres distincts", () => {
    const all = [chip("a"), chip("a"), chip("b"), chip("b"), chip("c")];
    expect(uniqueMembers(all).slice(0, 3).map((m) => m.id)).toEqual(["a", "b", "c"]);
  });
});
