import { DigitornError } from "@/server/adapters/digitorn";
import { Rejection } from "@/server/http";

/**
 * Erreur de Digitorn en refus lisible par l'utilisateur ou l'administrateur. Une erreur qui n'est pas de Digitorn
 * est rendue telle quelle (elle sera journalisée comme une erreur interne).
 */
export function asRejection(error: unknown): unknown {
  if (!(error instanceof DigitornError)) return error;
  const trace = error.traceId ? ` (référence de suivi : ${error.traceId})` : "";
  switch (error.code) {
    case "agent_not_found":
      return new Rejection("agent_not_found", "Aucun agent ne porte ce nom chez Digitorn.", 404);
    case "agent_ambiguous":
      return new Rejection("agent_ambiguous", "Plusieurs agents portent ce nom chez Digitorn : saisissez le nom exact.", 409);
    case "key_required":
      return new Rejection("key_required", error.message, 422);
    case "not_a_project_key":
      return new Rejection("key_refused", "Cette clé n'est pas la clé secrète d'un projet Digitorn.", 422);
    case "app_not_published":
      return new Rejection("app_not_published", "Le tchat de cet agent n'est pas encore publié chez Digitorn.", 409);
    case "test_mode_limit":
      return new Rejection("test_mode_limit", `Le projet Digitorn de cet agent est en mode test et a atteint sa limite d'utilisateurs${trace}.`, 409);
    default:
      break;
  }
  if (error.status === 401 || error.status === 403) {
    return new Rejection("key_refused", `Digitorn a refusé la clé de cet agent : elle est invalide, révoquée ou non autorisée${trace}.`, 422);
  }
  if (error.retryable || error.status === 0) {
    return new Rejection("digitorn_unavailable", "Digitorn est momentanément indisponible. Réessayez dans quelques instants.", 503);
  }
  return new Rejection("digitorn_error", `Digitorn a répondu une erreur (${error.code})${trace}.`, 502);
}
