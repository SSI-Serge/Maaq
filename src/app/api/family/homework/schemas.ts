import { z } from "zod";

const days = z.array(z.number().int()).max(7);

/** Un élément d'une semaine de devoirs : exercices d'un manuel, activité du catalogue ou activité du parent (US-119 RF2). */
export const itemSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("exercises"), textbook: z.string().max(40), numbers: z.array(z.number().int()).max(40), days }),
  z.object({ kind: z.literal("activity"), activityId: z.string().regex(/^\d+$/).max(20), days }),
  z.object({ kind: z.literal("custom"), title: z.string().max(300), days }),
]);
