import { z } from "zod";

/** Répétition d'une tâche : les mêmes règles que les RDV, plus « chaque jour » (US-110 RF3). */
export const repetitionSchema = z.object({
  frequency: z.enum(["daily", "weekly", "biweekly", "monthly_day", "monthly_weekday"]),
  weekdays: z.array(z.number().int().min(1).max(7)).max(7).optional(),
  end: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("date"), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    z.object({ kind: z.literal("count"), count: z.number().int().min(1).max(400) }),
    z.object({ kind: z.literal("never") }),
  ]),
});

export const scopeSchema = z.enum(["this", "following", "all"]);
