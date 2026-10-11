import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { digitorn } from "@/server/adapters/digitorn";
import { DEMO_USER, devOnlyGuard } from "@/server/dev-tools";
import { handler, Rejection } from "@/server/http";

export const dynamic = "force-dynamic";

const decisionSchema = z.object({
  proposalId: z.string().min(1),
  decision: z.enum(["validate", "refuse"]),
});

export const POST = handler(async (request: NextRequest) => {
  const guard = devOnlyGuard();
  if (guard) return guard;
  const parsed = decisionSchema.safeParse(await request.json());
  if (!parsed.success) throw new Rejection("invalid_decision", "Décision invalide.");
  const proposal = await digitorn().decideAction({ ...parsed.data, userRef: DEMO_USER });
  return NextResponse.json({ proposal });
});
