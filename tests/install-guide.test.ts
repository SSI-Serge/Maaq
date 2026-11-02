import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installGuide, installGuideDue, installGuideUrl, platformOf, safeNext, type Platform } from "@/client/auth";

const IPHONE_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1";
const IPHONE_CHROME = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/124.0.6367.88 Mobile/15E148 Safari/604.1";
const IPHONE_INSTAGRAM = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 320.0.0.12.109 (iPhone14,5; iOS 17_2; fr_FR)";
const IPHONE_WEBVIEW = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"; // vue web d'application : pas de « Safari »
const ANDROID_CHROME = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36";
const ANDROID_WEBVIEW = "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/UQ1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/124.0.6367.82 Mobile Safari/537.36";
const ANDROID_FACEBOOK = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.6367.82 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/450.0.0.38.108;]";
const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const platform = (userAgent: string, standalone = false, maxTouchPoints = 5): Platform => platformOf({ userAgent, maxTouchPoints, standalone });

describe("détection de l'appareil pour le guidage d'installation (US-1 RF2, RF5, RT1)", () => {
  it("reconnaît iPhone dans Safari, Android dans Chrome et un ordinateur, sans navigateur intégré", () => {
    expect(platform(IPHONE_SAFARI)).toEqual({ os: "iphone", standalone: false, iosNonSafari: false, inApp: false });
    expect(platform(ANDROID_CHROME)).toEqual({ os: "android", standalone: false, iosNonSafari: false, inApp: false });
    expect(platform(DESKTOP, false, 0)).toMatchObject({ os: "desktop", inApp: false });
  });

  it("iPhone dans un autre navigateur que Safari : demande d'ouvrir dans Safari (RF5)", () => {
    expect(platform(IPHONE_CHROME)).toMatchObject({ os: "iphone", iosNonSafari: true, inApp: false });
  });

  it("iPhone dans le navigateur intégré d'une application (réseau social, vue web sans « Safari ») : demande d'ouvrir dans Safari", () => {
    expect(platform(IPHONE_INSTAGRAM)).toMatchObject({ os: "iphone", iosNonSafari: true, inApp: true });
    expect(platform(IPHONE_WEBVIEW)).toMatchObject({ os: "iphone", iosNonSafari: true, inApp: true });
  });

  it("Android dans un navigateur intégré (WebView, application sociale) : demande d'ouvrir dans Chrome", () => {
    expect(platform(ANDROID_WEBVIEW)).toMatchObject({ os: "android", inApp: true, iosNonSafari: false });
    expect(platform(ANDROID_FACEBOOK)).toMatchObject({ os: "android", inApp: true });
  });

  it("une application déjà installée (mode installé) n'est jamais prise pour un navigateur intégré, même sans « Safari » dans l'agent", () => {
    expect(platform(IPHONE_WEBVIEW, true)).toMatchObject({ standalone: true, inApp: false, iosNonSafari: false });
    expect(platform(ANDROID_WEBVIEW, true)).toMatchObject({ standalone: true, inApp: false });
  });
});

/** Stockage de session simulé : vidé = nouvelle ouverture de l'application. */
function fakeSessionStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
  };
}

describe("quand le guidage d'installation est proposé (US-1 RF1, RF7)", () => {
  let storage: ReturnType<typeof fakeSessionStorage>;
  beforeEach(() => {
    storage = fakeSessionStorage();
    vi.stubGlobal("sessionStorage", storage);
  });
  afterEach(() => vi.unstubAllGlobals());

  const due = (p: Platform) => installGuideDue(p, { dismissed: installGuide.dismissed(), alreadyShown: installGuide.shown() });

  it("après une activation, sur un téléphone ouvert dans le navigateur : le guidage passe avant la suite", () => {
    expect(installGuideDue(platform(IPHONE_SAFARI), { dismissed: installGuide.dismissed() })).toBe(true);
    expect(installGuideDue(platform(ANDROID_CHROME), { dismissed: installGuide.dismissed() })).toBe(true);
    expect(installGuideUrl("/schema/creer")).toBe("/installer?next=%2Fschema%2Fcreer");
  });

  it("à l'arrivée par un lien direct dans l'espace connecté : proposé une seule fois par session, pas à chaque écran", () => {
    const phone = platform(ANDROID_CHROME);
    expect(due(phone)).toBe(true); // première arrivée, par exemple sur un lien d'un email
    installGuide.markShown(); // la garde amène au guidage
    expect(due(phone)).toBe(false); // l'écran suivant de la même session : plus de guidage
    storage.clear(); // l'application est rouverte plus tard
    expect(due(phone)).toBe(true);
  });

  it("en mode installé (lancée depuis l'écran d'accueil), jamais de guidage", () => {
    expect(due(platform(IPHONE_SAFARI, true))).toBe(false);
    expect(due(platform(ANDROID_CHROME, true))).toBe(false);
  });

  it("« Plus tard » vaut pour la session, puis le guidage revient à la prochaine ouverture", () => {
    const phone = platform(IPHONE_SAFARI);
    expect(due(phone)).toBe(true);
    installGuide.dismiss();
    expect(due(phone)).toBe(false);
    expect(installGuideDue(phone, { dismissed: installGuide.dismissed() })).toBe(false); // la page de démarrage non plus
    storage.clear();
    expect(due(phone)).toBe(true);
  });

  it("jamais sur un ordinateur", () => {
    expect(due(platform(DESKTOP, false, 0))).toBe(false);
  });

  it("un stockage de session indisponible ne bloque rien : le guidage est simplement proposé", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("indisponible");
      },
      setItem: () => {
        throw new Error("indisponible");
      },
    });
    expect(installGuide.dismissed()).toBe(false);
    expect(() => installGuide.markShown()).not.toThrow();
    expect(due(platform(ANDROID_CHROME))).toBe(true);
  });
});

describe("adresse de reprise après le guidage (paramètre next)", () => {
  it("accepte un chemin de l'application, avec ou sans paramètres", () => {
    expect(safeNext("/accueil")).toBe("/accueil");
    expect(safeNext("/export?id=0b9c7f5e-1111-4111-8111-111111111111")).toBe("/export?id=0b9c7f5e-1111-4111-8111-111111111111");
    expect(safeNext("/schema/creer")).toBe("/schema/creer");
  });

  it("refuse une adresse extérieure, relative au protocole, le guidage lui-même, ou vide", () => {
    for (const bad of [null, "", "accueil", "https://exemple.fr/x", "//exemple.fr", "/\\exemple.fr", "/installer", "/installer?next=%2Faccueil", "/installer/", "/" + "a".repeat(400)]) {
      expect(safeNext(bad), String(bad)).toBeNull();
    }
  });
});
