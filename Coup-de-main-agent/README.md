# Coup-de-main-agent

Documentation de l'agent **coup_de_main** (rubrique Perso) : l'acheteur du marketplace silencieux. Un membre dit ce qu'il cherche, reçoit au plus trois vitrines de membres avec la raison de chacune, et valide une carte avant toute mise en relation. Deuxième brique du marketplace silencieux ([docs/specs/MAAQ_Marketplace_Silencieux_Plan.md](../docs/specs/MAAQ_Marketplace_Silencieux_Plan.md), phase 2 : US-09 à US-12, US-14). Le côté fournisseur est décrit dans [Vitrine-agent/README.md](../Vitrine-agent/README.md).

| Dossier | Rôle |
|---|---|
| `src/server/marketplace/matching.ts`, `rules.ts` | Mise en relation : éligibilité expliquée, pertinence par un appel structuré au modèle, seuils, journal |
| `src/server/marketplace/match-store.ts`, `match-db-store.ts` | Demandes, suggestions, mises en relation, préférences (base et mémoire) |
| `src/server/marketplace/introduction.ts` | Texte transmis au fournisseur, message dans son tchat vitrine, résumé de la carte |
| `src/server/marketplace/rematch.ts` | Réexamen périodique des demandes « me prévenir » |
| `src/server/marketplace/buyer-service.ts` | Magasin partagé, écran de consentement |
| `src/server/agents/coup-de-main.ts`, `coup-de-main-tools.ts` | Texte système, contexte, outils de l'agent |
| `src/app/api/marketplace/prefs` | Lecture et modification du consentement et des catégories coupées |
| `src/app/(app)/reglages/suggestions/page.tsx` | Écran Réglages › Suggestions de services |
| `db/migrations/0009_marketplace_matching.sql` | Tables `service_requests`, `suggestions`, `introductions` (`marketplace_prefs` vient de 0008) |
| `tests/marketplace-matching.test.ts` | Règles, service, agent avec faux modèle, base, consentement, traitement périodique |

## Ce que fait l'agent

- **Demande explicite** (`demander_service`). Il enregistre le besoin avec les mots de la personne, la catégorie si elle est évidente, le code postal et le moment. La seule information indispensable est la zone (ou l'acceptation d'un service à distance) : l'outil le dit, l'agent pose une question, pas plus. Une demande explicite fonctionne sans consentement aux suggestions proactives.
- **Recherche** (`chercher`) en deux étapes, dans `matching.ts` :
  1. *Éligibilité*, déterministe, sur la vue `v_eligible_storefronts` : vitrine d'un autre membre, catégorie, zone (département desservi d'après `servedDepartements`, sinon service à distance, jamais présenté comme local), catégories coupées, historique (suggestion active, écartée depuis moins de 90 jours, mise en relation en cours ou récente). Chaque règle produit une ligne lisible.
  2. *Pertinence* : un seul appel `complete` avec un schéma Zod pour au plus 10 candidates (score, raison adressée au membre, réserves). Les seuils sont dans `rules.ts` : sous 0,40 la vitrine est retenue sans être montrée ; entre 0,40 et 0,70 elle est posée en question (« Peut-être X, qui fait Y… ») ; au-dessus, affirmée. Au plus 3 suggestions.
  Sans vitrine éligible, le modèle n'est pas appelé : aucune correspondance ne peut être inventée. Une raison qui affirmerait une disponibilité (fiche « à convenir ») ou un prix (fiche « sur devis ») est remplacée par une phrase neutre ; l'affichage dit toujours « Disponibilité : à convenir (non confirmée) » dans ce cas.
- **Deux raisons par suggestion.** `reason` (pour l'acheteur) et `internal_reason` (règles d'éligibilité, score, réserves, pour l'opérateur), plus le journal complet du passage sur la demande (`match_log`), vitrines écartées comprises (US-17).
- **Aucun résultat** : l'agent le dit et propose d'être prévenu (`prevenir_plus_tard`), ce qui exige le consentement aux suggestions proactives.
- **Intérêt** (`interesse`) : l'outil rédige le texte transmis (besoin, moment, zone approximative, prénom seulement) et l'affiche sur une carte Valider / Refuser. **La carte est la seule voie vers une mise en relation** : sa validation crée la ligne `introductions` (statut `requested`, `shared_text` exactement tel qu'approuvé), marque la suggestion `interested` et dépose un message dans le tchat vitrine du fournisseur (`postAgentMessage`). Une seule mise en relation ouverte par couple (acheteur, vitrine).
- `ignorer` (carence de 90 jours), `couper_suggestions` (une catégorie, ou tout : désactive les suggestions proactives), `statut`, `voir_vitrine`.

## Consentement

Réglages › Suggestions de services : interrupteur des suggestions proactives avec le texte de consentement (version `CONSENT_VERSION` enregistrée avec la date), interrupteur « utiliser mon agenda » présent mais inactif (phase ultérieure), catégories coupées. Tout est dans `marketplace_prefs`.

## Traitement périodique

`runMarketplaceJobs` (dans `runDueJobs`) réexamine chaque demande ouverte marquée « me prévenir » contre les vitrines publiées ou reconfirmées depuis le dernier passage, seulement pour les profils qui ont activé les suggestions, et dépose les suggestions dans le tchat de coup_de_main. Ces messages sont à l'initiative de l'agent : ils ne comptent pas dans le plafond quotidien de demandes. Sans modèle local (`LOCAL_AGENTS_MODE=off`), rien ne tourne.

## Ce qui sort du compte

De l'acheteur : seulement le texte approuvé sur la carte, vers le fournisseur. Du fournisseur : les champs de `v_eligible_storefronts` (jamais le contact), vers l'acheteur. Les demandes, suggestions et mises en relation sont exportées avec les données du profil et supprimées avec lui.

## Activer

Même réglage que kdo_help et vitrine (`LOCAL_AGENTS_MODE=anthropic`). L'agent `coup_de_main` est créé par `npm run dev` ou `npm run db:seed`. Pour une démonstration, il faut une vitrine publiée par un autre profil.

## Pas encore

Réponse du fournisseur et échange des coordonnées (phase 3), modèle WhatsApp de notification, signalement et console d'administration (phase 4), déclenchement par l'agenda, photos, recherche publique.
