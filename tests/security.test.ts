import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decrypt, emailFingerprint, encrypt, randomCode, sameHash, sha256 } from "@/server/security/crypto";
import { hashSecret, isStrongPassword, verifySecret } from "@/server/security/password";

describe("mots de passe", () => {
  it("US-3 RT4 : au moins 10 caractères, dont une lettre et un chiffre", () => {
    expect(isStrongPassword("abcdefghi1")).toBe(true);
    expect(isStrongPassword("Élodie2026x")).toBe(true);
    expect(isStrongPassword("abc123")).toBe(false);
    expect(isStrongPassword("abcdefghijk")).toBe(false);
    expect(isStrongPassword("12345678901")).toBe(false);
  });

  it("stocke une empreinte argon2id vérifiable, jamais le secret en clair", async () => {
    const stored = await hashSecret("Secret-2026");
    expect(stored).toMatch(/^\$argon2id\$/);
    expect(stored).not.toContain("Secret-2026");
    expect(await verifySecret(stored, "Secret-2026")).toBe(true);
    expect(await verifySecret(stored, "secret-2026")).toBe(false);
    expect(await verifySecret("empreinte-invalide", "x")).toBe(false);
  });
});

describe("chiffrement des informations des agents", () => {
  const key = randomBytes(32);

  it("déchiffre ce qu'il a chiffré", () => {
    const payload = encrypt("12 rue des Lilas, 75011 Paris", key);
    expect(payload.toString("utf8")).not.toContain("Lilas");
    expect(decrypt(payload, key)).toBe("12 rue des Lilas, 75011 Paris");
  });

  it("refuse une donnée altérée ou une mauvaise clé", () => {
    const payload = encrypt("valeur", key);
    const tampered = Buffer.from(payload);
    tampered[tampered.length - 1] ^= 1;
    expect(() => decrypt(tampered, key)).toThrow();
    expect(() => decrypt(payload, randomBytes(32))).toThrow();
  });
});

describe("codes et empreintes", () => {
  it("produit des codes à 6 chiffres", () => {
    for (let i = 0; i < 50; i++) expect(randomCode()).toMatch(/^\d{6}$/);
  });

  it("compare les empreintes à temps constant", () => {
    expect(sameHash(sha256("123456"), sha256("123456"))).toBe(true);
    expect(sameHash(sha256("123456"), sha256("654321"))).toBe(false);
  });

  it("D13 : l'empreinte de l'email ne dépend ni de la casse ni des espaces", () => {
    const key = randomBytes(32);
    expect(emailFingerprint(" Camille@Exemple.fr ", key)).toEqual(emailFingerprint("camille@exemple.fr", key));
  });
});
