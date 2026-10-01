import { NextResponse } from "next/server";
import { requireProfile } from "@/server/auth/http";
import { handler, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

/** Informations de l'écran de reprise de compte : date de suppression et origine (US-3 RF11, US-59). */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ allowGrace: true });
  if (!session.user.inGracePeriod) throw new Rejection("not_in_grace", "Ce compte n'est pas en cours de suppression.", 409);

  const row = await ctx.db
    .selectFrom("users as u")
    .leftJoin("accounts as a", "a.id", "u.account_id")
    .select(["u.role", "u.status", "u.purge_scheduled_at as user_purge", "a.purge_scheduled_at as account_purge", "a.grace_origin"])
    .where("u.id", "=", session.user.id)
    .executeTakeFirstOrThrow();

  // Un invité qui a demandé sa propre suppression a sa propre échéance ; sinon c'est celle du compte.
  const purgeAt = row.status === "grace_period" ? row.user_purge : row.account_purge;
  return NextResponse.json({
    role: row.role,
    deleteDate: purgeAt ? new Date(purgeAt).toISOString() : null,
    origin: row.status === "grace_period" ? "in_app_request" : row.grace_origin,
  });
});
