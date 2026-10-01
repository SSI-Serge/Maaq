import { randomUUID } from "node:crypto";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import { inject } from "vitest";
import { devOutbox } from "@/server/adapters/messaging";
import type { DB } from "@/server/db/schema.generated";
import { hashSecret } from "@/server/security/password";

export const PASSWORD = "Bonjour-maaq-2026";

export function testDb(): Kysely<DB> {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool({ connectionString: inject("databaseUrl"), max: 4 }) }) });
}

let passwordHash: Promise<string> | undefined;

export interface ProfileOptions {
  role?: "primary_user" | "guest" | "admin";
  phone?: string | null;
  status?: "active" | "pending_activation" | "grace_period" | "removed";
  accountStatus?: "active" | "grace_period";
  setupCompleted?: boolean;
}

/** Crée un profil isolé (email unique) avec son compte, pour un test. */
export async function createProfile(db: Kysely<DB>, options: ProfileOptions = {}) {
  passwordHash ??= hashSecret(PASSWORD);
  const role = options.role ?? "primary_user";
  const email = `${role}-${randomUUID().slice(0, 8)}@maaq.test`;
  const now = new Date();

  let accountId: string | null = null;
  if (role !== "admin") {
    const grace = options.accountStatus === "grace_period";
    const account = await db
      .insertInto("accounts")
      .values({
        status: options.accountStatus ?? "active",
        guest_quota: 3,
        grace_origin: grace ? "in_app_request" : null,
        grace_started_at: grace ? now : null,
        purge_scheduled_at: grace ? new Date(now.getTime() + 30 * 86_400_000) : null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    accountId = account.id;
  }

  const status = options.status ?? "active";
  const leaving = status === "grace_period" || status === "removed";
  const user = await db
    .insertInto("users")
    .values({
      account_id: accountId,
      role,
      guest_rank: role === "guest" ? "secondary" : null,
      first_name: "Camille",
      last_name: "Test",
      email,
      phone: options.phone === undefined ? "+33612345678" : options.phone,
      password_hash: status === "pending_activation" ? null : await passwordHash,
      status,
      initial_setup_step: role === "primary_user" ? (options.setupCompleted === false ? "step_1_my_info" : "completed") : null,
      activated_at: status === "pending_activation" ? null : now,
      purge_scheduled_at: leaving ? new Date(now.getTime() + 30 * 86_400_000) : null,
      removed_at: status === "removed" ? now : null,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  return { id: user.id, email, accountId };
}

/** Dernier code à 6 chiffres envoyé à cette adresse, lu dans la boîte de test. */
export async function lastCodeSentTo(to: string): Promise<string | null> {
  const message = (await devOutbox().list(500)).find((m) => m.to === to);
  return message?.text.match(/\b(\d{6})\b/)?.[1] ?? null;
}

export async function messagesTo(to: string) {
  return (await devOutbox().list(500)).filter((m) => m.to === to);
}

export function minutesLater(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}
