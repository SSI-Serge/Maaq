import { describe, expect, it } from "vitest";
import { pushStateOf, type DeviceFacts } from "@/client/push";

const IPHONE = (version: string) => `Mozilla/5.0 (iPhone; CPU iPhone OS ${version} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1`;
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36";
const IPAD_AS_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15";

const base: DeviceFacts = {
  userAgent: ANDROID, platform: "Linux armv8l", maxTouchPoints: 5, standalone: false, hasServiceWorker: true, hasPush: true, hasNotification: true,
  permission: "default", serverConfigured: true, subscribed: false,
};
const state = (over: Partial<DeviceFacts>) => pushStateOf({ ...base, ...over });

describe("écran d'activation des rappels : ce que propose chaque appareil (US-94)", () => {
  it("propose d'activer sur Android et sur un ordinateur, sans installation (CA 1.1, 2.1)", () => {
    expect(state({})).toBe("ready");
    expect(state({ userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/124.0", platform: "Win32", maxTouchPoints: 0 })).toBe("ready");
  });

  it("propose d'activer sur un iPhone où MAAQ est installée (CA 1.1)", () => {
    expect(state({ userAgent: IPHONE("17_2"), platform: "iPhone", standalone: true })).toBe("ready");
    expect(state({ userAgent: IPHONE("16_4"), platform: "iPhone", standalone: true })).toBe("ready"); // 16.4 est la première version qui sait
  });

  it("demande d'installer MAAQ d'abord sur un iPhone ouvert dans Safari (RF7, CA 7.1)", () => {
    expect(state({ userAgent: IPHONE("17_2"), platform: "iPhone", standalone: false, hasPush: false })).toBe("ios_install");
  });

  it("prévient qu'une mise à jour d'iOS est nécessaire avant iOS 16.4, installée ou non (RT4)", () => {
    for (const version of ["15_8", "16_0", "16_3"]) {
      expect(state({ userAgent: IPHONE(version), platform: "iPhone", standalone: true, hasPush: false })).toBe("ios_too_old");
      expect(state({ userAgent: IPHONE(version), platform: "iPhone", standalone: false, hasPush: false })).toBe("ios_too_old");
    }
  });

  it("reconnaît un iPad récent qui se présente comme un Mac", () => {
    expect(state({ userAgent: IPAD_AS_MAC, platform: "MacIntel", maxTouchPoints: 5, standalone: false, hasPush: false })).toBe("ios_install");
    expect(state({ userAgent: IPAD_AS_MAC, platform: "MacIntel", maxTouchPoints: 0 })).toBe("ready"); // un vrai Mac
  });

  it("ne propose rien quand l'autorisation est déjà accordée et l'appareil inscrit (CA 1.2)", () => {
    expect(state({ permission: "granted", subscribed: true })).toBe("enabled");
    // Autorisé sur le téléphone mais inconnu du serveur (après une déconnexion) : à réinscrire, donc pas « activé ».
    expect(state({ permission: "granted", subscribed: false })).toBe("ready");
  });

  it("explique qu'il faut passer par les réglages du téléphone après un refus (RF5)", () => {
    expect(state({ permission: "denied" })).toBe("denied");
  });

  it("indique quand le navigateur ne sait pas, ou que le serveur n'a pas de clés", () => {
    expect(state({ hasPush: false })).toBe("unsupported");
    expect(state({ hasNotification: false })).toBe("unsupported");
    expect(state({ hasServiceWorker: false })).toBe("unsupported");
    expect(state({ serverConfigured: false })).toBe("unavailable");
  });
});
