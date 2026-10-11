import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { db } from "@/server/db/client";
import { env } from "@/server/env";
import { handler, rejected } from "@/server/http";
import { runDueJobs } from "@/server/jobs";

export const dynamic = "force-dynamic";

/** Déclenchement des traitements périodiques par un planificateur externe, protégé par CRON_SECRET. */
export const POST = handler(async (request: Request) => {
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${env().CRON_SECRET}`);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return rejected("unauthorized", "Accès refusé.", 401);
  return NextResponse.json(await runDueJobs({ db: db(), now: new Date() }));
});
