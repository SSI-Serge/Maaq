/**
 * Identifiant MAAQ d'un agent publié avec l'adresse de son application Digitorn seulement (sans clé secrète) :
 * « app:<nom de domaine> ». Sans clé, MAAQ ne peut pas interroger Digitorn : l'adresse tient lieu d'identité.
 */
export const APP_REF_PREFIX = "app:";

/** Adresse de l'application dans l'iframe : https obligatoire, sans espace. Renvoie l'adresse saisie, ou null si elle est invalide. */
export function cleanAppUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (!value || !/^https:\/\/[^\s]+$/.test(value)) return null;
  try {
    new URL(value);
    return value;
  } catch {
    return null;
  }
}

export function refFromAppUrl(url: string): string {
  return APP_REF_PREFIX + new URL(url).hostname.toLowerCase();
}
