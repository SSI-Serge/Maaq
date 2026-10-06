import { NextResponse } from "next/server";
import { db } from "@/server/db/client";
import { devOnlyGuard } from "@/server/dev-tools";
import { handler } from "@/server/http";
import { runDueJobs } from "@/server/jobs";

export const dynamic = "force-dynamic";

/** Développement : lance tout de suite la synchronisation du carnet, sans attendre l'échéance. */
export const POST = handler(async () => {
  const guard = devOnlyGuard();
  if (guard) return guard;
  return NextResponse.json(await runDueJobs({ db: db(), now: new Date() }, { force: true }));
});
