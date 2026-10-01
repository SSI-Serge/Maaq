import type { Kysely } from "kysely";
import type { DB } from "@/server/db/schema.generated";
import { randomCode, sameHash } from "@/server/security/crypto";
import {
  CODE_MAX_ATTEMPTS,
  CODE_MAX_PER_HOUR,
  CODE_RESEND_SECONDS,
  CODE_TTL_MINUTES,
  type CodePurpose,
} from "./rules";
import { secretDigest } from "./tokens";

/**
 * Codes à 6 chiffres envoyés par email ou SMS : vérification d'appareil (US-51), récupération
 * du schéma (US-8), mot de passe oublié (US-66). Le code n'est jamais stocké en clair.
 */

export type IssueResult =
  | { ok: true; code: string; expiresAt: Date; resendAvailableAt: Date }
  | { ok: false; reason: "cooldown" | "rate_limited"; retryAt: Date };

export interface IssueInput {
  userId: string;
  purpose: CodePurpose;
  channel: "email" | "sms";
  target: string;
  deviceIdentifier?: string;
  now: Date;
}

export async function issueCode(db: Kysely<DB>, input: IssueInput): Promise<IssueResult> {
  const { userId, purpose, now } = input;
  return db.transaction().execute(async (trx) => {
    // Verrou sur le profil : deux demandes simultanées ne contournent pas les limites.
    await trx.selectFrom("users").select("id").where("id", "=", userId).forUpdate().executeTakeFirst();

    const hourAgo = new Date(now.getTime() - 3_600_000);
    const recent = await trx
      .selectFrom("verification_codes")
      .select("created_at")
      .where("user_id", "=", userId)
      .where("purpose", "=", purpose)
      .where("created_at", ">", hourAgo)
      .orderBy("created_at", "desc")
      .execute();

    if (recent.length > 0) {
      const cooldownEnd = new Date(new Date(recent[0].created_at).getTime() + CODE_RESEND_SECONDS * 1000);
      if (cooldownEnd > now) return { ok: false, reason: "cooldown", retryAt: cooldownEnd };
    }
    if (recent.length >= CODE_MAX_PER_HOUR) {
      const oldest = new Date(recent[recent.length - 1].created_at);
      return { ok: false, reason: "rate_limited", retryAt: new Date(oldest.getTime() + 3_600_000) };
    }

    // Un seul code valable à la fois : le nouveau remplace les précédents.
    await trx
      .updateTable("verification_codes")
      .set({ invalidated_at: now })
      .where("user_id", "=", userId)
      .where("purpose", "=", purpose)
      .where("consumed_at", "is", null)
      .where("invalidated_at", "is", null)
      .execute();

    const code = randomCode();
    const expiresAt = new Date(now.getTime() + CODE_TTL_MINUTES[purpose] * 60_000);
    await trx
      .insertInto("verification_codes")
      .values({
        user_id: userId,
        purpose,
        channel: input.channel,
        target: input.target,
        code_hash: secretDigest(`code:${purpose}`, userId, code),
        expires_at: expiresAt,
        device_identifier: input.deviceIdentifier ?? null,
        created_at: now,
      })
      .execute();

    return { ok: true, code, expiresAt, resendAvailableAt: new Date(now.getTime() + CODE_RESEND_SECONDS * 1000) };
  });
}

export type CheckResult = "ok" | "incorrect" | "expired" | "invalidated" | "missing";

export interface CheckInput {
  userId: string;
  purpose: CodePurpose;
  code: string;
  deviceIdentifier?: string;
  now: Date;
}

/** Vérifie et consomme le dernier code envoyé. Un code correct ne sert qu'une fois. */
export async function checkCode(db: Kysely<DB>, input: CheckInput): Promise<CheckResult> {
  const { userId, purpose, now } = input;
  return db.transaction().execute(async (trx) => {
    let query = trx
      .selectFrom("verification_codes")
      .select(["id", "code_hash", "expires_at", "failed_attempts", "invalidated_at"])
      .where("user_id", "=", userId)
      .where("purpose", "=", purpose)
      .where("consumed_at", "is", null)
      .orderBy("created_at", "desc")
      .limit(1)
      .forUpdate();
    if (input.deviceIdentifier) query = query.where("device_identifier", "=", input.deviceIdentifier);
    const row = await query.executeTakeFirst();

    if (!row) return "missing";
    if (row.invalidated_at) return row.failed_attempts >= CODE_MAX_ATTEMPTS ? "invalidated" : "missing";
    if (new Date(row.expires_at) <= now) return "expired";

    const expected = secretDigest(`code:${purpose}`, userId, input.code.trim());
    if (sameHash(Buffer.from(row.code_hash), expected)) {
      await trx.updateTable("verification_codes").set({ consumed_at: now }).where("id", "=", row.id).execute();
      return "ok";
    }

    const failed = row.failed_attempts + 1;
    const exhausted = failed >= CODE_MAX_ATTEMPTS;
    await trx
      .updateTable("verification_codes")
      .set({ failed_attempts: failed, invalidated_at: exhausted ? now : null })
      .where("id", "=", row.id)
      .execute();
    return exhausted ? "invalidated" : "incorrect";
  });
}
