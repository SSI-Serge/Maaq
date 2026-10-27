import { z } from "zod";

/** Une tâche de la liste « À préparer » : échéance relative au RDV (`daysBefore`) ou date choisie (« Autre date… »). */
export const eventTaskSchema = z.object({
  version: z.number().int().min(1).optional(),
  title: z.string().max(300),
  note: z.string().max(5000).nullable().optional(),
  daysBefore: z.number().int().min(0).max(60).nullable().optional(),
  due: z.string().max(10).nullable().optional(),
  dueTime: z.string().max(5).nullable().optional(),
  assigneeId: z.uuid().nullable().optional(),
});
