import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";

/**
 * Chiffrement AES-256-GCM des informations personnelles saisies pour les agents
 * (user_agent_info_values.value_encrypted). Format : version(1) | iv(12) | tag(16) | données.
 */
const FORMAT_VERSION = 1;

export function encrypt(plain: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, cipher.getAuthTag(), data]);
}

export function decrypt(payload: Buffer, key: Buffer): string {
  if (payload[0] !== FORMAT_VERSION) throw new Error("Format de chiffrement inconnu");
  const iv = payload.subarray(1, 13);
  const tag = payload.subarray(13, 29);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload.subarray(29)), decipher.final()]).toString("utf8");
}

/** Même chiffrement pour un fichier (export de données, US-55 RT2). */
export function encryptBytes(plain: Buffer, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, cipher.getAuthTag(), data]);
}

export function decryptBytes(payload: Buffer, key: Buffer): Buffer {
  if (payload[0] !== FORMAT_VERSION) throw new Error("Format de chiffrement inconnu");
  const decipher = createDecipheriv("aes-256-gcm", key, payload.subarray(1, 13));
  decipher.setAuthTag(payload.subarray(13, 29));
  return Buffer.concat([decipher.update(payload.subarray(29)), decipher.final()]);
}

/** Jeton aléatoire envoyé à l'utilisateur (lien d'activation, cookie de session). */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** Code à 6 chiffres (vérification d'appareil, récupération, mot de passe oublié). */
export function randomCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, "0");
}

/** Empreinte SHA-256 stockée en base à la place d'un jeton ou d'un code. */
export function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/** Comparaison à temps constant de deux empreintes. */
export function sameHash(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Empreinte HMAC de l'email du consentant (D13), normalisé en minuscules. */
export function emailFingerprint(email: string, hmacKey: Buffer): Buffer {
  return createHmac("sha256", hmacKey).update(email.trim().toLowerCase(), "utf8").digest();
}
