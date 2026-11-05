import { describe, expect, it } from "vitest";
import { mapsUrl } from "@/client/maps";

describe("« Ouvrir dans Plans/Maps »", () => {
  it("iPhone : Plans (Apple), itinéraire en voiture depuis la position de l'appareil", () => {
    expect(mapsUrl("Parking Q-Park, Nantes", { os: "iphone" })).toBe("https://maps.apple.com/?daddr=Parking%20Q-Park%2C%20Nantes&dirflg=d");
  });

  it("Android et ordinateur : Google Maps", () => {
    const url = "https://www.google.com/maps/dir/?api=1&destination=Parking%20Q-Park%2C%20Nantes";
    expect(mapsUrl("Parking Q-Park, Nantes", { os: "android" })).toBe(url);
    expect(mapsUrl("Parking Q-Park, Nantes", { os: "desktop" })).toBe(url);
    expect(mapsUrl("Parking Q-Park, Nantes", { os: "unknown" })).toBe(url);
  });

  it("le nom du lieu est encodé : une adresse avec & ou # ne casse pas le lien", () => {
    const url = mapsUrl("  Café & Co #2, 12 rue de l'Église  ", { os: "android" });
    expect(url).toBe("https://www.google.com/maps/dir/?api=1&destination=Caf%C3%A9%20%26%20Co%20%232%2C%2012%20rue%20de%20l'%C3%89glise");
    expect(new URL(url).searchParams.get("destination")).toBe("Café & Co #2, 12 rue de l'Église");
  });
});
