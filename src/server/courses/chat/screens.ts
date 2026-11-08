/** Écrans de l'application que l'agent peut montrer (marqueurs `[[ecran:nom]]` dans ses réponses, remplacés par un lien dans le tchat). Fichier pur : lu aussi par l'écran. */
export const SCREENS = {
  liste: { label: "Liste de courses", href: "/courses/liste", couple: false },
  ma_liste: { label: "Ma liste de courses", href: "/courses/ma-liste", couple: false },
  budget: { label: "Budget par rayon", href: "/courses/budget", couple: true },
  reglages: { label: "Réglages du foyer", href: "/courses/reglages", couple: true },
  ticket: { label: "Enregistrer un ticket", href: "/courses/ticket", couple: true },
  plat: { label: "Nouveau plat", href: "/courses/plats/nouveau", couple: true },
} as const;
export type ScreenKey = keyof typeof SCREENS;
