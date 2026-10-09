/**
 * Modèles de messages WhatsApp. Hors de la fenêtre de 24 h ouverte par un message de la personne, WhatsApp
 * n'autorise que ces modèles, soumis à l'approbation de Meta (voir Kdo-agent/whatsapp.md). Les textes ci-dessous
 * sont ceux à soumettre ; la boîte de test les rend tels quels.
 */

export interface TemplateDefinition {
  name: string;
  language: string;
  category: "UTILITY";
  /** Corps avec {{1}}, {{2}}… */
  body: string;
  /** Boutons de réponse rapide, dans l'ordre : charge utile fournie à l'envoi. */
  buttons: string[];
}

export const TEMPLATES = {
  /** Rappel d'occasion(s) à venir. {{1}} prénom, {{2}} phrase décrivant la ou les occasions. */
  occasion_reminder: {
    name: "maaq_rappel_occasions",
    language: "fr",
    category: "UTILITY",
    body: "Bonjour {{1}}, une date approche : {{2}}. Souhaitez-vous des idées de cadeaux ?",
    buttons: ["Voir les idées", "Plus tard", "C'est réglé"],
  },
  /** Confirmation de liaison. {{1}} prénom. */
  welcome: {
    name: "maaq_bienvenue",
    language: "fr",
    category: "UTILITY",
    body: "Bonjour {{1}}, votre WhatsApp est relié à MAAQ. Vous pouvez écrire à kdo_help ici et vous recevrez ses rappels d'occasions. Répondez STOP pour ne plus en recevoir.",
    buttons: [],
  },
} satisfies Record<string, TemplateDefinition>;

export type TemplateKey = keyof typeof TEMPLATES;

export function templateByName(name: string): TemplateDefinition | undefined {
  return Object.values(TEMPLATES).find((t) => t.name === name);
}

/** Texte du modèle avec ses paramètres remplacés (aperçu dans la boîte de test). */
export function renderTemplate(name: string, params: string[]): string {
  const definition = templateByName(name);
  if (!definition) return `[modèle inconnu ${name}]`;
  const body = definition.body.replace(/\{\{(\d+)\}\}/g, (_, index: string) => params[Number(index) - 1] ?? "");
  return definition.buttons.length ? `${body}\n[${definition.buttons.join("] [")}]` : body;
}
