import { NextResponse } from "next/server";
import { sql } from "kysely";
import { db } from "@/server/db/client";
import { handler } from "@/server/http";

export const dynamic = "force-dynamic";

/** État du service, interrogé au démarrage de l'application (maquette Démarrage). */
export const GET = handler(async () => {
  const { rows } = await sql<{ migrations: number }>`SELECT count(*)::int AS migrations FROM schema_migrations`.execute(db());
  return NextResponse.json({ status: "ok", migrations: rows[0]?.migrations ?? 0 });
});
