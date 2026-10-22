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
import { describeStatus, HandoffRefused, respondToIntroduction, type HandoffDeps } from "@/server/marketplace/handoff";
import type { Introduction, MatchStore } from "@/server/marketplace/match-store";
import { normalizePatch, type StorefrontPatch } from "@/server/marketplace/service";
import type { StorefrontStore } from "@/server/marketplace/store";
import type { BrainProposal } from "./types";

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
  /** Mises en relation reçues (phase 3) ; absents dans les tests sans transfert. */
  matches?: MatchStore | null;
  handoff?: HandoffDeps | null;
}

export interface TurnCollector {
  calls: string[];
  /** Refus des contrôles objectifs (catégorie inconnue, tarif incohérent…), pour les évaluations. */
  problems: string[];
  /** Réponses à une mise en relation, à valider par carte : elles libèrent un contact. */
  proposals: BrainProposal[];
}

export function newCollector(): TurnCollector {
  return { calls: [], problems: [], proposals: [] };
}

export const INTRO_STATUS_TEXT: Record<Introduction["status"], string> = {
  requested: "en attente de votre réponse",
  question: "vous avez posé une question, en attente de la réponse du membre",
  accepted: "acceptée",
  declined: "refusée par vous",
  connected: "acceptée, contacts échangés",
  expired: "expirée sans réponse",
};

/** Mises en relation d'une vitrine, telles que le modèle les lit. */
export function describeIntroductions(introductions: Introduction[]): string {
  if (introductions.length === 0) return "Aucune mise en relation reçue.";
  return introductions
    .map((i) => `- [mise en relation ${i.id}] demandée le ${i.requestedAt.slice(0, 10)}, ${INTRO_STATUS_TEXT[i.status]}${i.supplierMessage ? ` (votre mot : « ${i.supplierMessage} »)` : ""}\n  Texte du membre : « ${i.sharedText.replace(/\n/g, " / ")} »`)
    .join("\n");
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
  const lines = [`Statut : ${storefront.status === "draft" ? "brouillon, non publiée" : storefront.status === "published" ? "publiée" : "publiée, suggestions en pause"}${storefront.pausedUntil ? ` (indisponible jusqu'au ${storefront.pausedUntil})` : ""}${storefront.adminPaused ? ` — SUSPENDUE PAR MAAQ${storefront.adminPauseReason ? ` : ${storefront.adminPauseReason}` : ""} (hors suggestions jusqu'à la levée par l'administrateur ; invitez le fournisseur à corriger sa vitrine ou à contacter le support)` : ""}`];
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

  const listerIntroductions = betaZodTool({
    name: "lister_introductions",
    description: "Mises en relation reçues par la vitrine : qui demande quoi (texte approuvé par le membre), et leur statut.",
    inputSchema: z.object({}),
    run: async () => {
      note("lister_introductions");
      if (!deps.matches) return "Les mises en relation ne sont pas disponibles ici.";
      const storefront = await store.get(userId);
      if (!storefront) return "Aucune vitrine, donc aucune mise en relation.";
      return describeIntroductions(await deps.matches.listIntroductionsForStorefront(storefront.id));
    },
  });

  const repondreIntroduction = betaZodTool({
    name: "repondre_introduction",
    description:
      "Répond à une mise en relation : accepter (MAAQ transmet au membre le contact de la vitrine et vous transmet le sien), refuser, ou poser une question (message obligatoire, transmis tel quel). Rien ne part avant que le fournisseur valide la carte affichée : dites-le, sans considérer la réponse envoyée.",
    inputSchema: z.object({
      introduction_id: z.string().uuid(),
      reponse: z.enum(["accepter", "refuser", "question"]),
      message: z.string().max(500).optional().describe("Question ou mot d'explication, avec les mots du fournisseur"),
    }),
    run: async ({ introduction_id, reponse, message }) => {
      note("repondre_introduction");
      if (!deps.matches || !deps.handoff) return "Refusé : les mises en relation ne sont pas disponibles ici.";
      const storefront = await store.get(userId);
      const introduction = await deps.matches.getIntroduction(introduction_id);
      if (!storefront || !introduction || introduction.storefrontId !== storefront.id) return "Refusé : cette mise en relation est introuvable.";
      if (introduction.status !== "requested" && introduction.status !== "question") return `Refusé : cette mise en relation est déjà ${describeStatus(introduction.status)}.`;
      if (reponse === "question" && !message?.trim()) return "Refusé : écrivez la question à transmettre.";
      const response = reponse === "accepter" ? "accept" : reponse === "refuser" ? "decline" : "question";
      const contact = storefront.contactMethod ? `${CONTACT_LABEL[storefront.contactMethod]} — ${storefront.contactValue ?? "non renseigné"}` : "contact non renseigné";
      const summary =
        response === "accept"
          ? `Accepter la mise en relation (réf. ${introduction.id.slice(0, 8)}) : MAAQ transmet au membre votre contact « ${contact} » et vous transmet le sien (prénom, email, téléphone s'il existe).${message?.trim() ? `\nVotre mot : « ${message.trim()} »` : ""}`
          : response === "decline"
            ? `Refuser la mise en relation (réf. ${introduction.id.slice(0, 8)}). Le membre en sera informé${message?.trim() ? ` avec votre mot : « ${message.trim()} »` : ", sans explication"}. Rien n'est transmis.`
            : `Poser cette question au membre (réf. ${introduction.id.slice(0, 8)}) : « ${message!.trim()} ». Aucun contact n'est transmis.`;
      const handoff = deps.handoff;
      collector.proposals.push({
        summary,
        execute: async () => {
          try {
            await respondToIntroduction(handoff, { supplierUserId: userId, introductionId: introduction.id, response, message: message ?? null });
          } catch (error) {
            if (error instanceof HandoffRefused && error.code === "already_answered") return;
            throw error;
          }
        },
      });
      return `Carte de validation affichée : ${summary.split("\n")[0]} Dites au fournisseur de valider ou refuser la carte ; rien ne part avant.`;
    },
  });

  return [lire, enregistrerDits, proposer, confirmer, apercu, pause, indisponible, listerIntroductions, repondreIntroduction];
}
