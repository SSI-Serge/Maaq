/** Mise en forme des données affichées ou envoyées par les parcours de connexion. */

const BULLETS = "•••••";

/** « camille@exemple.fr » → « c•••••@exemple.fr » (maquettes Vérification et Connexion). */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return BULLETS;
  return `${local.slice(0, 1)}${BULLETS}@${domain}`;
}

/** « +33612345678 » → « 06 •• •• 56 78 » ; autre indicatif → « +44 •••• 5678 ». */
export function maskPhone(phone: string): string {
  if (phone.startsWith("+33") && phone.length === 12) {
    const national = `0${phone.slice(3)}`;
    return `${national.slice(0, 2)} •• •• ${national.slice(6, 8)} ${national.slice(8, 10)}`;
  }
  return `${phone.slice(0, 3)} •••• ${phone.slice(-4)}`;
}

const IANA_ZONE = /^(UTC|[A-Za-z_]+(\/[A-Za-z0-9_+-]+)+)$/;

/** Fuseau horaire déclaré par l'appareil (D21), accepté seulement s'il est connu. */
export function safeTimezone(value: unknown): string {
  if (typeof value !== "string" || !IANA_ZONE.test(value)) return "Europe/Paris";
  try {
    new Intl.DateTimeFormat("fr-FR", { timeZone: value });
    return value;
  } catch {
    return "Europe/Paris";
  }
}

/** Date et heure dans le fuseau de l'appareil, pour les emails du serveur (D21). */
export function formatDateTime(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("fr-FR", {
    timeZone,
    dateStyle: "long",
    timeStyle: "short",
  }).format(date);
}

export type DeviceKind = "android" | "iphone" | "desktop" | "other";

/** Type d'appareil et navigateur, à partir de l'en-tête User-Agent (US-51 RF3). */
export function describeDevice(userAgent: string | null): { type: DeviceKind; browser: string | null } {
  const ua = userAgent ?? "";
  const type: DeviceKind = /android/i.test(ua)
    ? "android"
    : /iphone|ipad|ipod/i.test(ua)
      ? "iphone"
      : /windows|macintosh|linux|cros/i.test(ua)
        ? "desktop"
        : "other";
  const browser = /edg(e|a|ios)?\//i.test(ua)
    ? "Edge"
    : /samsungbrowser/i.test(ua)
      ? "Samsung Internet"
      : /firefox|fxios/i.test(ua)
        ? "Firefox"
        : /chrome|crios/i.test(ua)
          ? "Chrome"
          : /safari/i.test(ua)
            ? "Safari"
            : null;
  return { type, browser };
}

export const DEVICE_LABEL: Record<DeviceKind, string> = {
  android: "téléphone Android",
  iphone: "iPhone",
  desktop: "ordinateur",
  other: "appareil",
};
