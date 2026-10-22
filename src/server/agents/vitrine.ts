import { localDate } from "@/server/gifts/model";
import { SERVICE_CATEGORIES } from "@/server/marketplace/model";
import type { StorefrontStore } from "@/server/marketplace/store";
import { buildMessages } from "./messages";
import type { AgentBrain, AgentTurnInput, BrainReply, LlmClient } from "./types";
import { describeStorefront, newCollector, vitrineTools, type TurnCollector } from "./vitrine-tools";

/**
 * vitrine — l'agent de la rubrique Pro qui crée et entretient la vitrine d'un fournisseur par la conversation
 * (voix ou texte). Il extrait, montre ce qu'il a compris, demande ce qui manque, relit les détails critiques et
 * n'invente rien. La publication se fait sur l'écran « Ma vitrine », jamais dans le tchat (US-01 à US-06).
 */

export const VITRINE_REF = "vitrine";

export const SYSTEM_PROMPT = `Tu es vitrine, l'agent de MAAQ qui aide un fournisseur de services (coiffure à domicile, traiteur, ménage, cours…) à créer sa vitrine : une description de son service que MAAQ pourra proposer discrètement à des membres qui cherchent ce service. Personne ne voit la vitrine tant qu'elle n'est pas publiée, et la publication ne se fait que par le bouton Publier de l'écran « Ma vitrine » (Catalogue › vitrine) : ne dis jamais qu'une vitrine est publiée à la suite de la conversation.

Tu disposes d'outils pour lire et écrire la vitrine. Ce qu'ils renvoient fait foi : relis la vitrine avec lire_vitrine avant d'affirmer ce qu'elle contient.

Démarche :
1. Laisse la personne décrire son activité avec ses mots, à l'oral ou à l'écrit. Une description peut répondre à plusieurs questions d'un coup : extrais tout ce qui est dit, et seulement ce qui est dit, avec enregistrer_dits.
2. Montre ce que tu as compris, groupe par groupe, en distinguant ce que la personne a dit de ce que tu proposes. Ce que tu déduis ou rédiges toi-même (catégorie, description, « à convenir ») passe par proposer_champs, jamais par enregistrer_dits.
3. Demande ensuite ce qui manque, une question courte à la fois, dans cet ordre : nom affiché, services, zone (ville et code postal, et si les clients viennent, si elle se déplace, ou à distance), disponibilité (horaires ou « à convenir »), contact (présentation par MAAQ avec un email, ou WhatsApp avec un numéro). Le tarif est facultatif : propose « sur devis » si la personne ne sait pas.
4. Les détails critiques se relisent avant d'être confirmés : zone, tarif, contact. Répète la valeur comprise et demande « c'est bien ça ? ». N'appelle confirmer_champs que lorsque la personne a explicitement approuvé. Ne confirme jamais à sa place.
5. Quand tout est renseigné et confirmé, dis-le et indique où publier : l'écran « Ma vitrine ».

Règles :
- N'invente ni service, ni zone, ni horaire, ni prix. « Je peux me déplacer le samedi » donne un déplacement avec la précision « le samedi seulement », pas un service mobile tous les jours.
- Une réponse « je ne sais pas encore » sur un champ facultatif est acceptée : on passe.
- Si la personne corrige une valeur, la dernière valeur dite remplace la précédente.
- La zone est approximative (ville, code postal) : ne demande jamais d'adresse. Le contact (email, numéro) n'est révélé à un membre qu'après l'accord du fournisseur, dis-le quand tu le demandes.
- Une erreur de transcription est possible : si un nombre, un code postal ou un numéro semble étrange, demande.
- Catégories possibles (code : libellé) : ${SERVICE_CATEGORIES.map((c) => `${c.code} : ${c.label}`).join(" ; ")}.

Style : français, bref, chaleureux, vouvoiement. Texte brut, sans Markdown (pas de **gras**, de titre ni de tableau). Sur WhatsApp, encore plus court. Une seule question par message.`;

export const VITRINE_FAILURE_MESSAGE = "Je n'ai pas réussi à répondre. Réessayez dans un instant ; votre vitrine est conservée telle quelle.";

export interface BrainDeps {
  store: StorefrontStore;
  /** Profil MAAQ d'une référence Digitorn ; par défaut, la référence sert d'identifiant (tests). */
  userIdOf?: (userRef: string) => Promise<string | null>;
}

/** Bloc de contexte joint à la demande : date, canal, état de la vitrine. */
export async function contextBlock(deps: BrainDeps, userId: string, input: AgentTurnInput, today: string): Promise<string> {
  const [storefront, categories] = await Promise.all([deps.store.get(userId), deps.store.listCategories()]);
  const labels = new Map(categories.map((c) => [c.code, c.label]));
  const lines = [
    "[Contexte MAAQ — à ne pas recopier dans la réponse]",
    `Date du jour : ${today} (fuseau ${input.timezone})`,
    `Canal : ${input.channel === "whatsapp" ? "WhatsApp (réponses courtes)" : "application"}`,
    "Vitrine actuelle :",
    describeStorefront(storefront, (code) => labels.get(code) ?? code),
  ];
  if (input.context.rank !== "primary_user") lines.push("La personne qui écrit est un invité du compte, pas l'utilisateur principal.");
  return lines.join("\n");
}

export interface VitrineGeneration {
  reply: BrainReply;
  calls: string[];
  problems: string[];
}

export interface VitrineBrain extends AgentBrain {
  generate(input: AgentTurnInput): Promise<VitrineGeneration>;
}

export function vitrineBrain(llm: LlmClient, deps: BrainDeps): VitrineBrain {
  const userIdOf = deps.userIdOf ?? (async (ref: string) => ref);

  return {
    ref: VITRINE_REF,

    async generate(input) {
      const userId = await userIdOf(input.userRef);
      if (!userId) return { reply: { text: "Je ne retrouve pas votre profil. Reconnectez-vous à MAAQ.", proposals: [] }, calls: [], problems: ["profil inconnu"] };

      const today = localDate(input.today, input.timezone);
      const collector: TurnCollector = newCollector();
      const tools = vitrineTools({ store: deps.store, userId, today }, collector);
      const context = await contextBlock(deps, userId, input, today);
      const { text } = await llm.runTools({ system: SYSTEM_PROMPT, messages: buildMessages(input, context), tools, maxIterations: 8 });
      return { reply: { text: text || VITRINE_FAILURE_MESSAGE, proposals: [] }, calls: collector.calls, problems: collector.problems };
    },

    async respond(input) {
      return (await this.generate(input)).reply;
    },

    forget() {
      // Rien n'est gardé en mémoire : la vitrine vit dans le magasin, supprimée avec le profil.
    },
  };
}
