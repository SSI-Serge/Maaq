import { env } from "@/server/env";
import { decrypt, encrypt } from "@/server/security/crypto";

/**
 * Chiffrement des champs libres d'un rendez-vous (titre, lieu, note) : ils peuvent contenir un prénom ou une donnée de santé
 * (US-75 RT5). Même chiffrement que les informations personnelles saisies pour les agents (AES-256-GCM, clé de l'application).
 */
const key = () => Buffer.from(env().ENCRYPTION_KEY, "base64");

export const seal = (text: string): Buffer => encrypt(text, key());
export const sealOptional = (text: string | null | undefined): Buffer | null => (text ? encrypt(text, key()) : null);
export const open = (payload: Buffer): string => decrypt(payload, key());
export const openOptional = (payload: Buffer | null): string | null => (payload ? decrypt(payload, key()) : null);
