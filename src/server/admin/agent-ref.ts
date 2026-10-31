/**
 * Identifiant MAAQ d'un agent publié avec l'adresse de son application Digitorn seulement (sans clé secrète) :
 * « app:<nom de domaine> ». Sans clé, MAAQ ne peut pas interroger Digitorn : l'adresse tient lieu d'identité.
 */
export const APP_REF_PREFIX = "app:";

/**
 * Code d'intégration de Digitorn collé tel quel (`<script src="https://…/embed.js" data-key="dk_…"></script>`) : l'adresse du cadre de ce widget
 * est `<origine du script>/embed/chat?key=<clé>`. La clé `dk_` est faite pour figurer dans une page publique ; elle ne donne pas accès à l'API.
 */
function frameFromSnippet(value: string): string | null {
  if (!/<script[\s>]/i.test(value)) return null;
  const src = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(value)?.[1];
  const key = /\bdata-key\s*=\s*["']([^"']+)["']/i.exec(value)?.[1];
  if (!src || !key || !/^[A-Za-z0-9_.~-]{8,200}$/.test(key)) return null;
  try {
    const origin = new URL(src);
    if (origin.protocol !== "https:") return null;
    return `${origin.origin}/embed/chat?key=${encodeURIComponent(key)}`;
  } catch {
    return null;
  }
}

/** Adresse de l'application dans l'iframe : https obligatoire, sans espace ; le code d'intégration `<script … data-key>` est aussi accepté. Renvoie l'adresse, ou null si elle est invalide. */
export function cleanAppUrl(raw: string | null | undefined): string | null {
  const value = raw?.trim();
  if (value?.startsWith("<")) return frameFromSnippet(value);
  if (!value || !/^https:\/\/[^\s]+$/.test(value)) return null;
  try {
    new URL(value);
    return value;
  } catch {
    return null;
  }
}

export function refFromAppUrl(url: string): string {
  const parsed = new URL(url);
  // Cadre d'un widget : plusieurs agents partagent le même domaine, l'identifiant public de la clé (« dk_<projet> ») les distingue.
  const key = parsed.pathname === "/embed/chat" ? parsed.searchParams.get("key") : null;
  const project = key ? key.split("_").slice(0, 2).join("_") : null;
  return APP_REF_PREFIX + parsed.hostname.toLowerCase() + (project ? `/${project.toLowerCase()}` : "");
}
