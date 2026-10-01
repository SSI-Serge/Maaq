import { hash, verify } from "@node-rs/argon2";

/** Règle de robustesse (US-3 RT4) : au moins 10 caractères, dont une lettre et un chiffre. */
export function isStrongPassword(password: string): boolean {
  return password.length >= 10 && /\p{L}/u.test(password) && /\d/.test(password);
}

// Paramètres argon2id recommandés par l'OWASP (19 Mio, 2 passes).
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** Empreinte irréversible argon2id (mots de passe et schémas tactiles). */
export function hashSecret(secret: string): Promise<string> {
  return hash(secret, ARGON2_OPTIONS);
}

export async function verifySecret(storedHash: string, secret: string): Promise<boolean> {
  try {
    return await verify(storedHash, secret);
  } catch {
    return false;
  }
}
