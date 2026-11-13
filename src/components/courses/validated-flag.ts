/**
 * « Menu validé. Retrouvez-le en haut de l'accueil. » (CR-72) : le bandeau s'affiche 5 secondes au retour sur l'accueil de Courses et repas après une validation.
 * Un repère posé dans la session du navigateur au moment de la validation, effacé dès qu'il est lu. Sans stockage, pas de bandeau : le menu est validé quand même.
 */
const KEY = "maaq:courses-menu-validated";

export function markMenuValidated(): void {
  try {
    window.sessionStorage.setItem(KEY, "1");
  } catch {
    // voir ci-dessus
  }
}

/** Vrai une seule fois après une validation. */
export function takeMenuValidated(): boolean {
  try {
    const set = window.sessionStorage.getItem(KEY) === "1";
    if (set) window.sessionStorage.removeItem(KEY);
    return set;
  } catch {
    return false;
  }
}
