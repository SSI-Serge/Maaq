import { z } from "zod";
import type { CalendarEvent, CalendarSource } from "@/server/adapters/calendar/types";
import type { LlmClient } from "@/server/agents/types";
import { frenchDate } from "@/server/gifts/model";
import type { BuyerProfile, MatchStore } from "./match-store";
import { SERVICE_CATEGORIES } from "./model";
import { AGENDA_LOOKAHEAD_DAYS, AGENDA_MIN_CONFIDENCE } from "./rules";

/**
 * Suggestions déclenchées par l'agenda (phase 2b). Pour chaque profil qui a consenti à la lecture de son agenda
 * (et aux suggestions), les événements à venir jamais examinés sont classés en un appel structuré : besoin de
 * service ou non. Un besoin devient une demande « proposed » et une question dans le tchat de coup_de_main ;
 * la recherche n'a lieu que sur le oui de la personne. Le titre n'est ni conservé ni transmis à un annuaire.
 */

export interface AgendaDeps {
  store: MatchStore;
  calendar: CalendarSource;
  llm: Pick<LlmClient, "complete">;
  now: Date;
  /** Jour civil, AAAA-MM-JJ. */
  today: string;
  postInApp: (userId: string, text: string) => Promise<void>;
  lookaheadDays?: number;
}

export interface AgendaScanResult {
  profiles: number;
  /** Événements examinés pour la première fois. */
  events: number;
  /** Demandes proposées (question posée dans le tchat). */
  proposed: number;
  failed: number;
}

const CLASSIFY_SYSTEM = `Tu lis des titres d'événements d'agenda d'un membre de MAAQ pour repérer ceux qui correspondent à un service qu'un autre membre pourrait rendre (coiffure, ménage, cours, bricolage, traiteur, garde d'enfants, photo…). La plupart des événements n'en sont pas (réunion, anniversaire, médecin, sport, vacances) : pour ceux-là, category = "none".

Pour chaque événement rends :
- id : recopié tel quel.
- category : le code de catégorie si l'événement est un service à faire faire, sinon "none". Un rendez-vous déjà pris chez un professionnel (« coiffeur 15h ») compte comme un besoin de ce service : la personne pourrait préférer un membre près de chez elle.
- confidence : entre 0 et 1.
- need : une courte phrase en français qui décrit le besoin avec des mots neutres, sans recopier de nom propre ni de détail personnel (ex. « une coupe de cheveux pour les enfants »). Vide si category = "none".

Catégories (code : libellé) : ${SERVICE_CATEGORIES.filter((c) => c.code !== "autre")
  .map((c) => `${c.code} : ${c.label}`)
  .join(" ; ")}.`;

const classificationSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      category: z.string().describe("Code de catégorie ou \"none\""),
      confidence: z.number().describe("Entre 0 et 1"),
      need: z.string(),
    }),
  ),
});

export type Classification = z.infer<typeof classificationSchema>["items"][number];

export const CATEGORY_CODES = new Set(SERVICE_CATEGORIES.map((c) => c.code));

export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Question posée dans le tchat : l'agent demande avant de chercher, et ne nomme personne. */
export function agendaQuestion(firstName: string, event: CalendarEvent, need: string): string {
  return `Bonjour ${firstName}, je vois que vous avez ajouté « ${event.title} » le ${frenchDate(event.date)}${event.time ? ` à ${event.time}` : ""} dans votre agenda. Voulez-vous que je cherche quelqu'un près de chez vous pour ${need} ? Répondez oui et je regarde parmi les vitrines des membres ; sinon dites-le moi et je n'en parle plus.`;
}

export async function classifyEvents(llm: Pick<LlmClient, "complete">, events: CalendarEvent[]): Promise<Map<string, Classification>> {
  if (events.length === 0) return new Map();
  const output = await llm.complete({
    system: CLASSIFY_SYSTEM,
    messages: [{ role: "user", content: JSON.stringify(events.map((e) => ({ id: e.id, titre: e.title, date: e.date })))}],
    schema: classificationSchema,
  });
  return new Map(output.items.map((item) => [item.id, item]));
}

export async function runAgendaScan(deps: AgendaDeps): Promise<AgendaScanResult> {
  const result: AgendaScanResult = { profiles: 0, events: 0, proposed: 0, failed: 0 };
  const to = addDays(deps.today, deps.lookaheadDays ?? AGENDA_LOOKAHEAD_DAYS);
  for (const profile of await deps.store.listAgendaProfiles()) {
    result.profiles++;
    try {
      await scanProfile(deps, profile, to, result);
    } catch (error) {
      console.error(`[marketplace] agenda du profil ${profile.userId} :`, error);
      result.failed++;
    }
  }
  return result;
}

async function scanProfile(deps: AgendaDeps, profile: BuyerProfile, to: string, result: AgendaScanResult): Promise<void> {
  const events = await deps.calendar.listUpcoming(profile.userId, deps.today, to);
  const unseen = new Set(await deps.store.unseenAgendaKeys(profile.userId, events.map((e) => e.id)));
  const fresh = events.filter((e) => unseen.has(e.id));
  if (fresh.length === 0) return;
  result.events += fresh.length;

  const classified = await classifyEvents(deps.llm, fresh);
  // Examiné une fois pour toutes, quel que soit le verdict : un titre ne repasse jamais par le modèle.
  await deps.store.markAgendaSeen(profile.userId, fresh.map((e) => e.id));

  for (const event of fresh) {
    const verdict = classified.get(event.id);
    if (!verdict || verdict.category === "none" || !CATEGORY_CODES.has(verdict.category) || verdict.confidence < AGENDA_MIN_CONFIDENCE || !verdict.need.trim()) continue;
    const need = verdict.need.trim();
    await deps.store.createRequest(profile.userId, {
      text: need,
      categoryCode: verdict.category,
      postcode: profile.postcode,
      timingText: frenchDate(event.date),
      source: "agenda",
      agendaEventKey: event.id,
      agendaEventDate: event.date,
      status: "proposed",
    });
    await deps.postInApp(profile.userId, agendaQuestion(profile.firstName, event, need));
    result.proposed++;
  }
}
