# Coup-de-main-agent

Documentation de l'agent **coup_de_main** (rubrique Perso) : l'acheteur du marketplace silencieux. Un membre dit ce qu'il cherche, reçoit au plus trois vitrines de membres avec la raison de chacune, et valide une carte avant toute mise en relation. Deuxième brique du marketplace silencieux ([docs/specs/MAAQ_Marketplace_Silencieux_Plan.md](../docs/specs/MAAQ_Marketplace_Silencieux_Plan.md), phase 2 : US-09 à US-12, US-14). Le côté fournisseur est décrit dans [Vitrine-agent/README.md](../Vitrine-agent/README.md).

| Dossier | Rôle |
|---|---|
| `src/server/marketplace/matching.ts`, `rules.ts` | Mise en relation : éligibilité expliquée, pertinence par un appel structuré au modèle, seuils, journal |
| `src/server/marketplace/match-store.ts`, `match-db-store.ts` | Demandes, suggestions, mises en relation, préférences (base et mémoire) |
| `src/server/marketplace/introduction.ts` | Texte transmis au fournisseur, message dans son tchat vitrine, résumé de la carte |
| `src/server/marketplace/rematch.ts` | Réexamen périodique des demandes « me prévenir » |
| `src/server/marketplace/agenda.ts`, `src/server/adapters/calendar/` | Suggestions déclenchées par l'agenda (phase 2b) : classification des titres, question avant toute recherche ; agenda de démonstration `/dev/agenda` |
| `src/server/marketplace/external.ts`, `src/server/adapters/places/` | Annuaire externe quand l'offre des membres est mince (phase 2c) : Google Places (New), Sirene, démonstration |
| `src/server/marketplace/handoff.ts`, `handoff-app.ts` | Transfert au fournisseur et retour vers l'acheteur (phase 3) : accepter, refuser, question, échange des contacts, expiration, boutons WhatsApp |
| `src/server/admin/storefronts.ts`, `src/app/(app)/admin/vitrines`, `src/app/api/admin/vitrines` | Admin › Vitrines (phase 4) : liste signalées d'abord, suspension, catégorie, signalements, raisons internes, compteurs |
| `src/server/marketplace/buyer-service.ts` | Magasin partagé, écran de consentement |
| `src/server/agents/coup-de-main.ts`, `coup-de-main-tools.ts` | Texte système, contexte, outils de l'agent |
| `src/app/api/marketplace/prefs` | Lecture et modification du consentement et des catégories coupées |
| `src/app/(app)/reglages/suggestions/page.tsx` | Écran Réglages › Suggestions de services |
| `db/migrations/0009_marketplace_matching.sql`, `0010_marketplace_agenda.sql`, `0011_marketplace_reports.sql` | Tables `service_requests`, `suggestions`, `introductions`, `agenda_events_seen`, `listing_reports` ; code postal du profil ; consentement agenda ; suspension administrateur |
| `tests/marketplace-matching.test.ts`, `marketplace-agenda.test.ts`, `marketplace-external.test.ts`, `marketplace-handoff.test.ts`, `marketplace-admin.test.ts` | Règles, service, agents avec faux modèle, base, consentements, traitements périodiques, annuaire, transfert, administration |

## Ce que fait l'agent

- **Demande explicite** (`demander_service`). Il enregistre le besoin avec les mots de la personne, la catégorie si elle est évidente, le code postal et le moment. La seule information indispensable est la zone (ou l'acceptation d'un service à distance) : l'outil le dit, l'agent pose une question, pas plus. Une demande explicite fonctionne sans consentement aux suggestions proactives.
- **Recherche** (`chercher`) en deux étapes, dans `matching.ts` :
  1. *Éligibilité*, déterministe, sur la vue `v_eligible_storefronts` : vitrine d'un autre membre, catégorie, zone (département desservi d'après `servedDepartements`, sinon service à distance, jamais présenté comme local), catégories coupées, historique (suggestion active, écartée depuis moins de 90 jours, mise en relation en cours ou récente). Chaque règle produit une ligne lisible.
  2. *Pertinence* : un seul appel `complete` avec un schéma Zod pour au plus 10 candidates (score, raison adressée au membre, réserves). Les seuils sont dans `rules.ts` : sous 0,40 la vitrine est retenue sans être montrée ; entre 0,40 et 0,70 elle est posée en question (« Peut-être X, qui fait Y… ») ; au-dessus, affirmée. Au plus 3 suggestions.
  Sans vitrine éligible, le modèle n'est pas appelé : aucune correspondance ne peut être inventée. Une raison qui affirmerait une disponibilité (fiche « à convenir ») ou un prix (fiche « sur devis ») est remplacée par une phrase neutre ; l'affichage dit toujours « Disponibilité : à convenir (non confirmée) » dans ce cas.
- **Deux raisons par suggestion.** `reason` (pour l'acheteur) et `internal_reason` (règles d'éligibilité, score, réserves, pour l'opérateur), plus le journal complet du passage sur la demande (`match_log`), vitrines écartées comprises (US-17).
- **Aucun résultat** : l'agent le dit et propose d'être prévenu (`prevenir_plus_tard`), ce qui exige le consentement aux suggestions proactives.
- **Intérêt** (`interesse`) : l'outil rédige le texte transmis (besoin, moment, zone approximative, prénom seulement) et l'affiche sur une carte Valider / Refuser. **La carte est la seule voie vers une mise en relation** : sa validation crée la ligne `introductions` (statut `requested`, `shared_text` exactement tel qu'approuvé), marque la suggestion `interested` et dépose un message dans le tchat vitrine du fournisseur (`postAgentMessage`). Une seule mise en relation ouverte par couple (acheteur, vitrine).
- `ignorer` (carence de 90 jours), `couper_suggestions` (une catégorie, ou tout : désactive les suggestions proactives), `statut`, `voir_vitrine`, `clore_demande`, `repondre_fournisseur` (réponse à la question d'un fournisseur).
- **Zone par défaut.** Une demande sans code postal prend celui du profil (Réglages › Mes informations), sauf si un service à distance convient.

## Troisième voie : l'agenda (phase 2b)

Avec un consentement propre (texte et version distincts, Réglages › Suggestions de services, qui exige les suggestions), le passage périodique lit les titres et dates des événements des 14 prochains jours de l'agenda du profil, classe en un appel structuré ceux qui ressemblent à un service à faire faire (seuil de confiance dans `rules.ts`), et crée une demande `proposed` avec une phrase neutre (jamais le titre), la date, et le code postal du profil. coup_de_main pose alors la question dans son tchat : « Je vois que vous avez ajouté « … » … Voulez-vous que je cherche quelqu'un près de chez vous ? » La recherche n'a lieu que sur le oui (`chercher`) ; le non clôt la demande. Chaque événement n'est examiné qu'une fois (`agenda_events_seen`, clé opaque). L'agenda lu dépend de `CALENDAR_MODE` : `dev` (agenda de démonstration, `/dev/agenda`, en attendant le calendrier maître), `none`.

## Annuaire externe (phase 2c)

Quand moins de trois vitrines de membres répondent, un bloc « Hors MAAQ » complète la réponse avec des établissements d'un annuaire : Google Places API (New) avec un masque de champs minimal (nom, commune, note, nombre d'avis, lien ; aucun texte d'avis), ou le registre Sirene (sans avis) en repli ou seul. L'annuaire ne reçoit que la catégorie et le code postal, jamais le texte de la demande ; rien n'est conservé ; ces établissements n'ont jamais de carte de mise en relation. `PLACES_MODE` : `off`, `dev` (noms fictifs), `sirene`, `google` (clé `GOOGLE_PLACES_API_KEY`, puis Sirene en repli).

## Transfert au fournisseur (phase 3)

La validation de la carte dépose le texte approuvé dans le tchat vitrine du fournisseur et, s'il a relié WhatsApp avec consentement, lui envoie le modèle `maaq_mise_en_relation` (boutons Accepter / Refuser / Question ; message à boutons dans la fenêtre de 24 h). Le fournisseur répond dans son tchat vitrine (`repondre_introduction`, carte à valider car accepter libère son contact) ou par les boutons WhatsApp (même transition, sans passer par kdo_help ; « Question » renvoie au tchat vitrine pour l'écrire). Accepter échange les contacts : l'acheteur reçoit dans coup_de_main le contact choisi sur la vitrine, le fournisseur reçoit le prénom, l'email et le téléphone de l'acheteur ; la mise en relation passe à `connected`. Refuser prévient l'acheteur sans rien transmettre. Une question est transmise à l'acheteur, qui répond par `repondre_fournisseur`. Sans réponse sous 7 jours, le passage périodique fait expirer la demande et prévient l'acheteur ; refusée, expirée ou faite, la vitrine n'est pas reproposée pendant 90 jours.

## Consentement

Réglages › Suggestions de services : interrupteur des suggestions proactives avec le texte de consentement (version `CONSENT_VERSION` enregistrée avec la date), interrupteur « utiliser mon agenda » présent mais inactif (phase ultérieure), catégories coupées. Tout est dans `marketplace_prefs`.

## Traitement périodique

`runMarketplaceJobs` (dans `runDueJobs`) réexamine chaque demande ouverte marquée « me prévenir » contre les vitrines publiées ou reconfirmées depuis le dernier passage, seulement pour les profils qui ont activé les suggestions, et dépose les suggestions dans le tchat de coup_de_main. Ces messages sont à l'initiative de l'agent : ils ne comptent pas dans le plafond quotidien de demandes. Sans modèle local (`LOCAL_AGENTS_MODE=off`), rien ne tourne.

## Ce qui sort du compte

De l'acheteur : seulement le texte approuvé sur la carte, vers le fournisseur. Du fournisseur : les champs de `v_eligible_storefronts` (jamais le contact), vers l'acheteur. Les demandes, suggestions et mises en relation sont exportées avec les données du profil et supprimées avec lui.

## Activer

Même réglage que kdo_help et vitrine (`LOCAL_AGENTS_MODE=anthropic`). L'agent `coup_de_main` est créé par `npm run dev` ou `npm run db:seed`. Pour une démonstration, il faut une vitrine publiée par un autre profil.

## Signalement et administration (phase 4)

Un membre qui trouve une vitrine suggérée trompeuse, déplacée ou abusive le dit à coup_de_main (`signaler_vitrine` : motif parmi description trompeuse, contenu inapproprié, pas un service, publicité, autre, avec ses mots) ; la vitrine est écartée pour lui et un signalement ouvert est créé (`listing_reports`, US-16). Sur Admin › Vitrines (US-17), l'administrateur voit les vitrines par statut, les signalées d'abord, avec pour chacune : les champs visibles par un acheteur (jamais le contact), les signalements à traiter (traité avec suite donnée, ou sans suite), les suggestions faites avec la raison montrée et la raison interne, le journal de mise en relation (y compris les fois où la vitrine a été retenue ou jugée inéligible, avec chaque règle), les mises en relation, et les actions d'administration. Il peut suspendre la vitrine (raison obligatoire, montrée au fournisseur sur « Ma vitrine » et dans son tchat ; hors suggestions jusqu'à la levée) et corriger sa catégorie. Compteurs : vitrines par statut, éligibles par catégorie et par département, suggestions montrées / intérêt / écartées, mises en relation par statut, signalements. Chaque action va dans `admin_audit_log`.

## Pas encore

Calendrier maître (l'agenda de démonstration en tient lieu), notification push, photos, recherche publique, évaluations avec le vrai modèle.
