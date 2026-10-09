import { env } from "@/server/env";
import { CloudApiTransport } from "./cloud";
import { DevWhatsApp } from "./dev-outbox";
import type { WhatsAppTransport } from "./types";

declare global {
  // Une seule instance malgré le rechargement à chaud du serveur de développement.
  var __maaqWhatsApp: WhatsAppTransport | undefined;
  var __maaqWhatsAppDev: DevWhatsApp | undefined;
}

/** Transport WhatsApp selon WHATSAPP_MODE : boîte de test, ou Cloud API de Meta. */
export function whatsapp(): WhatsAppTransport {
  if (globalThis.__maaqWhatsApp) return globalThis.__maaqWhatsApp;
  const settings = env();
  globalThis.__maaqWhatsApp =
    settings.WHATSAPP_MODE === "cloud"
      ? new CloudApiTransport({ accessToken: settings.WHATSAPP_ACCESS_TOKEN!, phoneNumberId: settings.WHATSAPP_PHONE_NUMBER_ID!, apiVersion: settings.WHATSAPP_API_VERSION })
      : devWhatsApp();
  return globalThis.__maaqWhatsApp;
}

export function devWhatsApp(): DevWhatsApp {
  globalThis.__maaqWhatsAppDev ??= new DevWhatsApp();
  return globalThis.__maaqWhatsAppDev;
}

/** Remplace le transport (tests). */
export function useWhatsAppTransport(transport: WhatsAppTransport | undefined): void {
  globalThis.__maaqWhatsApp = transport;
}

export type * from "./types";
