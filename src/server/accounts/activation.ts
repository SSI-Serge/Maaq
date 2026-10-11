import type { Kysely, Transaction } from "kysely";
import { messenger } from "@/server/adapters/messaging";
import type { DB } from "@/server/db/schema.generated";
import { env } from "@/server/env";
import { randomToken, sha256 } from "@/server/security/crypto";

type Db = Kysely<DB> | Transaction<DB>;

/** Lien d'activation valable 30 minutes, à usage unique (US-64 RF4, US-4). */
export const ACTIVATION_TTL_MINUTES = 30;

export type ActivationKind = "account_activation" | "guest_invitation";

/**
 * Crée un nouveau lien d'activation pour un profil. Le précédent est révoqué dans la même
 * transaction : un seul lien valable à la fois (US-5 RT1, US-64 RF6). Seule l'empreinte du jeton est stockée.
 */
export async function issueActivationLink(
  db: Db,
  input: { userId: string; kind: ActivationKind; createdBy: string; now: Date; sms?: boolean },
): Promise<{ token: string; linkId: string; expiresAt: Date }> {
  await db
    .updateTable("activation_links")
    .set({ revoked_at: input.now })
    .where("user_id", "=", input.userId)
    .where("used_at", "is", null)
    .where("revoked_at", "is", null)
    .execute();
  const token = randomToken();
  const expiresAt = new Date(input.now.getTime() + ACTIVATION_TTL_MINUTES * 60_000);
  const row = await db
    .insertInto("activation_links")
    .values({
      user_id: input.userId,
      kind: input.kind,
      token_hash: sha256(token),
      expires_at: expiresAt,
      sms_requested: input.sms ?? false,
      created_by_user_id: input.createdBy,
      created_at: input.now,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { token, linkId: row.id, expiresAt };
}

export function activationUrl(token: string): string {
  return `${env().APP_URL.replace(/\/$/, "")}/activation?jeton=${encodeURIComponent(token)}`;
}

/** Envoie l'email d'activation d'un utilisateur principal et trace le résultat de l'envoi. */
export async function sendAccountActivation(
  db: Db,
  input: { linkId: string; token: string; to: string; firstName: string; now: Date },
): Promise<boolean> {
  try {
    await messenger().sendEmail({
      to: input.to,
      subject: "Activez votre compte MAAQ",
      text:
        `Bonjour ${input.firstName},\n\n` +
        `Votre compte MAAQ est prêt. Pour l'activer et choisir votre mot de passe, ouvrez ce lien :\n\n` +
        `${activationUrl(input.token)}\n\n` +
        `Il est valable ${ACTIVATION_TTL_MINUTES} minutes et ne peut servir qu'une fois. ` +
        `S'il a expiré, contactez MAAQ pour en recevoir un nouveau.\n\nL'équipe MAAQ`,
    });
    await db
      .updateTable("activation_links")
      .set({ delivery_status: "sent", delivery_attempts: 1, sent_at: input.now })
      .where("id", "=", input.linkId)
      .execute();
    return true;
  } catch {
    await db
      .updateTable("activation_links")
      .set({ delivery_status: "failed", delivery_attempts: 1 })
      .where("id", "=", input.linkId)
      .execute();
    return false;
  }
}
