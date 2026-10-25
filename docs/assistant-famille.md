# Assistant Famille — étape 1 du pilote (noyau de l'agent)

Branche `assistant-famille`, créée à partir de `test`. **Rien n'est déployé ni poussé.** L'assistant est fermé par défaut
(`ASSISTANT_MODE=off`) : sans réglage, MAAQ se comporte exactement comme avant.

## Ce que fait l'étape 1
Un parent écrit un message texte ; MAAQ appelle Claude, exécute lui-même les outils que le modèle demande, et crée des rendez-vous
**provisoires** dans le calendrier familial, que la famille confirmera dans l'application (écrans : étape 2). Le calendrier de référence est
dans la base de MAAQ. Les modifications et annulations ne sont que des propositions (`family_event_proposals`).

Pas encore faits : écrans (saisie, confirmation, calendrier), rappels et notifications, voix, image et PDF, mails entrants, statuts « écarté »
et « ignoré » (D32, la base les prévoit), plafond quotidien, rôle de visibilité par profil (D26), export des données du foyer (US-55)
et traitement d'un invité supprimé (D34 : rendez-vous exclusifs supprimés, partagés anonymisés). **L'export (US-55) doit inclure ces tables avant
la première famille réelle.**

## Où est quoi
| Élément | Fichier |
|---|---|
| Instructions et outils de l'agent (source de vérité, chargés au démarrage) | `agent/instructions.md`, `agent/outils/outils.json` |
| Cas de test et banc d'essai Python de l'agent | `agent/tests/cas_de_test.json`, `agent/banc_essai/` |
| Changements par rapport à l'agent d'origine, décisions du PO | `agent/CHANGEMENTS.md` |
| Tables (membres, événements, propositions, conversations) | `db/migrations/0007_assistant_famille.sql` |
| Pseudonymisation (alias, contacts masqués) | `src/server/assistant/pseudonymize.ts` |
| Heure locale du foyer | `src/server/assistant/local-time.ts` |
| Les huit outils, exécutés par MAAQ | `src/server/assistant/tools.ts` |
| Appel du modèle (Anthropic, Foundry) | `src/server/assistant/model.ts` |
| Boucle de l'agent | `src/server/assistant/agent.ts` |
| Membres du foyer | `src/server/assistant/family.ts` |
| Message d'un parent, historique, idempotence | `src/server/assistant/service.ts` |
| Routes | `POST /api/assistant/messages`, `GET` et `POST /api/family/members` |
| Tests | `tests/assistant.test.ts` (45 tests) et `tests/family-events.test.ts` (29 tests), base réelle |
| Banc d'essai de bout en bout, vrai modèle | `scripts/assistant-bench.ts` |

## Règles du PO appliquées dans le code
- **D31, D37** : le modèle ne voit ni prénom, ni email, ni téléphone ; les personnes sont « Parent N » / « Enfant N », les âges sont des tranches,
  les événements existants n'ont ni titre, ni lieu, ni note. Un rendez-vous médical est rangé avec le titre « RDV médical — [prénom] », sans lieu
  ni note. Les alias reviennent en prénoms dans la réponse **et** dans les paramètres des outils.
- **D35, D39** : six types ; doublon = même jour, membre commun, début à 30 minutes près, objet équivalent (médical : même type), le parent qui écrit
  ou qui transfère étant ajouté d'office aux membres de la recherche ; durée par défaut 1 h ; créneaux alternatifs de 8 h à 20 h.
- **D39** : le modèle cite les rendez-vous par `[[evt-xxxxxxxx]]` ; l'affichage met le titre ; identifiant inconnu = « un rendez-vous » ; médical =
  titre générique.
- **D33** : seuls l'utilisateur principal et l'invité de rang « core » ont accès (403 sinon).
- L'identifiant du foyer ne vient jamais du modèle : il vient de la session. Toutes les lectures et écritures sont filtrées dessus.
- Une même demande (même `requestId`) rend la réponse déjà donnée et ne crée rien de plus.
- Le contenu des messages est chiffré en base (AES-256-GCM, clé de l'application). Les journaux ne contiennent que des métadonnées
  (durée, outils, jetons, identifiants de requête) ; un contrôle signale tout prénom, email ou téléphone parti chez le modèle.

## Étape 2, partie serveur : cycle de vie des rendez-vous (US-74 à US-80)
Le serveur sait lister, consulter, confirmer, modifier, écarter et annuler les rendez-vous du calendrier familial, avec les droits de D26.
Les écrans sont décrits dans la section suivante.

| Route | Rôle |
|---|---|
| `GET /api/family/events?from=&to=` | Rendez-vous visibles par le profil sur la période (provisoires, confirmés, écartés), avec les rendez-vous en conflit |
| `GET /api/family/events/pending` | Confirmations en attente du profil (provisoires à venir qu'il peut traiter ; sans les écartés) |
| `GET /api/family/events/[id]` | Détail, conflits et créneaux alternatifs (3 au plus, entre 8 h et 20 h, les plus proches du créneau demandé) |
| `PATCH /api/family/events/[id]` | Modifier un provisoire ou un confirmé (corps : champs du formulaire, `version`, `allowConflict`) |
| `POST /api/family/events/[id]/confirm` | Confirmer, ou « Confirmer quand même » un rendez-vous écarté |
| `POST /api/family/events/[id]/set-aside` | Ignorer : le rendez-vous est écarté (gris, barré) |
| `POST /api/family/events/[id]/cancel` | Annuler un rendez-vous confirmé |

Règles : version numérotée par rendez-vous (une modification fondée sur une version dépassée est refusée, « modifié entre-temps ») ; confirmation atomique
(deux parents au même instant : une seule confirmation, l'autre voit « déjà traité par … ») ; conflit revérifié à la confirmation (409 avec les conflits et
les créneaux alternatifs, `allowConflict` pour passer outre) ; un provisoire est passé à son heure de début, un confirmé quand il est terminé ; historique de
chaque changement (auteur, date) dans `family_event_history` ; titre, lieu et note chiffrés en base (migration `0008`) ; une couleur par membre.
L'expiration automatique des rendez-vous écartés ou jamais confirmés est faite (étape 3a). Reste à construire : les notifications aux autres profils.

### Membres de la famille (US-92, US-93)
| Route | Rôle |
|---|---|
| `GET /api/family/members` | `{ members, removed, max }` : membres actifs (badge, couleur, nombre de RDV à venir) et membres retirés non effacés |
| `POST /api/family/members` | Ajouter un membre sans compte (prénom, date de naissance facultative) |
| `PATCH /api/family/members/[id]` | Modifier ; pour un membre relié à un profil, la date seule (le prénom suit le profil) |
| `POST /api/family/members/[id]/remove` | Retirer : archivé (`archived_at`), ses RDV gardent son prénom, pas de restauration |
| `POST /api/family/members/[id]/erase` | Effacer définitivement (D34) : RDV du seul membre supprimés, RDV partagés sous « Ancien membre », prénom et naissance effacés |

Règles : prénom de 30 caractères au plus et unique parmi les membres actifs (casse et accents ignorés) ; 12 membres actifs au plus ; date de naissance non future ; couleur d'un membre retiré réattribuable ; un membre relié à un profil ne se retire ni ne s'efface ici ; un membre retiré n'est plus proposé pour un RDV (il peut rester sur ceux où il figure) ni reconnu par l'assistant, mais son alias reste traduit dans les textes existants. Migration `0009`.
Non fait : choix du rôle « Parent / Autre » à l'ajout (à confirmer par le PM), lecture seule pour les invités secondaires (l'Assistant reste réservé aux deux parents), retrait automatique d'un membre à la suppression de son invité (US-20), effacement des images et mails liés (RT3 d'US-93 : ces contenus n'existent pas encore).

Code : `src/server/assistant/events.ts` (cycle de vie), `calendar.ts` (lecture, conflits), `fields.ts` (chiffrement), `family.ts` (membres) ; tests : `tests/family-events.test.ts`, `tests/family-members.test.ts`.

## Étape 2, écrans (d'après les maquettes)
Onglet **Calendrier** ajouté à la barre de navigation (l'onglet Agents reste actif sur `/assistant`). Composants dans `src/components/family/`.

| Page | Écran | Contenu |
|---|---|---|
| `/assistant` | Accueil de l'Assistant Famille | Confirmations en attente, prochains rendez-vous, accès à la saisie et au calendrier |
| `/assistant/demande` | Nouvelle demande | Tchat : historique des 4 derniers jours, envoi d'un texte, lien « Voir la proposition de RDV », « Réessayer » sans doublon (identifiant de demande) |
| `/calendrier` | Calendrier familial | Vue semaine ou mois, légende des membres (filtre), « Aujourd'hui », bornes 12 mois passés / 24 mois à venir |
| `/calendrier/jour/[date]` | Vue Jour | Rendez-vous rangés par période (matin, midi, après-midi, soir) |
| `/calendrier/rdv/[id]` | Détail et confirmation | Conflit en phrase, créneaux alternatifs, confirmer / modifier / écarter / annuler, messages de succès des US-75 à US-80 |
| `/assistant/reglages` | Réglages de l'Assistant | Délais de rappel par type de RDV (six types, J-7 / J-1 / Jour J), lien vers les membres |
| `/assistant/rappels` | Activer mes rappels | Autorisation des notifications sur cet appareil (US-94) |
| `/assistant/membres` | Membres de la famille | Liste avec badges et couleurs, ajouter / modifier / retirer / effacer définitivement, section repliée « Membres retirés » (lien depuis l'accueil de l'Assistant) |

Pas encore d'écran : notifications aux autres profils, adresse de transfert des mails.

Données de démonstration pour voir les écrans en local (foyer de Camille, Léo et Mia, 13 rendez-vous dont un conflit, un écarté et une journée chargée) :
```
npm run db:seed
npx tsx scripts/assistant-demo.ts
```
Tests : `tests/family-format.test.ts` (dates, semaines, grille du mois) ; le comportement serveur est couvert par `tests/family-events.test.ts` et `tests/assistant.test.ts`.

## Étape 3a : rappels et relances par email (US-81, US-82, US-83)
Les rappels et relances partent **par email aux deux parents** (utilisateur principal et invité 1) ; les notifications web et le badge de l'icône sont le lot 3b (US-94, US-84).
Un passage du planificateur (toutes les 5 minutes, `src/instrumentation.ts` ou `POST /api/cron/run`) fait, dans `src/server/assistant/reminders.ts` :
1. passer à « Ignoré » (motif « sans réponse », changement du système) un RDV provisoire arrivé à son début, et un RDV écarté arrivé à la relance suivante prévue, ou 24 h après s'il n'en reste plus ;
2. envoyer le rappel dû de chaque RDV confirmé : J-7 à 9 h, J-1 à 18 h, jour J à 7 h 30 (2 h avant si le RDV commence avant 9 h 30), dans le fuseau du foyer (appareil de l'utilisateur principal) ;
3. envoyer la relance due de chaque RDV provisoire : 24 h puis 48 h après sa création, décalée à 8 h si elle tombe entre 21 h et 8 h.

Les échéances ne sont pas enregistrées, elles sont recalculées à chaque passage ; seuls les envois le sont (`family_notifications`, clé unique RDV + échéance + destinataire, réservation reprise au bout de 10 minutes). Conséquences, choisies par l'équipe de dev :
- un rappel manqué est rattrapé tant que le RDV n'a pas commencé, mais **un seul** : le plus récent dû (après un long incident, J-7 n'a plus de sens si J-1 est arrivé) ; idem pour les relances ;
- un rappel dont l'échéance précède la confirmation (`reminders_from`) est « Non applicable » ; un changement d'horaire remet ce point de départ à zéro et efface les envois déjà faits, donc les rappels de la nouvelle date repartent ;
- un rappel réactivé dans les réglages après son échéance n'est pas rattrapé ;
- le lieu d'un RDV médical ne figure jamais dans un email de rappel (D31) ;
- un RDV provisoire modifié par un parent n'est plus relancé (US-83 RF5, à confirmer avec le BA) ;
- les RDV ignorés sont supprimés 30 jours après (US-77 RT1).
Réglages par type (`family_reminder_settings`, sans ligne : tout actif) : `GET` et `PATCH /api/family/reminder-settings`, page `/assistant/reglages` ; lecture seule pour les invités secondaires prévue par la US-82, mais l'Assistant reste réservé aux deux parents. Le détail d'un RDV confirmé affiche l'état de chaque rappel (Envoyé, Prévu, Non applicable, Désactivé) et celui d'un RDV provisoire la dernière relance.
Tests : `tests/family-reminders.test.ts` (29). Migration `0010`. Pour un vrai envoi il faut `MESSAGING_MODE=smtp` ; le déploiement de test envoie dans la boîte de test.

## Étape 3b : notifications web et badge (US-94, US-81 RF6, US-84) — vérifié en local, pas sur iPhone
Les rappels et relances partent d'abord **par notification** sur chaque appareil autorisé du parent ; **par email** s'il n'en a aucun ou si la notification n'est pas partie ; le rappel J-1 est toujours doublé par un email (AF-3). Si seul l'email de J-1 échoue après une notification réussie, la notification n'est pas rejouée.
- **Clés VAPID** : `npx web-push generate-vapid-keys`, puis `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (Secret Manager en ligne) et `VAPID_SUBJECT` (`.env.example`). Sans clés, tout reste par email. Une paire de développement est dans le `.env` local, non suivi par Git.
- **Appareils** : table `push_subscriptions` (migration `0011`), rattachée à `devices` ; supprimée à la déconnexion, au changement de mot de passe (autres appareils) et à la révocation d'un appareil. Routes `GET/POST/DELETE /api/push/subscription` et `POST /api/push/test` (notification de test, bouton de l'écran d'activation).
- **Envoi** (`src/server/push/service.ts`, bibliothèque `web-push`) : seules les adresses des services Apple, Google, Mozilla et Microsoft sont acceptées (le serveur appelle l'adresse fournie par l'appareil : liste blanche contre le SSRF). 404 et 410 : abonnement supprimé ; 429, 5xx, réseau : un nouvel essai, sans désinscrire ; 400, 401, 403 : pas de nouvel essai (configuration). Le lieu d'un RDV médical ne figure jamais dans une notification.
- **Service worker** (`public/sw.js`) : reçoit la notification, l'affiche, met à jour le badge (`setAppBadge`) avec le nombre de confirmations en attente porté par chaque notification, et ouvre l'écran concerné au toucher.
- **Écran** `/assistant/rappels` (maquette `RDV-Activer-Rappels`) : s'ouvre à la première visite de l'Assistant sur un appareil qui peut recevoir des notifications, puis un bandeau de l'accueil prend le relais ; « Activer mes rappels » déclenche la demande d'autorisation, jamais avant l'appui. Variantes : iPhone sans installation (« Installer MAAQ d'abord »), iOS avant 16.4, refus, déjà activé (avec notification de test), navigateur sans notifications, serveur sans clés. Lien aussi dans les réglages de l'Assistant.
- **Badge** : `useBadgeSync` (dans `AppShell`) le met à jour à l'ouverture, au retour au premier plan et après une confirmation, un écart ou une annulation ; uniquement sur un appareil qui gère le badge et où les notifications sont autorisées.
Tests : `tests/push.test.ts` (15, envoi simulé), `tests/push-state.test.ts` (8, détection des cas iPhone / Android).
**À vérifier sur un vrai téléphone, en HTTPS** (ce que le navigateur de développement ne permet pas) : l'abonnement réel, la réception, le toucher qui ouvre le bon écran (y compris après le verrouillage de l'application, AF-3), le badge sur iPhone (iOS 16.4 et plus, application installée).
**Tuile du tableau de bord** (US-84 RF6) : l'Assistant n'étant pas un agent du catalogue, sa tuile est fixe, en tête du dashboard, réservée aux deux parents, avec le nombre de confirmations en attente (`FamilyTile`). Solution provisoire : si l'Assistant devient un agent du catalogue (US-106, plateforme Foundry), la tuile passera par les cartes d'agents.

## Dictée d'une demande (US-71, voie rapide)
Un bouton micro à côté du champ de « Nouvelle demande » (`src/client/speech.ts`, `AssistantChat`). Il utilise la reconnaissance vocale du **navigateur** (Chrome sur Android, Safari) : le texte s'écrit en direct dans le champ, le parent le relit et le corrige, puis l'envoie. Seul le texte part au serveur, jamais le son ; une dictée dure 2 minutes au plus. L'origine « dictée » est transmise (`source: "dictation"` dans `POST /api/assistant/messages`), enregistrée avec le message et signalée à l'assistant (`<message source="dictee">`). Le bouton n'apparaît que si le navigateur sait transcrire.
**Limite à connaître :** sur Chrome Android, le navigateur envoie l'audio aux serveurs de Google pour le transcrire : hors du cadre prévu pour le pilote (transcription européenne, audio en mémoire, jamais stocké). À ne pas utiliser avec de vraies données. La voie cible (enregistrement WAV dans le téléphone, transcription Azure Speech par le serveur) remplacera la transcription du navigateur sans changer l'écran ni le circuit « dictée » de l'assistant ; `AZURE_SPEECH_KEY` et `AZURE_SPEECH_REGION` sont déjà dans Secret Manager depuis l'essai voix.
Tests : `tests/speech.test.ts` (assemblage du texte), `tests/assistant.test.ts` (origine de la demande). Pas de test automatique de la reconnaissance : à essayer sur un téléphone.

## Réglages
Voir `.env.example`. Tout est facultatif tant que `ASSISTANT_MODE=off`.
```
ASSISTANT_MODE=live
ASSISTANT_PROVIDER=anthropic   # anthropic (tests) ou foundry (pilote)
ASSISTANT_MODEL=claude-sonnet-5-5
ASSISTANT_EFFORT=medium
ANTHROPIC_API_KEY=             # ou FOUNDRY_RESOURCE + FOUNDRY_API_KEY
```
Les clés se rangent dans Secret Manager, jamais dans le dépôt ni dans une conversation. Avec Foundry, la ressource du pilote est
`assistant-famille-pilot-resource` (East US 2) ; le quota de `claude-sonnet-5-5` est à demander à Microsoft.

## Vérifier
```
npx tsc --noEmit
npx vitest run tests/assistant.test.ts     # 46 tests, sans clé
npx tsx scripts/assistant-bench.ts --env agent/.env --runs 2     # vrai modèle, environ 1 à 3 $ par passage
```
`agent/.env` n'est jamais suivi par Git (`agent/.gitignore`). Le banc de bout en bout écrit son rapport dans `agent/resultats/`.

## Pour déployer plus tard (rien de fait)
1. Appliquer la migration `0007` sur Supabase, puis relancer `deploy/supabase-securiser.sql` (nouvelles tables).
2. Ranger les clés dans Secret Manager et les passer à Cloud Run avec les réglages `ASSISTANT_*`.
3. L'image Docker embarque désormais `agent/instructions.md` et `agent/outils/` (lus par le backend au démarrage).
4. Une requête de l'assistant peut durer jusqu'à une minute (plusieurs appels du modèle) : vérifier le délai maximal du service Cloud Run.
5. Informer les familles pilotes que Foundry en East US 2 traite les conversations aux États-Unis, et recueillir leur accord écrit (brief du 25 octobre).
