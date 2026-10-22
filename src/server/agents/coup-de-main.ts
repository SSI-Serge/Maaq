import type { PlacesDirectory } from "@/server/adapters/places/types";
import { localDate } from "@/server/gifts/model";
import type { MatchStore } from "@/server/marketplace/match-store";
import { SERVICE_CATEGORIES } from "@/server/marketplace/model";
import { coupDeMainTools, describeRequest, INTRODUCTION_STATUS_TEXT, newCollector, SUGGESTION_STATUS_TEXT, type TurnCollector } from "./coup-de-main-tools";
import { buildMessages } from "./messages";
import type { AgentBrain, AgentTurnInput, BrainReply, LlmClient } from "./types";
import type { ExternalBlock } from "@/server/marketplace/external";
import type { MatchOutcome } from "@/server/marketplace/matching";

/**
 * coup_de_main — l'agent de la rubrique Perso qui trouve un coup de main parmi les vitrines publiées par
 * d'autres membres : la personne dit ce qu'elle cherche, reçoit au plus trois suggestions avec la raison de
 * chacune, et valide une carte avant toute mise en relation (US-09 à US-12, US-14).
 */

export const COUP_DE_MAIN_REF = "coup_de_main";

export const SYSTEM_PROMPT = `Tu es coup_de_main, l'agent de MAAQ qui aide un membre à trouver un service près de chez lui (coiffure, ménage, cours, bricolage, traiteur…) parmi les vitrines publiées par d'autres membres. Tu ne connais ces fournisseurs que par leur vitrine : tu ne promets jamais une disponibilité, un prix ou un délai que la vitrine ne donne pas.

Tu disposes d'outils ; ce qu'ils renvoient fait foi.

Démarche :
1. Quand la personne exprime un besoin, enregistre-le avec demander_service en ne transmettant que ce qu'elle a dit (catégorie si elle est évidente, ville ou code postal, moment). L'outil dit s'il manque quelque chose d'indispensable : pose alors une seule question courte. Ne demande rien d'autre.
2. Dès que la demande est prête, appelle chercher. Présente les suggestions exactement comme l'outil les rend (nom, service, zone, disponibilité, tarif, pourquoi), au plus trois. Une suggestion « Peut-être… » se présente comme une question, pas comme une certitude.
3. Sans résultat, dis-le honnêtement, sans inventer de fournisseur, et propose d'être prévenu si une vitrine correspondante arrive (prevenir_plus_tard). Cela demande que les suggestions soient activées dans Réglages › Suggestions de services : indique-le si l'outil le signale.
4. Si la personne est intéressée par une suggestion, appelle interesse : l'outil affiche une carte avec le texte exact qui serait envoyé au fournisseur (son besoin, le moment, la zone approximative et son prénom, rien d'autre). Rien n'est envoyé tant qu'elle n'a pas validé la carte : dis-le, et ne présente jamais la mise en relation comme faite. Si elle veut modifier le texte, rappelle interesse avec ses précisions.
5. Pour écarter une suggestion : ignorer. Pour couper des suggestions d'une catégorie ou toutes : couper_suggestions. Pour faire le point : statut.
6. Une demande « issue de votre agenda, en attente de votre réponse » vient d'une question que tu as posée après avoir vu un événement de l'agenda de la personne. Si elle répond oui, appelle chercher sur cette demande ; si elle répond non, appelle clore_demande. Ne cherche jamais sans son oui.

Règles :
- Disponibilité « à convenir » signifie non confirmée : ne dis jamais que le fournisseur est disponible. Un tarif « sur devis » n'est pas un prix.
- Une vitrine « à distance » n'est pas près de chez la personne : dis-le ainsi.
- Le bloc « Hors MAAQ » liste des établissements qui ne sont pas membres : présente-le à part, avec la note et le nombre d'avis tels quels, et dis que la personne les contacte elle-même. Jamais de mise en relation pour eux.
- Les coordonnées du fournisseur ne sont jamais transmises avant son accord ; les coordonnées de la personne ne le sont jamais par toi.
- Ne crée pas de nouvelle demande pour une précision sur la demande en cours : complète-la (demande_id).
- Catégories possibles (code : libellé) : ${SERVICE_CATEGORIES.map((c) => `${c.code} : ${c.label}`).join(" ; ")}.

Style : français, bref, chaleureux, vouvoiement. Texte brut, sans Markdown (pas de **gras**, de titre ni de tableau). Sur WhatsApp, encore plus court. Une seule question par message.`;

export const COUP_DE_MAIN_FAILURE_MESSAGE = "Je n'ai pas réussi à répondre. Réessayez dans un instant ; votre demande est conservée.";

export interface Profile {
  id: string;
  firstName: string;
  /** Code postal du profil, zone par défaut des demandes. */
  postcode?: string | null;
}

export interface BrainDeps {
  store: MatchStore;
  /** Profil MAAQ d'une référence Digitorn ; par défaut, la référence sert d'identifiant et de prénom (tests). */
  profileOf?: (userRef: string) => Promise<Profile | null>;
  /** Dépose un message dans le tchat vitrine d'un fournisseur ; par défaut, rien (tests sans simulateur). */
  notifySupplier?: (supplierUserId: string, text: string) => Promise<void>;
  /** Annuaire externe (phase 2c) ; absent = jamais de bloc « Hors MAAQ ». */
  directory?: PlacesDirectory | null;
  now?: () => Date;
}

/** Bloc de contexte joint à la demande : date, canal, consentement, demandes et suggestions en cours. */
export async function contextBlock(deps: BrainDeps, userId: string, input: AgentTurnInput, today: string): Promise<string> {
  const [prefs, requests, suggestions, introductions, categories] = await Promise.all([
    deps.store.getPrefs(userId),
    deps.store.listRequests(userId),
    deps.store.listSuggestions(userId, { status: ["shown", "interested"] }),
    deps.store.listIntroductions(userId),
    deps.store.listCategories(),
  ]);
  const labels = new Map(categories.map((c) => [c.code, c.label]));
  const label = (code: string) => labels.get(code) ?? code;
  const lines = [
    "[Contexte MAAQ — à ne pas recopier dans la réponse]",
    `Date du jour : ${today} (fuseau ${input.timezone})`,
    `Canal : ${input.channel === "whatsapp" ? "WhatsApp (réponses courtes)" : "application"}`,
    `Suggestions proactives : ${prefs.suggestionsOptIn ? "activées" : "non activées (la personne peut les activer dans Réglages › Suggestions de services ; une demande explicite fonctionne sans)"}${prefs.mutedCategories.length ? ` ; catégories coupées : ${prefs.mutedCategories.map(label).join(", ")}` : ""}`,
  ];
  const open = requests.filter((r) => r.status !== "closed").slice(0, 5);
  const profile = await (deps.profileOf ?? (async () => null))(input.userRef);
  if (profile?.postcode) lines.push(`Code postal du profil : ${profile.postcode} (zone par défaut des demandes)`);
  lines.push(open.length ? "Demandes en cours :" : "Aucune demande en cours.");
  for (const r of open) lines.push(`- ${describeRequest(r, label)}`);
  if (suggestions.length) {
    lines.push("Suggestions en cours :");
    for (const s of suggestions.slice(0, 10)) {
      const sf = await deps.store.getEligible(s.storefrontId, today);
      lines.push(`- ${sf?.displayName ?? "vitrine retirée"} : ${SUGGESTION_STATUS_TEXT[s.status]} [suggestion ${s.id}]`);
    }
  }
  if (introductions.length) {
    lines.push("Mises en relation :");
    for (const i of introductions.slice(0, 5)) {
      const sf = await deps.store.getEligible(i.storefrontId, today);
      lines.push(`- ${sf?.displayName ?? "vitrine retirée"} : ${INTRODUCTION_STATUS_TEXT[i.status]}`);
    }
  }
  if (input.context.rank !== "primary_user") lines.push("La personne qui écrit est un invité du compte, pas l'utilisateur principal.");
  return lines.join("\n");
}

export interface CoupDeMainGeneration {
  reply: BrainReply;
  calls: string[];
  problems: string[];
  outcomes: MatchOutcome[];
  external: ExternalBlock[];
}

export interface CoupDeMainBrain extends AgentBrain {
  generate(input: AgentTurnInput): Promise<CoupDeMainGeneration>;
}

export function coupDeMainBrain(llm: LlmClient, deps: BrainDeps): CoupDeMainBrain {
  const profileOf = deps.profileOf ?? (async (ref: string): Promise<Profile> => ({ id: ref, firstName: ref }));
  const notifySupplier = deps.notifySupplier ?? (async () => {});
  const now = deps.now ?? (() => new Date());

  return {
    ref: COUP_DE_MAIN_REF,

    async generate(input) {
      const profile = await profileOf(input.userRef);
      if (!profile) return { reply: { text: "Je ne retrouve pas votre profil. Reconnectez-vous à MAAQ.", proposals: [] }, calls: [], problems: ["profil inconnu"], outcomes: [], external: [] };

      const today = localDate(input.today, input.timezone);
      const collector: TurnCollector = newCollector();
      const tools = coupDeMainTools({ store: deps.store, llm, userId: profile.id, firstName: profile.firstName, postcode: profile.postcode ?? null, today, now, notifySupplier, directory: deps.directory ?? null }, collector);
      const context = await contextBlock(deps, profile.id, input, today);
      const { text } = await llm.runTools({ system: SYSTEM_PROMPT, messages: buildMessages(input, context), tools, maxIterations: 8 });
      return { reply: { text: text || COUP_DE_MAIN_FAILURE_MESSAGE, proposals: collector.proposals }, calls: collector.calls, problems: collector.problems, outcomes: collector.outcomes, external: collector.external };
    },

    async respond(input) {
      return (await this.generate(input)).reply;
    },

    forget() {
      // Rien n'est gardé en mémoire : demandes, suggestions et mises en relation vivent dans le magasin, supprimées avec le profil.
    },
  };
}
