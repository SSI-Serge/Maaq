import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "@/server/env";

/**
 * Petits jetons signés (HMAC-SHA256) portés par des cookies : vérification d'appareil en
 * attente, droit de recréer son schéma ou son mot de passe, déverrouillage de la session.
 * Ils ne contiennent aucune donnée personnelle, seulement des identifiants et une échéance.
 */
export interface SignedPayload {
  /** Échéance, en millisecondes depuis l'époque Unix. */
  exp: number;
}

function key(): Buffer {
  return Buffer.from(env().AUTH_SECRET, "base64");
}

function mac(data: string): string {
  return createHmac("sha256", key()).update(`maaq-token:${data}`).digest("base64url");
}

export function signToken<T extends SignedPayload>(payload: T): string {
  const data = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${data}.${mac(data)}`;
}

export function verifyToken<T extends SignedPayload>(token: string | undefined, now: Date = new Date()): T | null {
  if (!token) return null;
  const [data, signature] = token.split(".");
  if (!data || !signature) return null;
  const expected = Buffer.from(mac(data));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as T;
    return typeof payload.exp === "number" && payload.exp > now.getTime() ? payload : null;
  } catch {
    return null;
  }
}

/**
 * Empreinte d'un secret court (code à 6 chiffres, schéma) liée au profil et protégée par la clé
 * serveur : une copie de la base ne suffit pas à retrouver les codes par force brute.
 */
export function secretDigest(scope: string, userId: string, secret: string): Buffer {
  return createHmac("sha256", key()).update(`${scope}:${userId}:${secret}`).digest();
}
