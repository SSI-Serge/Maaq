import { NextResponse } from "next/server";
import type { Ctx } from "@/server/auth/service";

const KEY_FORMAT = /^[A-Za-z0-9_-]{8,100}$/;

/**
 * Exécute une action au plus une fois par clé d'idempotence (CC-7). Si la même clé revient
 * (double toucher, « Réessayer » après une réponse perdue), la réponse enregistrée est renvoyée
 * sans refaire l'action. Seules les réponses réussies sont mémorisées : un refus peut être corrigé.
 */
export async function idempotent(
  ctx: Ctx,
  request: Request,
  userId: string,
  action: () => Promise<Response>,
): Promise<Response> {
  const key = request.headers.get("idempotency-key");
  if (!key || !KEY_FORMAT.test(key)) return action();
  const path = new URL(request.url).pathname;

  const previous = await ctx.db
    .selectFrom("idempotency_keys")
    .select(["request_path", "response_status", "response_body"])
    .where("user_id", "=", userId)
    .where("idempotency_key", "=", key)
    .executeTakeFirst();
  if (previous && previous.request_path === path) {
    return previous.response_status === 204
      ? new NextResponse(null, { status: 204 })
      : NextResponse.json(previous.response_body, { status: previous.response_status });
  }

  const response = await action();
  if (response.ok) {
    const body = response.status === 204 ? null : await response.clone().json().catch(() => null);
    await ctx.db
      .insertInto("idempotency_keys")
      .values({
        user_id: userId,
        idempotency_key: key,
        request_path: path,
        response_status: response.status,
        response_body: body === null ? null : JSON.stringify(body),
        created_at: ctx.now,
      })
      .onConflict((oc) => oc.columns(["user_id", "idempotency_key"]).doNothing())
      .execute();
  }
  return response;
}
