import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { BetaRunnableTool } from "@anthropic-ai/sdk/lib/tools/BetaRunnableTool";
import { z } from "zod";
import { Rejection } from "@/server/http";
import {
  availabilityLabel,
  areaLabel,
  buyerPreview,
  CONTACT_LABEL,
  GROUP_LABEL,
  ISSUE_TEXT,
  priceLabel,
  publicationIssues,
  SERVICE_CATEGORIES,
  type FieldGroup,
  type Provenance,
  type Storefront,
  type StorefrontFields,
} from "@/server/marketplace/model";
import { normalizePatch, type StorefrontPatch } from "@/server/marketplace/service";
import type { StorefrontStore } from "@/server/marketplace/store";

/**
 * Outils de l'agent vitrine : lecture et écriture de la vitrine du fournisseur, avec la provenance de chaque
 * groupe (dit par le fournisseur, proposé par l'agent, confirmé). Le modèle choisit l'outil ; l'outil vérifie
 * et borne. La publication n'est pas un outil : elle se fait sur l'écran de relecture (US-05).
 */

export interface ToolDeps {
  store: StorefrontStore;
  userId: string;
  /** Jour civil du fournisseur, AAAA-MM-JJ. */
  today: string;
}

export interface TurnCollector {
  calls: string[];
  /** Refus des contrôles objectifs (catégorie inconnue, tarif incohérent…), pour les évaluations. */
  problems: string[];
}

export function newCollector(): TurnCollector {
  return { calls: [], problems: [] };
}

const CATEGORY_CODES = SERVICE_CATEGORIES.map((c) => c.code) as [string, ...string[]];

const PROVENANCE_TEXT: Record<Provenance, string> = { stated: "dit par le fournisseur", proposed: "proposé par vous, à confirmer", confirmed: "confirmé" };

/** Champs tels que le modèle les manipule, en français ; convertis vers le modèle interne par `toPatch`. */
const champsSchema = z.object({
  nom_affiche: z.string().max(100).optional().describe("Nom de la vitrine tel qu'affiché aux membres"),
  categorie: z.enum(CATEGORY_CODES).optional().describe("Code de catégorie, parmi la liste fournie"),
  services: z.array(z.string().max(80)).max(20).optional().describe("Services précis, courts : « tresses », « twists »"),
  description: z.string().max(1000).optional().describe("Deux ou trois phrases, avec les mots du fournisseur"),
  code_postal: z.string().regex(/^\d{5}$/).optional(),
  ville: z.string().max(100).optional(),
  modes: z.array(z.enum(["chez_moi", "deplacement", "a_distance"])).max(3).optional().describe("Où le service a lieu : chez le fournisseur, en déplacement, à distance"),
  zones_deplacement: z.array(z.string().max(3)).max(20).optional().describe("Départements supplémentaires en déplacement, ex. [\"69\", \"01\"]"),
  precision_deplacement: z.string().max(200).optional().describe("Condition dite par le fournisseur : « le samedi seulement »"),
  disponibilite: z
    .object({
      mode: z.enum(["horaires", "a_convenir"]),
      texte: z.string().max(300).optional().describe("Horaires, si mode = horaires"),
    })
    .optional(),
  tarif: z
    .object({
      mode: z.enum(["devis", "a_partir_de", "fourchette"]),
      min: z.number().min(0).optional(),
      max: z.number().min(0).optional(),
    })
    .optional(),
  langues: z.array(z.string().max(40)).max(10).optional(),
  delai_reservation: z.string().max(200).optional(),
  qualifications: z.string().max(500).optional(),
  contact: z
    .object({
      methode: z.enum(["presentation_maaq", "whatsapp"]),
      valeur: z.string().max(200).describe("Email (présentation MAAQ) ou numéro WhatsApp, révélé seulement après accord"),
    })
    .optional(),
});

export type Champs = z.infer<typeof champsSchema>;

const MODE: Record<NonNullable<Champs["modes"]>[number], StorefrontFields["modes"][number]> = { chez_moi: "at_supplier", deplacement: "travels", a_distance: "remote" };

/** Conversion des champs français vers le modèle interne (clés absentes = non touchées). */
export function toPatch(champs: Champs): StorefrontPatch {
  const patch: StorefrontPatch = {};
  if (champs.nom_affiche !== undefined) patch.displayName = champs.nom_affiche;
  if (champs.categorie !== undefined) patch.categoryCode = champs.categorie;
  if (champs.services !== undefined) patch.services = champs.services;
  if (champs.description !== undefined) patch.description = champs.description;
  if (champs.code_postal !== undefined) patch.postcode = champs.code_postal;
  if (champs.ville !== undefined) patch.city = champs.ville;
  if (champs.modes !== undefined) patch.modes = champs.modes.map((m) => MODE[m]);
  if (champs.zones_deplacement !== undefined) patch.travelAreas = champs.zones_deplacement;
  if (champs.precision_deplacement !== undefined) patch.travelNote = champs.precision_deplacement;
  if (champs.disponibilite !== undefined) {
    patch.availabilityMode = champs.disponibilite.mode === "horaires" ? "hours" : "by_arrangement";
    patch.availabilityText = champs.disponibilite.texte ?? null;
  }
  if (champs.tarif !== undefined) {
    patch.priceMode = champs.tarif.mode === "devis" ? "quote" : champs.tarif.mode === "a_partir_de" ? "from" : "range";
    patch.priceMin = champs.tarif.min ?? null;
    patch.priceMax = champs.tarif.max ?? null;
  }
  if (champs.langues !== undefined) patch.languages = champs.langues;
  if (champs.delai_reservation !== undefined) patch.noticeText = champs.delai_reservation;
  if (champs.qualifications !== undefined) patch.qualificationsText = champs.qualifications;
  if (champs.contact !== undefined) {
    patch.contactMethod = champs.contact.methode === "whatsapp" ? "whatsapp" : "maaq_intro";
    patch.contactValue = champs.contact.valeur;
  }
  return patch;
}

const GROUPS = Object.keys(GROUP_LABEL) as [FieldGroup, ...FieldGroup[]];

/** Valeur lisible d'un groupe, ou null s'il est vide. */
export function groupValue(s: StorefrontFields, group: FieldGroup, categoryLabel: (code: string) => string): string | null {
  switch (group) {
    case "displayName":
      return s.displayName?.trim() || null;
    case "category":
      return s.categoryCode ? categoryLabel(s.categoryCode) : null;
    case "services":
      return s.services.length ? s.services.join(", ") : null;
    case "description":
      return s.description?.trim() || null;
    case "area":
      return s.postcode || s.modes.length ? `${s.postcode ?? "code postal ?"} · ${areaLabel(s)}` : null;
    case "availability":
      return s.availabilityMode ? availabilityLabel(s) : null;
    case "price":
      return s.priceMode ? priceLabel(s) : null;
    case "languages":
      return s.languages.length ? s.languages.join(", ") : null;
    case "notice":
      return s.noticeText?.trim() || null;
    case "qualifications":
      return s.qualificationsText?.trim() || null;
    case "contact":
      return s.contactMethod ? `${CONTACT_LABEL[s.contactMethod]} — ${s.contactValue ?? "valeur manquante"}` : null;
  }
}

/** État de la vitrine tel que rendu au modèle : chaque groupe avec sa valeur et sa provenance, puis ce qui bloque. */
export function describeStorefront(storefront: Storefront | null, categoryLabel: (code: string) => string): string {
  if (!storefront) return "Aucune vitrine : rien n'est encore enregistré.";
  const lines = [`Statut : ${storefront.status === "draft" ? "brouillon, non publiée" : storefront.status === "published" ? "publiée" : "publiée, suggestions en pause"}${storefront.pausedUntil ? ` (indisponible jusqu'au ${storefront.pausedUntil})` : ""}`];
  for (const group of GROUPS) {
    const value = groupValue(storefront, group, categoryLabel);
    const source = storefront.provenance[group]?.source;
    lines.push(`- ${GROUP_LABEL[group]} : ${value ?? "—"}${value && source ? ` [${PROVENANCE_TEXT[source]}]` : ""}`);
  }
  const issues = publicationIssues(storefront);
  lines.push(issues.length ? `Avant publication : ${issues.map((i) => `${GROUP_LABEL[i.group]} (${ISSUE_TEXT[i.reason]})`).join(" ; ")}.` : "Publiable : tout est renseigné et confirmé. La publication se fait par le bouton Publier de l'écran « Ma vitrine » (Catalogue › vitrine).");
  return lines.join("\n");
}

export function vitrineTools(deps: ToolDeps, collector: TurnCollector): BetaRunnableTool[] {
  const { store, userId } = deps;
  const note = (name: string) => collector.calls.push(name);
  let labels: Map<string, string> | null = null;
  const categoryLabel = async () => {
    labels ??= new Map((await store.listCategories()).map((c) => [c.code, c.label]));
    return (code: string) => labels!.get(code) ?? code;
  };
  const state = async () => describeStorefront(await store.get(userId), await categoryLabel());

  async function write(champs: Champs, source: Provenance): Promise<string> {
    let fields;
    try {
      fields = await normalizePatch(store, toPatch(champs));
    } catch (error) {
      if (error instanceof Rejection) {
        collector.problems.push(error.message);
        return `Refusé : ${error.message}`;
      }
      throw error;
    }
    const touched = Object.keys(fields);
    if (touched.length === 0) return "Rien à enregistrer.";
    const origin = Object.fromEntries(GROUPS.map((group) => [group, source]));
    await store.save(userId, fields, origin);
    return state();
  }

  const lire = betaZodTool({
    name: "lire_vitrine",
    description: "Lit la vitrine du fournisseur : chaque champ avec sa provenance (dit, proposé, confirmé), le statut et ce qui manque avant publication.",
    inputSchema: z.object({}),
    run: async () => {
      note("lire_vitrine");
      return state();
    },
  });

  const enregistrerDits = betaZodTool({
    name: "enregistrer_dits",
    description:
      "Enregistre des champs que le fournisseur a dits lui-même (extraits de ses mots, sans rien ajouter). Ne transmets que les champs mentionnés. Une valeur déjà confirmée qui change redevient « dite ».",
    inputSchema: z.object({ champs: champsSchema }),
    run: async ({ champs }) => {
      note("enregistrer_dits");
      return write(champs, "stated");
    },
  });

  const proposer = betaZodTool({
    name: "proposer_champs",
    description:
      "Enregistre des champs que tu proposes toi-même (catégorie déduite, description rédigée, « à convenir » par défaut). Ils restent marqués « proposés » jusqu'à confirmation du fournisseur et bloquent la publication.",
    inputSchema: z.object({ champs: champsSchema }),
    run: async ({ champs }) => {
      note("proposer_champs");
      return write(champs, "proposed");
    },
  });

  const confirmer = betaZodTool({
    name: "confirmer_champs",
    description:
      "Marque des groupes comme confirmés par le fournisseur. À n'appeler qu'après qu'il a explicitement approuvé la relecture de ces valeurs dans la conversation (« oui, c'est ça »). Groupes : " +
      GROUPS.join(", "),
    inputSchema: z.object({ groupes: z.array(z.enum(GROUPS)).min(1) }),
    run: async ({ groupes }) => {
      note("confirmer_champs");
      try {
        await store.confirm(userId, groupes);
      } catch (error) {
        collector.problems.push((error as Error).message);
        return `Refusé : ${(error as Error).message}`;
      }
      return state();
    },
  });

  const apercu = betaZodTool({
    name: "apercu_acheteur",
    description: "Ce qu'un membre verrait de la vitrine si elle lui était suggérée : sans adresse ni contact.",
    inputSchema: z.object({}),
    run: async () => {
      note("apercu_acheteur");
      const storefront = await store.get(userId);
      if (!storefront) return "Aucune vitrine.";
      return JSON.stringify(buyerPreview(storefront, await store.listCategories()));
    },
  });

  const pause = betaZodTool({
    name: "mettre_en_pause",
    description: "Suspend les suggestions d'une vitrine publiée, sans la supprimer. « reprendre » les réactive.",
    inputSchema: z.object({ reprendre: z.boolean().optional().describe("true pour réactiver les suggestions") }),
    run: async ({ reprendre }) => {
      note("mettre_en_pause");
      const storefront = await store.get(userId);
      if (!storefront || storefront.status === "draft") return "Refusé : la vitrine n'est pas publiée, il n'y a rien à mettre en pause.";
      await store.setState(userId, { status: reprendre ? "published" : "paused" });
      return state();
    },
  });

  const indisponible = betaZodTool({
    name: "indisponible_jusquau",
    description: "Indisponibilité temporaire : la vitrine sort des suggestions jusqu'à cette date incluse (AAAA-MM-JJ), sans changer les horaires. Date nulle pour annuler.",
    inputSchema: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable() }),
    run: async ({ date }) => {
      note("indisponible_jusquau");
      const storefront = await store.get(userId);
      if (!storefront) return "Refusé : aucune vitrine.";
      if (date !== null && date < deps.today) return `Refusé : le ${date} est déjà passé (aujourd'hui ${deps.today}).`;
      await store.setState(userId, { pausedUntil: date });
      return state();
    },
  });

  return [lire, enregistrerDits, proposer, confirmer, apercu, pause, indisponible];
}
