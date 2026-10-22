import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { devCalendar } from "@/server/adapters/calendar";
import { db } from "@/server/db/client";
import { devOnlyGuard } from "@/server/dev-tools";
import { handler, parseBody, Rejection } from "@/server/http";
import { runMarketplaceJobs } from "@/server/jobs";

export const dynamic = "force-dynamic";

/** Agenda de démonstration : événements par profil (email), et déclenchement du passage du marketplace. */
export const GET = handler(async () => {
  const guard = devOnlyGuard();
  if (guard) return guard;
  const users = await db().selectFrom("users").select(["id", "email", "first_name"]).where("role", "!=", "admin").orderBy("email").execute();
  const calendar = devCalendar();
  const profiles = [];
  for (const user of users) profiles.push({ id: user.id, email: user.email, firstName: user.first_name, events: await calendar.list(user.id) });
  return NextResponse.json({ profiles });
});

const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("add"), email: z.string().email(), title: z.string().trim().min(1).max(200), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^\d{2}:\d{2}$/).optional() }),
  z.object({ action: z.literal("remove"), email: z.string().email(), eventId: z.string().uuid() }),
  z.object({ action: z.literal("scan") }),
]);

export const POST = handler(async (request: NextRequest) => {
  const guard = devOnlyGuard();
  if (guard) return guard;
  const body = await parseBody(request, schema);
  if (body.action === "scan") return NextResponse.json({ result: await runMarketplaceJobs({ db: db(), now: new Date() }) });
  const user = await db().selectFrom("users").select("id").where("email", "=", body.email).executeTakeFirst();
  if (!user) throw new Rejection("not_found", "Aucun profil avec cet email.", 404);
  if (body.action === "add") return NextResponse.json({ event: await devCalendar().add(user.id, { title: body.title, date: body.date, time: body.time ?? null }) }, { status: 201 });
  await devCalendar().remove(user.id, body.eventId);
  return NextResponse.json({ removed: body.eventId });
});
