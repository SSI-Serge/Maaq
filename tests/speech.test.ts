import { describe, expect, it } from "vitest";
import { assembleTranscript, createDictation, dictatedText, MAX_QUIET_SESSIONS, type Recognition, type SpeechProblem } from "@/client/speech";

describe("texte d'une dictée dans le champ de saisie (US-71)", () => {
  it("écrit ce qui est dit, avec ce qui est en cours de reconnaissance", () => {
    expect(dictatedText("", "Dentiste pour Léo ", "mardi à")).toBe("Dentiste pour Léo mardi à");
    expect(dictatedText("", "Dentiste pour Léo mardi à 17h ", "")).toBe("Dentiste pour Léo mardi à 17h");
  });

  it("garde le texte déjà écrit et le complète par un espace", () => {
    expect(dictatedText("Réunion jeudi.", "à 18h ", "")).toBe("Réunion jeudi. à 18h");
    expect(dictatedText("Réunion jeudi.  ", "à 18h ", "")).toBe("Réunion jeudi. à 18h");
  });

  it("laisse le champ tel quel tant que rien n'est dit", () => {
    expect(dictatedText("Réunion jeudi", "", "")).toBe("Réunion jeudi");
    expect(dictatedText("", "", "")).toBe("");
    expect(dictatedText("Réunion jeudi", " ", "")).toBe("Réunion jeudi");
  });
});

const said = (...texts: string[]) => texts.map((text) => ({ text }));

describe("assemblage de ce que la reconnaissance a entendu (anomalie Android du 27/10)", () => {
  it("résultats cumulatifs d'Android : chaque résultat contient les précédents, le texte n'est pas répété", () => {
    // Ce que Chrome sur Android renvoie en mode continu : « rendez-vous », « rendez-vous robotique », « rendez-vous robotique demain »…
    expect(assembleTranscript(said("rendez-vous", "rendez-vous robotique", "rendez-vous robotique demain", "rendez-vous robotique demain à 16h"))).toBe("rendez-vous robotique demain à 16h");
  });

  it("résultats successifs sans recouvrement (autres navigateurs) : ils s'ajoutent", () => {
    expect(assembleTranscript(said("rendez-vous robotique", " demain", " à 16h"))).toBe("rendez-vous robotique demain à 16h");
  });

  it("un résultat définitif suivi d'un résultat en cours qui le prolonge", () => {
    expect(assembleTranscript(said("Dentiste pour Léo", "dentiste pour léo mardi à"))).toBe("dentiste pour léo mardi à");
  });

  it("ignore les majuscules et les espaces en trop pour reconnaître un résultat cumulatif", () => {
    expect(assembleTranscript(said("Rendez-vous  robotique", "rendez-vous robotique demain"))).toBe("rendez-vous robotique demain");
  });

  it("un résultat plus court qui n'est que le début de ce qui est écrit est ignoré", () => {
    expect(assembleTranscript(said("rendez-vous robotique demain", "rendez-vous robotique"))).toBe("rendez-vous robotique demain");
  });

  it("rien d'entendu, ou seulement des blancs : rien", () => {
    expect(assembleTranscript([])).toBe("");
    expect(assembleTranscript(said("  ", ""))).toBe("");
  });

  it("limite connue : deux résultats identiques de suite n'en font qu'un", () => {
    expect(assembleTranscript(said("oui", "oui"))).toBe("oui");
  });
});

/** Fausse reconnaissance vocale : le test déclenche lui-même résultats, erreurs et fin de session. */
class FakeRecognition implements Recognition {
  static sessions: FakeRecognition[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  onresult: Recognition["onresult"] = null;
  onerror: Recognition["onerror"] = null;
  onend: Recognition["onend"] = null;
  started = false;
  constructor() {
    FakeRecognition.sessions.push(this);
  }
  start() {
    if (FakeRecognition.failToStart) throw new Error("déjà démarrée");
    this.started = true;
  }
  stop() {
    this.started = false;
    this.onend?.();
  }
  static failToStart = false;
  hear(...texts: string[]) {
    this.onresult?.({ resultIndex: 0, results: texts.map((text) => ({ isFinal: true, 0: { transcript: text } })) });
  }
  /** Le navigateur coupe la session (silence, limite de durée…). */
  cut() {
    this.started = false;
    this.onend?.();
  }
}

function dictation(initial = "") {
  FakeRecognition.sessions = [];
  FakeRecognition.failToStart = false;
  const state = { text: initial, problems: [] as SpeechProblem[], ended: 0, expired: false };
  const controller = createDictation(FakeRecognition, {
    getText: () => state.text,
    setText: (value) => {
      state.text = value;
    },
    onProblem: (p) => state.problems.push(p),
    onEnd: () => {
      state.ended += 1;
    },
    expired: () => state.expired,
  });
  const last = () => FakeRecognition.sessions[FakeRecognition.sessions.length - 1];
  return { state, controller, last, count: () => FakeRecognition.sessions.length };
}

describe("dictée jusqu'à « Stop » (anomalie Android du 27/10)", () => {
  it("écrit le texte reconstruit dans le champ, sans répétition, à chaque résultat", () => {
    const d = dictation();
    d.controller.start();
    d.last().hear("rendez-vous");
    d.last().hear("rendez-vous", "rendez-vous robotique");
    d.last().hear("rendez-vous", "rendez-vous robotique", "rendez-vous robotique demain à 16h");
    expect(d.state.text).toBe("rendez-vous robotique demain à 16h");
  });

  it("configure la reconnaissance en français, continue, avec résultats intermédiaires", () => {
    const d = dictation();
    d.controller.start();
    expect(d.last()).toMatchObject({ lang: "fr-FR", continuous: true, interimResults: true, started: true });
  });

  it("le navigateur coupe la session après un silence : une nouvelle session repart à la suite du texte, sans que la dictée s'arrête", () => {
    const d = dictation("Bonjour");
    d.controller.start();
    d.last().hear("rendez-vous robotique");
    expect(d.state.text).toBe("Bonjour rendez-vous robotique");
    d.last().cut();
    expect(d.count()).toBe(2);
    expect(d.state.ended).toBe(0);
    d.last().hear("demain à 16h");
    expect(d.state.text).toBe("Bonjour rendez-vous robotique demain à 16h");
  });

  it("« Stop » arrête la dictée sans relancer de session", () => {
    const d = dictation();
    d.controller.start();
    d.last().hear("rendez-vous");
    d.controller.stop();
    expect(d.count()).toBe(1);
    expect(d.state.ended).toBe(1);
    expect(d.state.text).toBe("rendez-vous");
  });

  it("la durée maximale atteinte : la session coupée n'est pas relancée", () => {
    const d = dictation();
    d.controller.start();
    d.last().hear("rendez-vous");
    d.state.expired = true;
    d.last().cut();
    expect(d.count()).toBe(1);
    expect(d.state.ended).toBe(1);
  });

  it(`après ${MAX_QUIET_SESSIONS} sessions de suite sans un mot, la dictée s'arrête`, () => {
    const d = dictation();
    d.controller.start();
    for (let i = 0; i < MAX_QUIET_SESSIONS - 1; i++) {
      d.last().cut();
      expect(d.state.ended).toBe(0);
    }
    d.last().cut();
    expect(d.count()).toBe(MAX_QUIET_SESSIONS);
    expect(d.state.ended).toBe(1);
  });

  it("une parole remet à zéro le compte des sessions silencieuses", () => {
    const d = dictation();
    d.controller.start();
    d.last().cut();
    d.last().cut();
    d.last().hear("on reprend");
    d.last().cut();
    d.last().cut();
    expect(d.state.ended).toBe(0);
    expect(d.count()).toBe(5);
  });

  it("micro refusé : le refus est signalé et la dictée s'arrête, sans boucle de relance", () => {
    const d = dictation();
    d.controller.start();
    d.last().onerror?.({ error: "not-allowed" });
    d.last().cut();
    expect(d.state.problems).toContain("denied");
    expect(d.count()).toBe(1);
    expect(d.state.ended).toBe(1);
  });

  it("« aucune parole » et « interrompu » ne sont pas des erreurs : la session est relancée", () => {
    const d = dictation();
    d.controller.start();
    d.last().onerror?.({ error: "no-speech" });
    d.last().cut();
    d.last().onerror?.({ error: "aborted" });
    d.last().cut();
    expect(d.state.problems).toEqual([null]);
    expect(d.count()).toBe(3);
  });

  it("une autre erreur arrête la dictée avec le message d'échec", () => {
    const d = dictation();
    d.controller.start();
    d.last().onerror?.({ error: "network" });
    d.last().cut();
    expect(d.state.problems).toContain("failed");
    expect(d.state.ended).toBe(1);
  });

  it("une reconnaissance qui ne démarre pas : échec signalé, rien ne reste actif", () => {
    FakeRecognition.sessions = [];
    FakeRecognition.failToStart = true;
    const problems: SpeechProblem[] = [];
    const controller = createDictation(FakeRecognition, { getText: () => "", setText: () => {}, onProblem: (p) => problems.push(p), onEnd: () => {}, expired: () => false });
    expect(controller.start()).toBe(false);
    expect(problems).toContain("failed");
    FakeRecognition.failToStart = false;
    expect(controller.start()).toBe(true);
  });
});
