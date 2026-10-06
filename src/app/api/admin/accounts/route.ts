import { NextResponse } from "next/server";
import { z } from "zod";
import { createAccount, listAccounts } from "@/server/admin/accounts";
import { requireAdmin } from "@/server/auth/http";
import { handler, parseBody } from "@/server/http";
import { idempotent } from "@/server/idempotency";

export const dynamic = "force-dynamic";

/** Comptes des utilisateurs principaux, filtrables (US-64 RF1). */
export const GET = handler(async (request: Request) => {
  const { ctx } = await requireAdmin();
  const search = new URL(request.url).searchParams.get("q") ?? "";
  return NextResponse.json({ accounts: await listAccounts(ctx, search) });
});

const schema = z.object({
  firstName: z.string().max(100),
  lastName: z.string().max(100),
  email: z.string().max(254),
  phone: z.string().max(30),
  guestQuota: z.number(),
  dailyRequestLimit: z.number(),
});

/** Crée un compte et envoie le lien d'activation (US-64 RF2 à RF4). */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireAdmin();
  return idempotent(ctx, request, session.user.id, async () => {
    const input = await parseBody(request, schema);
    const created = await createAccount(ctx, session.user.id, input);
    return NextResponse.json(created, { status: 201 });
  });
});
