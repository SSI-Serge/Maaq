import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { z } from "zod";
import { frenchDate, KINDS_LABEL, matchPeople, normalizeName, upcomingOccasions, type Occasion, type Person } from "@/server/gifts/model";
import type { PrefsStore } from "@/server/gifts/prefs";
import { NotFound, VersionConflict, type GiftStore, type IdeaInput } from "@/server/gifts/store";
import type { BrainProposal } from "./types";

/**
 * Outils de kdo_help : lecture et écriture des proches, occasions et idées. Le modèle choisit l'outil ;
 * l'outil vérifie et borne. Toute suppression passe par une carte de validation (US-39), jamais par le texte.
 */

export const MAX_IDEAS = 3;
export const OCCASION_WINDOW_DAYS = 60;

export interface ToolDeps {
  store: GiftStore;
  prefs: PrefsStore | null;
  userId: string;
  /** Jour civil de la personne, AAAA-MM-JJ. */
  today: string;
  timezone: string;
  /** Budget maximal lu dans la demande, s'il y en a un. */
  requestBudget: number | null;
}

/** Ce que les outils ont produit pendant un tour : idées à afficher, actions à valider, contrôles. */
export interface TurnCollector {
  ideas: IdeaInput[];
  proposals: BrainProposal[];
  problems: string[];
  calls: string[];
}

export function newCollector(): TurnCollector {
  return { ideas: [], proposals: [], problems: [], calls: [] };
}

const birthdaySchema = z.object({
  jour: z.number().int().min(1).max(31),
  mois: z.number().int().min(1).max(12),
  annee: z.number().int().min(1900).max(2100).optional().describe("Année de naissance si connue"),
});

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function describePerson(p: Person) {
  const birthday = p.birthDay && p.birthMonth ? `${pad(p.birthDay)}/${pad(p.birthMonth)}${p.birthYear ? `/${p.birthYear}` : ""}` : null;
  return {
    id: p.id,
    nom: p.name,
    lien: p.relationship,
    anniversaire: birthday,
    budget: p.budgetAmount,
    interets: p.details.interests ?? [],
    momentsDeVie: p.details.lifeEvents ?? [],
    nAimePas: p.details.dislikes ?? [],
    notes: p.details.notes ?? null,
    version: p.version,
  };
}

function describeOccasion(o: Occasion) {
  return {
    cle: o.key,
    titre: o.title,
    type: KINDS_LABEL[o.kind] ?? o.kind,
    date: frenchDate(o.date),
    dansJours: o.daysRemaining,
    age: o.age,
    proche: o.personName,
    procheId: o.personId,
    budget: o.budgetAmount,
    reglee: o.sorted,
    reporteeJusquAu: o.snoozedUntil ? frenchDate(o.snoozedUntil) : null,
  };
}

function failure(error: unknown): string {
  if (error instanceof NotFound || error instanceof VersionConflict) return `Échec : ${error.message}`;
  throw error;
}

async function occasions(deps: ToolDeps, windowDays: number): Promise<Occasion[]> {
  const [people, events, states] = await Promise.all([deps.store.listPeople(deps.userId), deps.store.listEvents(deps.userId), deps.store.listStates(deps.userId)]);
  return upcomingOccasions({ people, events, states }, deps.today, windowDays);
}

export function giftTools(deps: ToolDeps, collector: TurnCollector): BetaRunnableTool[] {
  const { store, userId } = deps;
  const note = (name: string) => collector.calls.push(name);

  const listerProches = betaZodTool({
    name: "lister_proches",
    description: "Liste les proches enregistrés (nom, lien, anniversaire, budget, goûts).",
    inputSchema: z.object({}),
    run: async () => {
      note("lister_proches");
      const people = await store.listPeople(userId);
      return people.length ? JSON.stringify(people.map(describePerson)) : "Aucun proche enregistré.";
    },
  });

  const trouverProche = betaZodTool({
    name: "trouver_proche",
    description: "Retrouve un proche par son nom (ou une partie). Plusieurs résultats : demander lequel avant toute écriture.",
    inputSchema: z.object({ nom: z.string().min(1) }),
    run: async ({ nom }) => {
      note("trouver_proche");
      const matches = matchPeople(await store.listPeople(userId), nom);
      if (matches.length === 0) return `Aucun proche ne correspond à « ${nom} ».`;
      return JSON.stringify(matches.map(describePerson));
    },
  });

  const creerProche = betaZodTool({
    name: "creer_proche",
    description: "Enregistre un nouveau proche. Si un proche du même nom existe, l'outil refuse sauf homonyme=true.",
    inputSchema: z.object({
      nom: z.string().min(1).max(100),
      lien: z.string().max(100).optional().describe("Lien avec la personne : frère, fille, collègue, belle-mère…"),
      anniversaire: birthdaySchema.optional(),
      budget: z.number().min(0).optional().describe("Budget cadeau habituel en euros"),
      interets: z.array(z.string()).optional(),
      moments_de_vie: z.array(z.string()).optional().describe("Événements de vie récents : premier enfant, déménagement…"),
      notes: z.string().max(1000).optional(),
      homonyme: z.boolean().optional().describe("true pour créer malgré un proche du même nom"),
    }),
    run: async (input) => {
      note("creer_proche");
      const existing = (await store.listPeople(userId)).filter((p) => normalizeName(p.name) === normalizeName(input.nom));
      if (existing.length && !input.homonyme) {
        return `Un proche nommé « ${existing[0].name} » existe déjà (id ${existing[0].id}). Modifiez-le avec modifier_proche, ou confirmez un homonyme avec homonyme=true.`;
      }
      const person = await store.createPerson(userId, {
        name: input.nom,
        relationship: input.lien ?? null,
        birthDay: input.anniversaire?.jour ?? null,
        birthMonth: input.anniversaire?.mois ?? null,
        birthYear: input.anniversaire?.annee ?? null,
        budgetAmount: input.budget ?? null,
        details: { interests: input.interets ?? [], lifeEvents: input.moments_de_vie ?? [], ...(input.notes ? { notes: input.notes } : {}) },
      });
      return `Enregistré : ${JSON.stringify(describePerson(person))}`;
    },
  });

  const modifierProche = betaZodTool({
    name: "modifier_proche",
    description: "Modifie un proche existant (champs fournis seulement). Les listes fournies s'ajoutent aux existantes.",
    inputSchema: z.object({
      id: z.string().uuid(),
      nom: z.string().min(1).max(100).optional(),
      lien: z.string().max(100).nullable().optional(),
      anniversaire: birthdaySchema.nullable().optional(),
      budget: z.number().min(0).nullable().optional(),
      interets_ajoutes: z.array(z.string()).optional(),
      interets_retires: z.array(z.string()).optional(),
      moments_de_vie_ajoutes: z.array(z.string()).optional(),
      n_aime_pas_ajoutes: z.array(z.string()).optional(),
      notes: z.string().max(1000).nullable().optional(),
      version: z.number().int().optional().describe("Version lue, pour refuser une modification concurrente"),
    }),
    run: async (input) => {
      note("modifier_proche");
      try {
        const current = (await store.listPeople(userId)).find((p) => p.id === input.id);
        if (!current) throw new NotFound("Ce proche");
        const merge = (base: string[] | undefined, add?: string[], remove?: string[]) =>
          [...(base ?? []), ...(add ?? [])].filter((v, i, arr) => arr.indexOf(v) === i && !(remove ?? []).map(normalizeName).includes(normalizeName(v)));
        const person = await store.updatePerson(
          userId,
          input.id,
          {
            ...(input.nom !== undefined ? { name: input.nom } : {}),
            ...(input.lien !== undefined ? { relationship: input.lien } : {}),
            ...(input.anniversaire !== undefined
              ? { birthDay: input.anniversaire?.jour ?? null, birthMonth: input.anniversaire?.mois ?? null, birthYear: input.anniversaire?.annee ?? null }
              : {}),
            ...(input.budget !== undefined ? { budgetAmount: input.budget } : {}),
            details: {
              interests: merge(current.details.interests, input.interets_ajoutes, input.interets_retires),
              lifeEvents: merge(current.details.lifeEvents, input.moments_de_vie_ajoutes),
              dislikes: merge(current.details.dislikes, input.n_aime_pas_ajoutes),
              ...(input.notes !== undefined ? { notes: input.notes ?? undefined } : {}),
            },
          },
          input.version,
        );
        return `Modifié : ${JSON.stringify(describePerson(person))}`;
      } catch (error) {
        return failure(error);
      }
    },
  });

  const supprimerProche = betaZodTool({
    name: "supprimer_proche",
    description: "Demande la suppression d'un proche et de ses occasions. Rien n'est supprimé avant que la personne valide la carte affichée ; annulable 30 jours.",
    inputSchema: z.object({ id: z.string().uuid() }),
    run: async ({ id }) => {
      note("supprimer_proche");
      const person = (await store.listPeople(userId)).find((p) => p.id === id);
      if (!person) return "Échec : ce proche est introuvable.";
      const linked = (await store.listEvents(userId)).filter((e) => e.personId === id).length;
      collector.proposals.push({
        summary: `Supprimer ${person.name}${linked ? ` et ${linked} occasion(s)` : ""} (annulable pendant 30 jours)`,
        execute: () => store.deletePerson(userId, id),
      });
      return `Confirmation demandée à la personne pour supprimer ${person.name}. Ne rien supprimer tant qu'elle n'a pas validé ; dites-lui simplement de valider ou refuser la carte.`;
    },
  });

  const listerOccasions = betaZodTool({
    name: "lister_occasions",
    description: "Occasions à venir (anniversaires des proches et occasions enregistrées), triées par date.",
    inputSchema: z.object({ jours: z.number().int().min(1).max(366).optional().describe("Fenêtre en jours, 60 par défaut") }),
    run: async ({ jours }) => {
      note("lister_occasions");
      const found = await occasions(deps, jours ?? OCCASION_WINDOW_DAYS);
      return found.length ? JSON.stringify(found.map(describeOccasion)) : `Aucune occasion dans les ${jours ?? OCCASION_WINDOW_DAYS} prochains jours.`;
    },
  });

  const creerOccasion = betaZodTool({
    name: "creer_occasion",
    description: "Enregistre une occasion autre que l'anniversaire d'un proche (Noël, fête, anniversaire de mariage…). Sans année : chaque année.",
    inputSchema: z.object({
      titre: z.string().min(1).max(150),
      type: z.enum(["christmas", "anniversary", "namesday", "other"]),
      jour: z.number().int().min(1).max(31),
      mois: z.number().int().min(1).max(12),
      annee: z.number().int().min(1900).max(2100).optional().describe("Occasion unique à cette date"),
      proche_id: z.string().uuid().optional(),
      budget: z.number().min(0).optional(),
    }),
    run: async (input) => {
      note("creer_occasion");
      const event = await store.createEvent(userId, { title: input.titre, kind: input.type, eventDay: input.jour, eventMonth: input.mois, eventYear: input.annee ?? null, personId: input.proche_id ?? null, budgetAmount: input.budget ?? null });
      return `Enregistré : ${event.title} le ${pad(event.eventDay)}/${pad(event.eventMonth)}${event.eventYear ? `/${event.eventYear}` : " (chaque année)"} (id ${event.id}).`;
    },
  });

  const modifierOccasion = betaZodTool({
    name: "modifier_occasion",
    description: "Modifie une occasion enregistrée (pas l'anniversaire d'un proche : utiliser modifier_proche).",
    inputSchema: z.object({
      id: z.string().uuid(),
      titre: z.string().min(1).max(150).optional(),
      jour: z.number().int().min(1).max(31).optional(),
      mois: z.number().int().min(1).max(12).optional(),
      annee: z.number().int().min(1900).max(2100).nullable().optional(),
      budget: z.number().min(0).nullable().optional(),
      version: z.number().int().optional(),
    }),
    run: async (input) => {
      note("modifier_occasion");
      try {
        const event = await store.updateEvent(
          userId,
          input.id,
          {
            ...(input.titre !== undefined ? { title: input.titre } : {}),
            ...(input.jour !== undefined ? { eventDay: input.jour } : {}),
            ...(input.mois !== undefined ? { eventMonth: input.mois } : {}),
            ...(input.annee !== undefined ? { eventYear: input.annee } : {}),
            ...(input.budget !== undefined ? { budgetAmount: input.budget } : {}),
          },
          input.version,
        );
        return `Modifié : ${event.title} le ${pad(event.eventDay)}/${pad(event.eventMonth)}${event.eventYear ? `/${event.eventYear}` : ""}.`;
      } catch (error) {
        return failure(error);
      }
    },
  });

  const supprimerOccasion = betaZodTool({
    name: "supprimer_occasion",
    description: "Demande la suppression d'une occasion enregistrée. Rien n'est supprimé avant validation de la carte par la personne.",
    inputSchema: z.object({ id: z.string().uuid() }),
    run: async ({ id }) => {
      note("supprimer_occasion");
      const event = (await store.listEvents(userId)).find((e) => e.id === id);
      if (!event) return "Échec : cette occasion est introuvable.";
      collector.proposals.push({ summary: `Supprimer l'occasion « ${event.title} » (annulable pendant 30 jours)`, execute: () => store.deleteEvent(userId, id) });
      return `Confirmation demandée à la personne pour supprimer « ${event.title} ». Ne rien supprimer tant qu'elle n'a pas validé.`;
    },
  });

  const proposerIdees = betaZodTool({
    name: "proposer_idees",
    description: `Enregistre les idées de cadeau à afficher (au plus ${MAX_IDEAS}, de la meilleure à la moins bonne). L'application les affiche à part : après l'appel, n'écrire qu'une phrase d'introduction. Les idées hors budget ou déjà proposées sont retirées ; l'outil dit lesquelles.`,
    inputSchema: z.object({
      proche_id: z.string().uuid().optional(),
      occasion: z.string().optional().describe("Clé de l'occasion (lister_occasions), si connue"),
      idees: z.array(
        z.object({
          titre: z.string().min(1).max(200),
          pourquoi: z.string().min(1).max(500),
          prix_min: z.number().min(0),
          prix_max: z.number().min(0),
        }),
      ),
    }),
    run: async (input) => {
      note("proposer_idees");
      const person = input.proche_id ? (await store.listPeople(userId)).find((p) => p.id === input.proche_id) : undefined;
      const budgetMax = deps.requestBudget ?? person?.budgetAmount ?? null;
      const previous = new Set((await store.listIdeas(userId, { personId: person?.id ?? null, limit: 60 })).map((i) => normalizeName(i.title)));
      const kept: IdeaInput[] = [];
      const dropped: string[] = [];
      for (const idea of input.idees) {
        if (kept.length >= MAX_IDEAS) {
          dropped.push(`${idea.titre} (au-delà de ${MAX_IDEAS} idées)`);
          continue;
        }
        if (idea.prix_max < idea.prix_min) {
          dropped.push(`${idea.titre} (prix incohérent)`);
          continue;
        }
        if (budgetMax !== null && idea.prix_min > budgetMax) {
          dropped.push(`${idea.titre} (hors budget de ${budgetMax} €)`);
          continue;
        }
        if (previous.has(normalizeName(idea.titre))) {
          dropped.push(`${idea.titre} (déjà proposée)`);
          continue;
        }
        previous.add(normalizeName(idea.titre));
        kept.push({ personId: person?.id ?? null, occasionKey: input.occasion ?? null, title: idea.titre, why: idea.pourquoi, priceMin: idea.prix_min, priceMax: idea.prix_max });
      }
      collector.problems.push(...dropped);
      collector.ideas = kept;
      await store.addIdeas(userId, kept);
      return `${kept.length} idée(s) affichée(s)${dropped.length ? ` ; retirées : ${dropped.join(", ")}` : ""}.`;
    },
  });

  const listerIdees = betaZodTool({
    name: "lister_idees",
    description: "Idées déjà proposées, gardées, achetées ou écartées, les plus récentes d'abord.",
    inputSchema: z.object({ proche_id: z.string().uuid().optional() }),
    run: async ({ proche_id }) => {
      note("lister_idees");
      const ideas = await store.listIdeas(userId, { ...(proche_id ? { personId: proche_id } : {}), limit: 20 });
      return ideas.length ? JSON.stringify(ideas.map((i) => ({ id: i.id, titre: i.title, statut: i.status, prix: [i.priceMin, i.priceMax], procheId: i.personId }))) : "Aucune idée enregistrée.";
    },
  });

  const marquerIdee = betaZodTool({
    name: "marquer_idee",
    description: "Marque une idée comme gardée, achetée ou écartée. Une idée achetée règle l'occasion liée.",
    inputSchema: z.object({ id: z.string().uuid(), statut: z.enum(["saved", "purchased", "dismissed"]) }),
    run: async ({ id, statut }) => {
      note("marquer_idee");
      const idea = await store.setIdeaStatus(userId, id, statut);
      if (!idea) return "Échec : idée introuvable.";
      if (statut === "purchased" && idea.occasionKey) await store.setState(userId, idea.occasionKey, { sortedAt: new Date().toISOString() });
      return `Idée « ${idea.title} » : ${statut === "saved" ? "gardée" : statut === "purchased" ? "achetée" : "écartée"}.`;
    },
  });

  const reglerOccasion = betaZodTool({
    name: "regler_occasion",
    description: "Marque une occasion comme réglée (cadeau trouvé) ou à nouveau ouverte : plus de rappel quand elle est réglée.",
    inputSchema: z.object({ occasion: z.string().describe("Clé de l'occasion"), reglee: z.boolean() }),
    run: async ({ occasion, reglee }) => {
      note("regler_occasion");
      await store.setState(userId, occasion, { sortedAt: reglee ? new Date().toISOString() : null });
      return reglee ? "Occasion réglée : plus de rappel." : "Occasion rouverte.";
    },
  });

  const reporterOccasion = betaZodTool({
    name: "reporter_occasion",
    description: "Reporte les rappels d'une occasion jusqu'à une date (AAAA-MM-JJ).",
    inputSchema: z.object({ occasion: z.string(), jusqu_au: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
    run: async ({ occasion, jusqu_au }) => {
      note("reporter_occasion");
      await store.setState(userId, occasion, { snoozedUntil: jusqu_au });
      return `Rappels reportés jusqu'au ${frenchDate(jusqu_au)}.`;
    },
  });

  const annulerSuppression = betaZodTool({
    name: "annuler_derniere_suppression",
    description: "Restaure le dernier proche ou la dernière occasion supprimés (dans les 30 jours).",
    inputSchema: z.object({}),
    run: async () => {
      note("annuler_derniere_suppression");
      const people = (await store.listPeople(userId, { includeDeleted: true })).filter((p) => p.deletedAt);
      const events = (await store.listEvents(userId, { includeDeleted: true })).filter((e) => e.deletedAt);
      const lastPerson = people.sort((a, b) => b.deletedAt!.localeCompare(a.deletedAt!))[0];
      const lastEvent = events.sort((a, b) => b.deletedAt!.localeCompare(a.deletedAt!))[0];
      if (!lastPerson && !lastEvent) return "Rien à restaurer.";
      if (lastPerson && (!lastEvent || lastPerson.deletedAt! >= lastEvent.deletedAt!)) {
        const restored = await store.restorePerson(userId, lastPerson.id);
        return restored ? `Restauré : ${restored.name}.` : "Rien à restaurer.";
      }
      const restored = await store.restoreEvent(userId, lastEvent!.id);
      return restored ? `Restauré : ${restored.title}.` : "Rien à restaurer.";
    },
  });

  const reglerRappels = betaZodTool({
    name: "regler_rappels",
    description: "Règle les rappels : canal (app, whatsapp, both) et heures calmes (HH:MM) pendant lesquelles rien n'est envoyé.",
    inputSchema: z.object({
      canal: z.enum(["app", "whatsapp", "both"]).optional(),
      heures_calmes_debut: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      heures_calmes_fin: z.string().regex(/^\d{2}:\d{2}$/).optional(),
    }),
    run: async (input) => {
      note("regler_rappels");
      if (!deps.prefs) return "Les réglages de rappel ne sont pas disponibles ici.";
      const prefs = await deps.prefs.set(userId, {
        ...(input.canal ? { reminderChannel: input.canal } : {}),
        ...(input.heures_calmes_debut ? { quietHoursStart: input.heures_calmes_debut } : {}),
        ...(input.heures_calmes_fin ? { quietHoursEnd: input.heures_calmes_fin } : {}),
      });
      return `Rappels : canal ${prefs.reminderChannel}, heures calmes ${prefs.quietHoursStart}–${prefs.quietHoursEnd}, fuseau ${prefs.timezone}.`;
    },
  });

  return [
    listerProches,
    trouverProche,
    creerProche,
    modifierProche,
    supprimerProche,
    listerOccasions,
    creerOccasion,
    modifierOccasion,
    supprimerOccasion,
    proposerIdees,
    listerIdees,
    marquerIdee,
    reglerOccasion,
    reporterOccasion,
    annulerSuppression,
    reglerRappels,
  ];
}
