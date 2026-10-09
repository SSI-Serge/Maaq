import { frenchDate, localDate, upcomingOccasions } from "@/server/gifts/model";
import type { PrefsStore } from "@/server/gifts/prefs";
import type { GiftStore, IdeaInput } from "@/server/gifts/store";
import { giftTools, MAX_IDEAS, newCollector, OCCASION_WINDOW_DAYS, type TurnCollector } from "./kdo-help-tools";
import type { AgentBrain, AgentTurnInput, BrainReply, LlmClient, LlmMessage } from "./types";

/**
 * kdo_help — idées de cadeaux, proches, occasions et budget (ligne « kdo_help » de la liste des agents).
 * L'agent lit et écrit ses données par des outils (kdo-help-tools.ts) ; il répond de la même façon
 * depuis l'application ou depuis WhatsApp, le canal ne changeant que la longueur des réponses.
 */

export const KDO_HELP_REF = "kdo_help";
export { MAX_IDEAS, OCCASION_WINDOW_DAYS };

export const SYSTEM_PROMPT = `Tu es kdo_help, l'agent de MAAQ qui aide une famille à trouver des cadeaux, à se souvenir des anniversaires et à tenir son budget cadeaux.

Tu disposes d'outils pour lire et écrire les proches, les occasions et les idées. Utilise-les plutôt que ta mémoire : ce qu'ils renvoient fait foi.

Démarche pour une idée de cadeau, dans cet ordre :
1. Comprendre la personne : âge, lien, goûts, moment de vie, ce qu'elle a déjà reçu (lister_idees).
2. Imaginer des cadeaux qui partent de cette compréhension, pas d'une liste de best-sellers.
3. Ne garder que les meilleurs selon la pertinence, le budget, la relation et la facilité à se les procurer en France, puis les enregistrer avec proposer_idees (au plus 3, de la meilleure à la moins bonne). La fourchette de prix est celle constatée en magasin pour ce type d'article, pas le budget recopié : trois idées à « 150 à 200 € » sont un signe de paresse.

Règles d'écriture :
- Lever toute ambiguïté avant d'écrire : deux proches peuvent correspondre à un prénom ; demande lequel, ne devine jamais.
- Après une création ou une modification, confirme en une ligne ce qui a été enregistré, avec la date absolue (ex. « Enregistré : Sam (frère), anniversaire le 14/03, budget 200 € »).
- Pour créer un proche, le nom suffit ; demande ensuite l'anniversaire ou le lien, une question à la fois, et accepte qu'on passe.
- Les dates relatives (« samedi prochain », « le 14 ») se résolvent à partir de la date du jour fournie ; répète toujours la date absolue.
- Une suppression se demande avec l'outil prévu : elle n'a lieu qu'après validation de la carte par la personne. Ne jamais la considérer faite dans le texte.
- Ne repropose jamais une idée déjà proposée ni ce que la personne a déjà reçu.

Style :
- Français, bref, chaleureux, vouvoiement. Texte brut, sans Markdown (pas de **gras**, de titre ni de tableau) : le tchat affiche les caractères tels quels. Sur WhatsApp, encore plus court.
- S'il manque une information essentielle pour une idée (âge, lien, budget), pose une seule question courte et ne propose rien.
- Évite les cadeaux passe-partout (carte cadeau, chocolats, bougie) sauf demande explicite.
- N'invente ni lien, ni boutique précise, ni promotion : indique au besoin le type de magasin.
- Après proposer_idees, n'écris qu'une phrase d'introduction : l'application affiche les idées à part.
- MAAQ ne suit pas les achats hors des idées marquées « achetée » : pour un bilan de dépenses, dis-le et propose une estimation à partir du budget.`;

/** Message affiché quand le modèle n'a pas pu répondre. */
export const KDO_HELP_FAILURE_MESSAGE = "Je n'ai pas réussi à répondre. Réessayez dans un instant.";

const AMOUNT_PATTERN = /(\d+(?:[.,]\d+)?)\s*(?:€|euros?\b)/gi;

/** Budget maximal lu dans la demande (« 20 € max », « entre 15 et 30 euros »), sinon null. */
export function parseBudget(text: string): number | null {
  let max: number | null = null;
  for (const match of text.matchAll(AMOUNT_PATTERN)) {
    const value = Number(match[1].replace(",", "."));
    if (Number.isFinite(value) && (max === null || value > max)) max = value;
  }
  return max;
}

/** Texte du tchat : le message, puis les idées numérotées avec leur fourchette de prix. */
export function renderReply(message: string, ideas: IdeaInput[]): string {
  const lines = [message.trim()];
  ideas.forEach((idea, index) => {
    const min = idea.priceMin ?? 0;
    const max = idea.priceMax ?? min;
    const price = min === max ? `${min} €` : `${min} à ${max} €`;
    lines.push("", `${index + 1}. ${idea.title} — ${price}`, `   ${idea.why.trim()}`);
  });
  return lines.join("\n").trim();
}

export interface BrainDeps {
  store: GiftStore;
  prefs?: PrefsStore;
  /** Profil MAAQ d'une référence Digitorn ; par défaut, la référence sert d'identifiant (tests). */
  userIdOf?: (userRef: string) => Promise<string | null>;
}

/** Bloc de contexte joint à la demande : date, canal, proches, occasions proches, idées récentes. */
export async function contextBlock(deps: BrainDeps, userId: string, input: AgentTurnInput, today: string): Promise<string> {
  const [people, events, states, ideas] = await Promise.all([
    deps.store.listPeople(userId),
    deps.store.listEvents(userId),
    deps.store.listStates(userId),
    deps.store.listIdeas(userId, { limit: 10 }),
  ]);
  const lines = [
    "[Contexte MAAQ — à ne pas recopier dans la réponse]",
    `Date du jour : ${today} (fuseau ${input.timezone})`,
    `Canal : ${input.channel === "whatsapp" ? "WhatsApp (réponses courtes)" : "application"}`,
  ];

  if (people.length) {
    lines.push(`Proches enregistrés (${people.length}) :`);
    for (const p of people.slice(0, 30)) {
      const birthday = p.birthDay && p.birthMonth ? `, anniversaire ${String(p.birthDay).padStart(2, "0")}/${String(p.birthMonth).padStart(2, "0")}${p.birthYear ? `/${p.birthYear}` : ""}` : "";
      const interests = p.details.interests?.length ? `, aime : ${p.details.interests.join(", ")}` : "";
      const life = p.details.lifeEvents?.length ? `, moments de vie : ${p.details.lifeEvents.join(", ")}` : "";
      const notes = p.details.notes ? `, notes : ${p.details.notes}` : "";
      lines.push(`- ${p.name}${p.relationship ? ` (${p.relationship})` : ""}${birthday}${p.budgetAmount !== null ? `, budget ${p.budgetAmount} €` : ""}${interests}${life}${notes} [id ${p.id}]`);
    }
  } else {
    lines.push("Aucun proche enregistré.");
  }

  const occasions = upcomingOccasions({ people, events, states }, today, OCCASION_WINDOW_DAYS);
  if (occasions.length) {
    lines.push(`Occasions dans les ${OCCASION_WINDOW_DAYS} prochains jours :`);
    for (const o of occasions) lines.push(`- ${o.title} le ${frenchDate(o.date)}, dans ${o.daysRemaining} jour(s)${o.age === null ? "" : `, ${o.age} ans`}${o.sorted ? ", réglée" : ""} [clé ${o.key}]`);
  }

  if (ideas.length) {
    lines.push("Idées récentes :", ...ideas.map((i) => `- ${i.title} (${i.status})${i.personId ? ` pour ${people.find((p) => p.id === i.personId)?.name ?? "?"}` : ""}`));
  }
  if (input.context.rank !== "primary_user") lines.push("La personne qui écrit est un invité du compte, pas l'utilisateur principal.");
  return lines.join("\n");
}

/** Historique récent puis la demande, précédée de son contexte. Le premier message est toujours celui de la personne. */
export function buildMessages(input: AgentTurnInput, context: string): LlmMessage[] {
  const firstUser = input.history.findIndex((item) => item.role === "user");
  const history = firstUser === -1 ? [] : input.history.slice(firstUser);
  const messages: LlmMessage[] = history.map((item) => ({ role: item.role === "user" ? "user" : "assistant", content: item.text }));
  messages.push({ role: "user", content: `${context}\n\n[Demande]\n${input.text}` });
  return messages;
}

export interface KdoGeneration {
  reply: BrainReply;
  message: string;
  ideas: IdeaInput[];
  /** Idées retirées par les contrôles objectifs (évaluations). */
  problems: string[];
  /** Outils appelés pendant le tour (évaluations). */
  calls: string[];
}

export interface KdoHelpBrain extends AgentBrain {
  generate(input: AgentTurnInput): Promise<KdoGeneration>;
}

export function kdoHelpBrain(llm: LlmClient, deps: BrainDeps): KdoHelpBrain {
  const userIdOf = deps.userIdOf ?? (async (ref: string) => ref);

  return {
    ref: KDO_HELP_REF,

    async generate(input) {
      const userId = await userIdOf(input.userRef);
      if (!userId) return { reply: { text: "Je ne retrouve pas votre profil. Reconnectez-vous à MAAQ.", proposals: [] }, message: "", ideas: [], problems: ["profil inconnu"], calls: [] };

      const today = localDate(input.today, input.timezone);
      const collector: TurnCollector = newCollector();
      const tools = giftTools({ store: deps.store, prefs: deps.prefs ?? null, userId, today, timezone: input.timezone, requestBudget: parseBudget(input.text) }, collector);
      const context = await contextBlock(deps, userId, input, today);
      const { text } = await llm.runTools({ system: SYSTEM_PROMPT, messages: buildMessages(input, context), tools, maxIterations: 8 });

      const message = text || (collector.ideas.length ? "Voici mes idées :" : KDO_HELP_FAILURE_MESSAGE);
      return {
        reply: { text: renderReply(message, collector.ideas), proposals: collector.proposals },
        message,
        ideas: collector.ideas,
        problems: collector.problems,
        calls: collector.calls,
      };
    },

    async respond(input) {
      return (await this.generate(input)).reply;
    },

    forget() {
      // Rien n'est gardé en mémoire : les données vivent dans le magasin, effacées avec le profil.
    },
  };
}
