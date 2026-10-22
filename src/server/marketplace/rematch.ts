import type { LlmClient } from "@/server/agents/types";
import type { MatchStore } from "./match-store";
import { matchRequest, renderSuggestions } from "./matching";

/**
 * Traitement périodique du marketplace silencieux : les demandes ouvertes marquées « me prévenir » sont
 * réexaminées contre les vitrines publiées ou reconfirmées depuis le dernier passage, pour les seuls profils qui
 * ont activé les suggestions. Les suggestions partent dans le tchat de coup_de_main par un message de l'agent,
 * qui ne compte pas dans le plafond quotidien de demandes (décision 10 du plan).
 */

export interface RematchDeps {
  store: MatchStore;
  llm: Pick<LlmClient, "complete">;
  now: Date;
  /** Jour civil, AAAA-MM-JJ, pour l'éligibilité (pause temporaire). */
  today: string;
  /** Dépose un message de coup_de_main dans le tchat de l'acheteur. */
  postInApp: (userId: string, text: string) => Promise<void>;
}

export interface RematchResult {
  /** Demandes réexaminées (consentement donné). */
  requests: number;
  /** Demandes ignorées faute de consentement aux suggestions proactives. */
  withoutConsent: number;
  /** Demandes pour lesquelles au moins une suggestion est partie. */
  suggested: number;
  failed: number;
}

export function proactiveText(firstName: string | null, count: number, body: string): string {
  const hello = firstName ? `Bonjour ${firstName}, ` : "Bonjour, ";
  return `${hello}${count === 1 ? "une vitrine qui pourrait correspondre à votre demande vient d'être publiée" : `${count} vitrines qui pourraient correspondre à votre demande viennent d'être publiées`} :\n\n${body}\n\nDites-moi si l'une vous intéresse ; rien n'est transmis sans votre validation.`;
}

export async function runRematch(deps: RematchDeps, firstNameOf: (userId: string) => Promise<string | null> = async () => null): Promise<RematchResult> {
  const result: RematchResult = { requests: 0, withoutConsent: 0, suggested: 0, failed: 0 };
  for (const { request, prefs } of await deps.store.listNotifyLaterRequests()) {
    if (!prefs.suggestionsOptIn) {
      result.withoutConsent++;
      continue;
    }
    result.requests++;
    try {
      // Sans passage précédent, on repart de la création de la demande : tout ce qui a été publié depuis compte.
      const outcome = await matchRequest({ store: deps.store, llm: deps.llm, now: () => deps.now, today: deps.today }, request, { changedSince: request.lastMatchedAt ?? request.createdAt });
      if (outcome.suggestions.length === 0) continue;
      await deps.postInApp(request.userId, proactiveText(await firstNameOf(request.userId), outcome.suggestions.length, renderSuggestions(outcome.suggestions)));
      result.suggested++;
    } catch (error) {
      console.error(`[marketplace] réexamen de la demande ${request.id} échoué :`, error);
      result.failed++;
    }
  }
  return result;
}
