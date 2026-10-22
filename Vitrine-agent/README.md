# Vitrine-agent

Documentation de l'agent **vitrine** (rubrique Pro) : la vitrine de service d'un fournisseur, créée par la conversation, à l'oral ou à l'écrit, puis relue et publiée depuis la fiche de l'agent. Première brique du marketplace silencieux ([docs/specs/MAAQ_Marketplace_Silencieux_Plan.md](../docs/specs/MAAQ_Marketplace_Silencieux_Plan.md), phase 1 : US-01 à US-06, US-13).

Le code vit dans l'application, comme pour kdo_help :

| Dossier | Rôle |
|---|---|
| `src/server/marketplace/` | Modèle (champs, provenance, règles de publication, département, aperçu acheteur), magasins (base et mémoire), service de l'écran de relecture |
| `src/server/agents/vitrine.ts`, `vitrine-tools.ts` | Texte système, contexte, outils de l'agent |
| `src/app/api/storefront/*` | Lecture, modification, confirmation, publication, pause, indisponibilité |
| `src/components/marketplace/StorefrontReview.tsx` | Écran « Ma vitrine » sur la fiche de l'agent (Catalogue › vitrine) |
| `src/client/speech.ts`, `src/components/chat/ChatScreen.tsx` | Dictée dans le tchat (reconnaissance vocale du navigateur, aucun son envoyé) |
| `db/migrations/0008_marketplace.sql` | Tables `storefronts`, `service_categories`, `marketplace_prefs`, vue `v_eligible_storefronts` |
| `tests/marketplace.test.ts` | Règles, magasins, service, agent avec faux modèle |

## Ce que fait l'agent

- **Extraction sans invention.** Le fournisseur décrit son activité ; l'agent enregistre ce qui est dit (`enregistrer_dits`) et, à part, ce qu'il propose lui-même (`proposer_champs`) : catégorie déduite, description rédigée, disponibilité « à convenir » par défaut. « Je peux me déplacer le samedi » reste un déplacement « le samedi seulement ».
- **Provenance de chaque groupe de champs.** `stated` (dit), `proposed` (proposé par l'agent, à confirmer), `confirmed` (relu et approuvé). Un groupe proposé bloque la publication ; les groupes critiques (zone, tarif s'il y en a un, contact) doivent être confirmés après relecture (`confirmer_champs`, uniquement après un « oui » explicite). Modifier une valeur lui fait perdre sa confirmation.
- **Questions une à la fois**, dans l'ordre : nom affiché, services, zone (ville, code postal, chez soi / déplacement / à distance), disponibilité, contact. Tarif facultatif, affiché « Sur devis » s'il manque.
- **Publication hors du tchat.** L'agent n'a pas d'outil de publication : le bouton Publier est sur l'écran « Ma vitrine », qui montre chaque champ avec sa provenance, ce qui manque, l'aperçu côté acheteur, et permet de modifier une ligne sans recommencer la conversation.
- **Pause et indisponibilité.** `mettre_en_pause` (vitrine publiée seulement), `indisponible_jusquau` (date future), dans le tchat comme sur l'écran.
- **Reprise.** La vitrine vit en base dès le premier mot : quitter et revenir, passer de la voix au texte, ou changer d'appareil ne perd rien.

## Ce qui sort du compte

Une vitrine n'est lisible hors du compte du fournisseur qu'une fois `published`, et seulement par la vue `v_eligible_storefronts` : nom, catégorie, services, description, zone approximative (code postal, ville, modes), disponibilité, tarif. Jamais l'adresse ni le contact : celui-ci est chiffré (`contact_value_encrypted`, clé `ENCRYPTION_KEY`) et ne sera révélé qu'après une mise en relation acceptée (phase 3). La vitrine est exportée avec les données du profil et supprimée avec lui.

## Activer

Même réglage que kdo_help (`LOCAL_AGENTS_MODE=anthropic`, voir [Kdo-agent/agents-locaux.md](../Kdo-agent/agents-locaux.md)). L'agent `vitrine` est créé par `npm run dev` ou `npm run db:seed` ; en ligne, l'administrateur le met à disposition depuis la console.

## Dictée

Le bouton micro du tchat utilise la reconnaissance vocale du navigateur (Chrome, Android, Safari récent) : le texte reconnu remplit le champ de saisie, corrigeable avant envoi ; aucun enregistrement n'est conservé ni envoyé. Sans reconnaissance disponible, le bouton n'apparaît pas et le texte fonctionne à l'identique. Les messages vocaux WhatsApp ne sont pas transcrits.

## Côté acheteur

La suggestion d'une vitrine à un membre, la carte de mise en relation et le message reçu dans ce tchat (« Nouvelle demande de mise en relation pour votre vitrine… ») sont décrits dans [Coup-de-main-agent/README.md](../Coup-de-main-agent/README.md) (phase 2).

## Pas encore

Réponse du fournisseur à une mise en relation et échange des coordonnées (phase 3 du plan), photos, recherche publique, transcription côté serveur, évaluations avec le vrai modèle.
