/**
 * Bandeau du retour sur l'accueil de Courses et repas après une validation (CR-72, CR-73), 5 secondes :
 *  - menu de la semaine : « Menu validé. Retrouvez-le en haut de l'accueil. » ;
 *  - menu du mois : « Menus validés. Retrouvez-les dans le menu de la semaine. », et un toucher ouvre « Menu de la semaine » sur la première semaine validée.
 * Un repère posé dans la session du navigateur au moment de la validation, effacé dès qu'il est lu. Sans stockage, pas de bandeau : le menu est validé quand même.
 */
const KEY = "maaq:courses-menu-validated";

export type Validated = { kind: "week" } | { kind: "month"; firstWeek: string | null };

export function markMenuValidated(value: Validated = { kind: "week" }): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // voir ci-dessus
  }
}

/** Le repère, une seule fois après une validation ; `null` sinon. */
export function takeMenuValidated(): Validated | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    window.sessionStorage.removeItem(KEY);
    const value = JSON.parse(raw) as Validated;
    return value && (value.kind === "week" || value.kind === "month") ? value : { kind: "week" };
  } catch {
    return null;
  }
}
