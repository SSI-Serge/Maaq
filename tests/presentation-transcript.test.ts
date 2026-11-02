import { describe, expect, it } from "vitest";
import { clock, parseTranscript } from "@/components/presentation/transcript";

describe("texte de la vidéo (US-140)", () => {
  it("une phrase par ligne, avec son heure quand elle est donnée, lignes vides ignorées", () => {
    expect(parseTranscript("0:00 MAAQ, l'assistant.\n\n1:03 Vos contrats rangés.\r\nSans heure ici.")).toEqual([
      { time: "0:00", text: "MAAQ, l'assistant." },
      { time: "1:03", text: "Vos contrats rangés." },
      { time: null, text: "Sans heure ici." },
    ]);
    expect(parseTranscript("  \n ")).toEqual([]);
  });

  it("une heure collée au texte ou une phrase qui commence par un nombre n'est pas prise pour une heure", () => {
    expect(parseTranscript("10:30h demain")).toEqual([{ time: null, text: "10:30h demain" }]);
    expect(parseTranscript("2026 sera l'année")).toEqual([{ time: null, text: "2026 sera l'année" }]);
  });

  it("affiche la durée en minutes et secondes", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(24.9)).toBe("0:24");
    expect(clock(80)).toBe("1:20");
    expect(clock(Number.NaN)).toBe("0:00");
  });
});
