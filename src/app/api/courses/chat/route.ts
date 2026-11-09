import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProfile } from "@/server/auth/http";
import { listCourseMessages, MAX_COURSE_TEXT, sendCourseMessage } from "@/server/courses/chat/service";
import { handler, parseBody, Rejection } from "@/server/http";
import { describeError } from "@/server/safe-log";

export const dynamic = "force-dynamic";
export const maxDuration = 150;

/** Les messages récents du tchat de l'agent Courses et repas. */
export const GET = handler(async () => {
  const { session, ctx } = await requireProfile({ passive: true });
  return NextResponse.json({ messages: await listCourseMessages(ctx, session) });
});

const schema = z.object({ requestId: z.string().uuid(), text: z.string().max(MAX_COURSE_TEXT + 100), week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });

/**
 * Envoie un message à l'agent ; un renvoi avec le même identifiant de demande ne refait rien. Avec `Accept: application/x-ndjson`, la réponse est un flux de lignes JSON : le menu
 * s'affiche au fil de l'eau (`progress`), puis la réponse (`done`) ou l'erreur (`error`) termine le flux.
 */
export const POST = handler(async (request: Request) => {
  const { session, ctx } = await requireProfile();
  const body = await parseBody(request, schema);
  if (!(request.headers.get("accept") ?? "").includes("application/x-ndjson")) return NextResponse.json(await sendCourseMessage(ctx, session, body));

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (line: unknown) => controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
      try {
        const result = await sendCourseMessage(ctx, session, body, { onProgress: (progress) => write({ type: "progress", progress }) });
        write({ type: "done", result });
      } catch (error) {
        if (error instanceof Rejection) write({ type: "error", error: { code: error.code, message: error.message, status: error.status, details: error.details } });
        else {
          console.error(`[api] erreur : ${describeError(error)}`);
          write({ type: "error", error: { code: "server_error", message: "Erreur interne", status: 500 } });
        }
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
});
