"use client";

export interface PhonePosition {
  lat: number;
  lon: number;
}

export type PositionResult = { ok: true; position: PhonePosition } | { ok: false; reason: "denied" | "unavailable" | "unsupported" };

/**
 * Lit la position du téléphone, une fois (US-107 RF11, RT3). Une application web ne la lit que lorsqu'elle est ouverte au premier plan : cette fonction n'est appelée que par l'écran
 * « Suivi du trajet » ouvert et, à l'activation du suivi, après l'écran qui explique l'usage de la position. La demande d'autorisation du téléphone s'affiche à la première lecture.
 */
export function readPhonePosition(): Promise<PositionResult> {
  return new Promise((resolve) => {
    if (typeof navigator === "undefined" || !("geolocation" in navigator)) return resolve({ ok: false, reason: "unsupported" });
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ ok: true, position: { lat: p.coords.latitude, lon: p.coords.longitude } }),
      (error) => resolve({ ok: false, reason: error.code === error.PERMISSION_DENIED ? "denied" : "unavailable" }),
      { enableHighAccuracy: false, maximumAge: 30_000, timeout: 15_000 },
    );
  });
}
