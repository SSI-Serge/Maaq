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
| Appel du modèle (API Anthropic) | `src/server/assistant/model.ts` |
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
Les rappels et relances partent d'abord **par notification** sur chaque appareil autorisé du parent ; **par email** s'il n'en a aucun ou si la notification n'est pas partie ; le rappel J-1 suit la même règle depuis le 29/10 (D63) : plus de doublon systématique par email. Les relances US-83 et les emails de sécurité du compte ne changent pas.
- **Clés VAPID** : `npx web-push generate-vapid-keys`, puis `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` (Secret Manager en ligne) et `VAPID_SUBJECT` (`.env.example`). Sans clés, tout reste par email. Une paire de développement est dans le `.env` local, non suivi par Git.
- **Appareils** : table `push_subscriptions` (migration `0011`), rattachée à `devices` ; supprimée à la déconnexion, au changement de mot de passe (autres appareils) et à la révocation d'un appareil. Routes `GET/POST/DELETE /api/push/subscription` et `POST /api/push/test` (notification de test, bouton de l'écran d'activation).
- **Envoi** (`src/server/push/service.ts`, bibliothèque `web-push`) : seules les adresses des services Apple, Google, Mozilla et Microsoft sont acceptées (le serveur appelle l'adresse fournie par l'appareil : liste blanche contre le SSRF). 404 et 410 : abonnement supprimé ; 429, 5xx, réseau : un nouvel essai, sans désinscrire ; 400, 401, 403 : pas de nouvel essai (configuration). Le lieu d'un RDV médical ne figure jamais dans une notification.
- **Service worker** (`public/sw.js`) : reçoit la notification, l'affiche, met à jour le badge (`setAppBadge`) avec le nombre de confirmations en attente porté par chaque notification, et ouvre l'écran concerné au toucher.
- **Écran** `/assistant/rappels` (maquette `RDV-Activer-Rappels`) : s'ouvre à la première visite de l'Assistant sur un appareil qui peut recevoir des notifications, puis un bandeau de l'accueil prend le relais ; « Activer mes rappels » déclenche la demande d'autorisation, jamais avant l'appui. Variantes : iPhone sans installation (« Installer MAAQ d'abord »), iOS avant 16.4, refus, déjà activé (avec notification de test), navigateur sans notifications, serveur sans clés. Lien aussi dans les réglages de l'Assistant.
- **Badge** : `useBadgeSync` (dans `AppShell`) le met à jour à l'ouverture, au retour au premier plan et après une confirmation, un écart ou une annulation ; uniquement sur un appareil qui gère le badge et où les notifications sont autorisées.
Tests : `tests/push.test.ts` (15, envoi simulé), `tests/push-state.test.ts` (8, détection des cas iPhone / Android).
**À vérifier sur un vrai téléphone, en HTTPS** (ce que le navigateur de développement ne permet pas) : l'abonnement réel, la réception, le toucher qui ouvre le bon écran (y compris après le verrouillage de l'application, AF-3), le badge sur iPhone (iOS 16.4 et plus, application installée).
**Tuile du tableau de bord** (US-84 RF6) : l'Assistant n'étant pas un agent du catalogue, sa tuile est fixe, en tête du dashboard, réservée aux deux parents, avec le nombre de confirmations en attente (`FamilyTile`). Solution provisoire : si l'Assistant devient un agent du catalogue (US-106, plateforme anthropic), la tuile passera par les cartes d'agents.

## Dictée d'une demande (US-71, voie rapide)
Un bouton micro à côté du champ de « Nouvelle demande » (`src/client/speech.ts`, `AssistantChat`). Il utilise la reconnaissance vocale du **navigateur** (Chrome sur Android, Safari) : le texte s'écrit en direct dans le champ, le parent le relit et le corrige, puis l'envoie. Seul le texte part au serveur, jamais le son ; une dictée dure 2 minutes au plus. L'origine « dictée » est transmise (`source: "dictation"` dans `POST /api/assistant/messages`), enregistrée avec le message et signalée à l'assistant (`<message source="dictee">`). Le bouton n'apparaît que si le navigateur sait transcrire.
**Limite à connaître :** sur Chrome Android, le navigateur envoie l'audio aux serveurs de Google pour le transcrire : hors du cadre prévu pour le pilote (transcription européenne, audio en mémoire, jamais stocké). À ne pas utiliser avec de vraies données. La voie cible (enregistrement WAV dans le téléphone, transcription Azure Speech par le serveur) remplacera la transcription du navigateur sans changer l'écran ni le circuit « dictée » de l'assistant ; `AZURE_SPEECH_KEY` et `AZURE_SPEECH_REGION` sont déjà dans Secret Manager depuis l'essai voix.
Tests : `tests/speech.test.ts` (assemblage du texte), `tests/assistant.test.ts` (origine de la demande). Pas de test automatique de la reconnaissance : à essayer sur un téléphone.

## Lot 0 du MVP2 : la base suit le schéma de référence (27/10/2026)

La base de MAAQ n'est plus écrite à la main : `db/migrations/0001_socle_lot0.sql` est la copie **telle quelle** du lot 0 de la session « base de données »
(`Base de données/Maaq - BD/migrations/lot_0_2_schema.sql`, SHA-256 `fd4227fe9393…`, 65 tables). Les lots suivants (2 à 8) se copient de la même façon,
dans des fichiers numérotés à la suite, dans l'ordre de `ordre_d_application.txt` (un fichier `_1_valeurs_enumerees` toujours avant son `_2_schema`).
Les migrations « reportées » (US-108, US-111) ne sont pas appliquées au MVP2. `idempotency_keys` et `chat_requests` font partie du schéma ; la réponse mémorisée d'une clé d'idempotence est **chiffrée** (elle peut contenir des données personnelles) et `purge_expired_request_records()` la purge après 24 h. Il n'y a plus de migration propre à l'application : tout ce qu'elle utilise est dans le schéma de référence, dont :
`accounts.grace_reminder_sent_at`, `agent_digitorn_projects` (clé et adresse du projet Digitorn de chaque agent), le texte de
consentement du challenge de contrat, la ligne de l'agent « Assistant Famille » (plateforme `anthropic`) et `assistant_requests` (renvoi d'une demande).

Ce qui a changé dans le code (la base porte les règles, le code les appelle) :
- **Rendez-vous** : statut changé par `change_family_event_status` (transition, historique, auteur, date de confirmation) ; conflits par `find_family_event_conflicts` ;
  empreinte (créneau, type, membres) calculée par le code, la base refuse deux rendez-vous actifs identiques ; titre, lieu et note chiffrés dans `title`, `location`, `note`.
  Un rendez-vous **médical** n'a pas de titre en base : « RDV médical — prénom » est composé à la lecture ; un titre saisi par un parent reste conservé.
  Le code garde ses noms (`canceled`, `ignored`, `work`, `admin`, `typed`…) et les traduit à la frontière (`calendar.ts` : `STATUS_CODE`, `TYPE_CODE`, `SOURCE_CODE`).
- **Membres** : fiche créée avec le profil (déclencheurs), alias par rôle et couleur attribués par la base, naissance en **mois et année** (D54), effacement par
  `anonymize_family_member`. Les invités secondaires ont une fiche (rôle « autre ») que l'assistant ne connaît pas encore. La palette passe à 16 couleurs.
- **Conversation** : `agent_conversations` / `agent_conversation_messages` (4 jours, chiffrés) ; `assistant_requests` relie la demande à sa réponse ; les rendez-vous créés
  se rattachent au message du parent (`source_message_id`).
- **Rappels** : `scheduled_notifications` (clé : rendez-vous, type, destinataire, échéance ; un rendez-vous déplacé a donc de nouveaux rappels). Les rappels valent à partir de la
  dernière modification du rendez-vous. Une réservation sans résultat est reprise au bout de 10 minutes (horloge de la base). Un rendez-vous déplacé ou annulé passe ses envois
  en cours à « annulé » dans la même transaction (décision du PO du 27/10). Fuseau : `accounts.family_timezone`.
- **Notifications web** : adresse et clés chiffrées, empreinte de l'adresse pour la retrouver.
- **Traitements périodiques** : les purges de la base (messages 4 jours, rendez-vous annulés/ignorés 30 jours et passés 24 mois, images, mails bruts, compteurs, journaux).
- Le catalogue et l'administration des agents ne montrent que les agents de plateforme Digitorn (l'Assistant Famille y entrera avec US-106).

Les tests de la famille datent leurs rendez-vous de 2054 (décalage de 28 ans : mêmes jours de la semaine et mêmes changements d'heure) parce que les fonctions de la base
lisent l'horloge réelle : un rendez-vous « à venir » ne doit pas devenir passé avec le temps. `scripts/db-backup.ts` sauvegarde une base avant toute migration.
Base de développement locale : `npm run db:reset` après ce lot (l'ancien schéma n'est pas converti).

## Lot 2 du MVP2 : prévenir l'autre parent quand un RDV est ajouté (US-113)

Migrations copiées de la session « base de données » (`0002_lot2_valeurs_enumerees.sql`, `0003_lot2_schema.sql`). La base porte les règles : `plan_event_notices` réserve
les envois (une ligne par RDV et par destinataire, jamais le demandeur ni celui qui confirme, seulement après la mise en service, réglage personnel respecté),
`revalidate_event_notices` les remet en accord avec l'état du RDV, `shift_to_morning` reporte à 8 h ce qui tombe entre 21 h et 8 h (fuseau de la famille).
`src/server/assistant/notices.ts` envoie les notifications réservées : par notification seulement, jamais par email ; la ligne est verrouillée pendant l'envoi
(deux passages en même temps n'envoient qu'une fois) ; si rien n'est joint, la ligne reste et sera reprise tant que le RDV n'a pas commencé.
- **Tentative immédiate** : après `confirmEvent`, attente de 3 secondes au plus ; sinon le planificateur (toutes les 5 minutes, avant les rappels) envoie.
- **Mise en service** : le réglage de plateforme `event_notice_activation_at` (vide = désactivé) limite la notification aux RDV proposés après la date. À renseigner par
  une requête SQL tant que la console ne le propose pas.
- **Réglage personnel** : `/api/family/personal-settings`, ouvert à tout profil de la famille (invités secondaires compris) ; carte « Mes notifications » en tête de `/assistant/reglages`.
  Les réglages familiaux (délais de rappel) sont lisibles par tout profil et modifiables par les parents seuls.
- Texte : « Camille a ajouté : titre, jeudi 18h00 » ; « À confirmer — Camille a demandé : titre, jeudi 18h00 ». Un RDV médical porte son titre générique, le lieu n'est jamais repris.
- Reste pour les lots suivants : l'avis de l'enregistrement d'office (lot 3, CA 7.2) et les séries (lot 4, CA 9.1).

## Lot 3 du MVP2 : enregistrement sans réponse (AT-8, D49) — livré éteint

Migrations copiées de la session « base de données » (`0004_lot3_valeurs_enumerees.sql`, `0005_lot3_schema.sql`). La base calcule l'échéance (`auto_confirm_at` : le plus petit de
proposition + 72 h et début − 2 h ; vide pour une série, une source hors tchat, un RDV écarté ou proposé moins de 2 h avant son début) et confirme (`auto_confirm_family_events`,
tolérance de 60 minutes, jamais en cas de conflit ou de membre à préciser). `runAutoConfirm` (notices.ts) l'appelle à chaque passage de 5 minutes, **avant** les notifications.
- **Interrupteur** : `AUTO_CONFIRM_MODE=off` par défaut ; `on` met l'enregistrement en service. Éteint, la mention sous le bouton de confirmation et l'avertissement de la seconde relance ne s'affichent pas,
  et un RDV jamais confirmé passe à « Ignoré » à son début comme avant.
- **Avis** : `auto_confirmed` aux deux parents et à la demandeuse (« RDV ajouté automatiquement : titre, jeudi 5 novembre à 18h00 »), par notification puis par email à défaut ; l'invitée secondaire concernée reçoit
  « RDV ajouté au calendrier : … ». Le soir et la nuit, l'avis part à 8 h.
- **Détail du RDV** : « Confirmé par MAAQ (sans réponse) le … » avec la phrase d'explication ; sous le bouton « Confirmer », « Sans réponse de votre part, ce RDV sera ajouté à votre calendrier le … » ou « Ce RDV ne sera jamais ajouté sans votre confirmation » (conflit compris).
- **Seconde relance** : ajoute « Sans réponse de votre part, ce RDV sera ajouté à votre calendrier dans 24 h. » quand l'enregistrement est en service pour ce RDV.
- Reste pour le lot 5 : les tâches proposées passent à « à faire » avec le RDV ; pour le lot 4 : une série jamais confirmée est fermée à sa première séance.

## Lot 4 du MVP2 : RDV récurrents (US-109)

Migration copiée de la session « base de données » (`0006_lot4_schema.sql`). Une **série** est une règle et un modèle ; ses **séances sont de vrais RDV**, créées à l'avance sur 6 mois glissants
(réglage `event_series_horizon_months`) : conflits, rappels et tâches s'appliquent à chacune.
- **Code** : `series.ts` (calcul des dates, libellé de la règle, création, complétion par le planificateur), `series-ops.ts` (présentation, confirmation, annulation et modification avec portée),
  `school-zone.ts`, `scripts/import-school-holidays.ts`. Règles de statut, tout-ou-rien de la confirmation et plafond de 30 séries actives : dans la base.
- **Calcul** : par jours locaux, donc un changement d'heure ne décale pas l'heure locale d'une séance. Chaque semaine (un ou plusieurs jours), toutes les deux semaines, chaque mois le même jour du mois
  (le 31 se replie sur le dernier jour) ou le même jour de la semaine (premier… dernier). Fin : date, nombre de séances tenues (vacances sautées exclues), ou sans fin.
- **Agent** : l'outil `creer_evenement_provisoire` prend une `repetition` structurée (à la place du texte libre `recurrence`) ; les consignes lui font demander « Jusqu'à quand ? » si la fin manque.
  **Mesuré avec le vrai modèle le 27/10/2026** (`scripts/assistant-bench.ts --jeu series --runs 2`, `claude-sonnet-5-5`) : les 10 cas de série (37 à 46) réussis aux deux passages.
- **Confirmation** : « Confirmer le rendez-vous » confirme la série entière (toutes les séances ou aucune) ; les séances en conflit sont comptées et listées (« 3 séances sur 24 »), à garder explicitement. « Ignorer » ferme toute la série.
- **Portée** (formulaire et annulation) : « Cette séance » (reste rattachée, mention « Modifiée »), « Cette séance et les suivantes » (la série est scindée, l'ancienne s'arrête la veille), « Toute la série »
  (les séances modifiées seules ne sont pas touchées). Un RDV provisoire peut devenir une série depuis le formulaire (CA 7.1).
- **Rappels** : une série hebdomadaire n'envoie que J-1 par séance ; toutes les deux semaines et mensuelle suivent les délais du type. **Relance** : une seule, pour la première séance. Notification de l'autre parent :
  une seule pour toute la série (« Camille a ajouté : Foot — Léo, chaque mercredi à 14h00, à partir du 05/11 »). Jamais d'enregistrement sans réponse pour une série ; une série jamais confirmée est fermée au début de sa première séance.
- **Vacances** : `school_holiday_periods` est chargée à la main avec `npx tsx scripts/import-school-holidays.ts --annees 2025-2026,2026-2027,2027-2028` (source : calendrier scolaire de l'Éducation nationale,
  Licence Ouverte ; `--dry-run` pour relire). Couverture constatée le 27/10/2026 : 2025-2026 et 2026-2027 complètes pour les trois zones ; 2027-2028 sans les vacances d'été ; 2028-2029 absente. Convention : `end_date`
  est le jour de la rentrée, la dernière journée de vacances est la veille. La zone se règle dans Réglages (parents), sans zone l'option « Sauf vacances scolaires » n'est pas proposée.
- **Pas encore fait** : alerte de l'administrateur en septembre si l'année scolaire suivante manque ; proposition de saisir l'adresse et d'activer le calcul des trajets à la création (CA 11.1, avec US-107, lot 8) ;
  tâches liées aux séances (fait au lot 5).

## Lot 5 du MVP2 : tâches (US-110, US-95, US-96)

Schéma : `0007_lot5_schema.sql`, copie exacte de `lot_5_2_schema.sql` de la session base de données (SHA-256 `276c1261…`). Les règles vivent dans la base (`change_family_task_status`,
`family_tasks_visible_to`, déclencheurs de plafond, d'échéance et de version, `change_family_event_status` qui promeut les tâches proposées avec le RDV) ; le code les appelle sans les recalculer.

- **Tâche seule ou qui revient** (`tasks.ts`, `task-series.ts`) : titre (100), note (500), échéance (jour de la famille) et heure facultative, personne assignée, répétition (chaque jour, semaine, deux semaines, mois). Les occurrences
  sont de vraies tâches créées 8 semaines à l'avance (jamais dans le passé), complétées par le planificateur ; chacune se coche seule. Modifier ou annuler : « cette fois », « cette fois et les suivantes » (la règle s'arrête la veille, une
  nouvelle série prend le relais), « toutes » ; la règle suit la date déplacée (le mardi décalé au mercredi). 50 règles actives au plus (message de la base traduit). Une règle ne commence jamais avant aujourd'hui.
- **Droits** (AT-2, D26) : les parents font tout ; un invité secondaire voit ses tâches, celles qui lui sont assignées et celles des RDV qu'il voit, coche les siennes, ne modifie que ses créations et n'assigne qu'à lui-même.
  Une tâche assignée à un enfant (sans compte) est suivie par les deux parents et s'affiche « Mia — préparer son sac ».
- **« En retard »** est calculé à l'affichage (jour et heure dans le fuseau de la famille, comme la vue `v_family_tasks`) : mention grise, jamais d'alerte ni de reproche (AT-9). « Faites » : 30 jours ; le cochage s'annule 10 secondes.
- **Tâches préparatoires** (`event-tasks.ts`) : proposées avec le RDV provisoire (statut « proposée », invisibles dans l'écran Tâches), retenues à la confirmation en une transaction ; « Confirmer sans les tâches » les supprime d'abord.
  Chaque ajout, retrait ou changement fait monter la version du RDV : une carte périmée est refusée (`stale_version`, « Mis à jour »). 10 tâches au plus par RDV ; échéance relative (« La veille »…) ou date choisie, jamais passée ni après
  le RDV ; l'écart est conservé si le RDV est déplacé ; annulées avec le RDV (le nombre est rendu : « 2 tâches de préparation ont été retirées »). Pour une série : un modèle par tâche, proposé une fois, une occurrence par séance à la confirmation
  (et pour les séances créées ensuite) ; un RDV devenu série emporte ses tâches proposées ; « cette séance et les suivantes » copie les modèles.
- **Agent** : `creer_evenement_provisoire` prend `taches` (1 à 5, échéance relative ; rien pour un RDV courant ; échéance passée ignorée et signalée au modèle) ; `ajouter_tache_rdv` ; `proposer_tache` (tâche seule ou qui revient : une carte du tchat,
  rien n'est enregistré). RDV médical : trois titres génériques seulement, composés avec le prénom (« Préparer la carte Vitale — RDV médical de Léo »). Le modèle ne reçoit jamais le titre d'une tâche (AT-4, D39).
- **Écrans** : Tâches (`/assistant/taches`), formulaire (`/nouvelle`, `/[id]`), liste « À préparer » sur l'écran du RDV et dans la carte de proposition du tchat (« Confirmer le RDV et N tâches »), cartes « Tâche proposée »
  (Ajouter / Modifier), filtres « Tout / RDV / Tâches » de la vue Jour, nombre de tâches des vues Semaine et Mois, « + Tâche » sur l'accueil.
- **Planificateur** : `completeTaskSeries` à chaque passage ; `purge_expired_family_tasks` avec les purges.
- **Pas fait / à savoir** : notifications « [Prénom] vous a confié… » (US-96 RF4, RF6) et information des parents quand un membre est retiré (RF8) : le type de notification n'existe dans la base qu'au lot 6 ; notification d'annulation
  d'un RDV avec « tâches retirées » : aucun type de notification d'annulation n'existe, le message est affiché à l'annulation. Modifier ou retirer une tâche en l'écrivant à l'agent : impossible sans lui donner le titre des tâches (contraire à AT-4) ;
  seul l'ajout par le tchat est fait. La carte « Tâche proposée » n'est pas conservée par le serveur (la base n'a pas de tâche proposée sans RDV) : elle disparaît quand la conversation est rechargée. « Toutes » réécrit aussi les occurrences
  déplacées une à une. **mesuré avec le vrai modèle le 27/10/2026** : les 14 cas de tâches (47 à 60) réussis aux deux passages, durée médiane 5,9 s, 95e centile 8,9 s ; **écrans essayés dans un navigateur local le 27/10 (tâches, « À préparer », vue Jour, point de la semaine, anticipation), jamais sur téléphone**.

## Lot 6 du MVP2 : rappels de tâches et point de la semaine (US-97, US-98, US-96 RF4/RF6)

Schéma : `0008_lot6_valeurs_enumerees.sql` (4 types de notification) et `0009_lot6_schema.sql`, copies exactes de `lot_6_1` / `lot_6_2` de la session base de données (SHA-256 `45fd0472…` / `061ca5d1…`).
La base ne porte aucune fonction de planification pour ces notifications : MAAQ calcule ce qui est dû et réserve chaque envoi dans `scheduled_notifications` avant d'envoyer (une ligne par envoi, jamais de doublon).

- **Rappel quotidien des tâches** (`task-notices.ts`, US-97) : à 8 h dans le fuseau de la famille, une notification par profil avec ses tâches du jour et celles des 7 derniers jours (réglage `overdue_task_reminder_days`), sans le mot « retard ».
  Comptées : les tâches de son membre ; pour les deux parents, aussi celles sans assigné ou assignées à un enfant. Rien à rappeler, rien d'envoyé. Appareil autorisé : notification ; sinon email quotidien (jamais doublé par email). Un rappel qui n'est pas parti
  avant midi est abandonné pour la journée. « Rappel quotidien des tâches » se désactive pour soi (Réglages ▸ Mes notifications). Le toucher ouvre `/assistant/taches#aujourdhui`.
- **Une heure avant** : une tâche avec une heure d'échéance et non faite rappelle « Dans 1 h : … — Mia » à la personne assignée (si elle a un compte), sinon aux deux parents ; notification seulement.
- **« [Prénom] vous a confié… »** (US-96 RF4, RF6) : à la création, à la réassignation et à la modification, le nouveau membre assigné (compte requis, pas celui qui assigne) est prévenu tout de suite, par notification ou email ; l'ancien ne l'est pas.
- **Point de la semaine** (`digest.ts`, US-98) : chaque profil choisit son jour et son heure (8, 12, 18, 19, 20, 21 h ; dimanche 19 h par défaut) ou le désactive. Une heure avant le premier envoi, le planificateur prépare le résumé de la famille : un appel du modèle léger
  (`ASSISTANT_DIGEST_MODEL`, sinon `ASSISTANT_MODEL`), consignes dans `agent/digest-instructions.md`, qui ne reçoit que des références, jours, moments, types, alias et indicateurs de conflit — jamais un titre, un lieu ni un prénom. Le résumé est conservé chiffré
  avec ses références (`weekly_digests`, 4 semaines) et remplacé à l'affichage selon ce que le lecteur voit. En cas d'échec, le point part quand même, sans résumé. Chaque profil reçoit « Votre semaine est prête : N RDV, M tâches » (ses chiffres, selon sa visibilité) ;
  une semaine calme est envoyée aussi. Un invité secondaire n'a que le résumé de MAAQ et ses propres RDV et tâches, sans questions.
- **Écran** `/assistant/semaine` : Synthèse (fait la semaine passée, résumé, chiffres, bandeau des 7 jours, points d'attention : conflits, tâches sans personne, RDV à confirmer) et Détail jour par jour, puis « Encore ouvert de la semaine passée » sans couleur d'alerte. Chaque ligne ouvre son écran.
  Le point du dernier envoi reste consultable jusqu'au suivant (lien sur l'accueil).
- **Semaine couverte** : le lundi-dimanche qui suit l'envoi (D47 et schéma `week_start`), y compris pour un point réglé au milieu de la semaine . **Tranché par le PO le 27/10/2026** : le point part le dimanche pour la semaine qui démarre ; la US-98 RF7 et le CA 7.1 (« les 7 jours qui suivent ») sont à corriger par la session des user stories.
- **Pas fait** : questions de rappel du point (US-102, lot 7) et RDV rapprochés de moins de 30 minutes (US-107, lot 8) ; information des parents quand un membre est retiré (US-96 RF8) : aucun type de notification pour cela dans la base ; notification de tâches proposées devenues « à faire » à la confirmation d'un RDV.
  **Résumé non mesuré avec le vrai modèle** (le PO l'a demandé « après essai sur des semaines fictives », US-98 RT2) ; **écrans essayés dans un navigateur local le 27/10 (tâches, « À préparer », vue Jour, point de la semaine, anticipation), jamais sur téléphone**.

## Lot 7 du MVP2 : anticipation (US-102, US-111 réduite)

Schéma : `0010_lot7_schema.sql`, copie exacte de `lot_7_2_schema.sql` de la session base de données (SHA-256 `8d2b83a2…`). Pas de fichier de valeurs énumérées pour ce lot. US-108 (suggestions de l'historique) reste reportée : les fichiers `reportee_us108_*` ne sont pas appliqués.

- **Catalogue** (`catalog.ts`, `scripts/load-anticipation-catalog.ts`, `data/catalogue-anticipation.json`) : chargé par l'équipe technique à partir d'un fichier de données (D60) qui a les colonnes et les contrôles de la future console : code unique, libellé de 150
  caractères, âge minimal ≤ âge maximal, situation connue, et pour un rappel médical actif source, date de revue et « validé par » (US-102 RT4, D54), libellé générique, rappel par membre. Le script montre toujours l'aperçu (créés, modifiés avec les champs changés, désactivés,
  inchangés) ; `--appliquer` charge par code, en une seule transaction, sans jamais supprimer : un rappel absent du fichier est désactivé et ses questions sans réponse sont retirées, les réponses données restent. La version d'un rappel monte quand son contenu change.
  Le fichier du dépôt contient 7 rappels non médicaux à relire par l'équipe produit (impôts, taxe foncière, chaudière, rentrée, assurance scolaire, activités, vétérinaire) et le suivi dentaire **désactivé** : aucun contenu médical n'est activé sans la validation du référent santé.
- **Sélection** (`anticipation.ts`) : pour chaque famille, les échéances dont le délai d'anticipation est ouvert au 1er du mois (ou dont la période commence dans le mois) et dont la période n'est pas finie deviennent des questions, une par échéance, membre et période.
  Conditions : situation de la famille (sans réponse, seules les échéances sans condition), rôle et âge du membre (le mois et l'année de naissance sont requis ; sinon une carte les demande), fréquence tous les N ans. La base choisit les 5 questions de la semaine (`pick_weekly_questions`) et réveille les rappels échus ;
  celles restées sans réponse reviennent. Aucun appel au modèle, aucune donnée envoyée à l'agent. Une notification aux parents, « 3 échéances à anticiper ce mois-ci », part quand de nouvelles questions viennent d'être posées.
- **Réponses** : trois choix, atomiques (`answer_anticipation_question`) : « Oui » règle la période, « Non, l'ajouter à mes tâches » crée une tâche seule « À prévoir : … » due à la fin de la période (jamais dans le passé), « Me le rappeler dans 1, 3 ou 6 mois » sans dépasser la période. Parents seulement ; la réponse d'un parent vaut
  pour la famille (l'autre reçoit « déjà traitée »). La question garde le libellé du catalogue avec le repère {membre} : jamais de prénom conservé.
- **Écrans** : section « À anticiper » de l'accueil (parents), « Questions de la semaine » du point de la semaine, cartes « Indiquez le mois et l'année de naissance de Léo… » (« Pas maintenant » gardé sur l'appareil), et Réglages ▸ Anticipation (interrupteur du catalogue, questionnaire « Situation de la famille »).
- **Pas fait / à savoir** : pas de type de notification mensuelle dans la base : l'avis est envoyé directement aux parents qui ont un appareil, sans registre ni email ; le texte de la tâche et de la question est composé par MAAQ à partir du libellé (« Avez-vous prévu : … ? » / « Pensez-vous à : … ? ») : à relire avec l'équipe produit ;
  « Pas maintenant » n'est pas conservé côté serveur. **Décisions du PO du 27/10/2026 (D62)** : le titre « À prévoir : [libellé] » composé par MAAQ est accepté (pas de colonne de titre dans le catalogue) ; l'avis mensuel envoyé directement aux appareils des parents, sans registre ni email, est accepté ; « Pas maintenant » mémorisé sur l'appareil seulement est accepté ; le contenu du catalogue d'amorçage reste à relire par l'équipe produit, et le suivi dentaire reste désactivé tant que le référent santé n'a pas donné sa source, sa date de revue et son « validé par ». **Écrans essayés dans un navigateur local le 27/10, jamais sur téléphone.**

## Lot 8 du MVP2 : trajets et « Sur place » (US-107, US-112) — en cours

Schéma : `0011_lot8_valeurs_enumerees.sql` et `0012_lot8_schema.sql`, copies exactes de `lot_8_1_valeurs_enumerees.sql` / `lot_8_2_schema.sql` de la session base de données (SHA-256 `336bb3b7…` / `16d909b7…`). Appliquées sur une base neuve (12 migrations) et types régénérés ; **pas encore appliquées sur la zone de test** (à faire avec une sauvegarde vérifiée, au moment de livrer le lot).
Le schéma porte les règles : demande de recherche « Sur place » avec plafond de 3 par RDV (hors échecs) et plafond quotidien du profil (`request_place_search`), prise et fin de recherche (`claim_place_search`, `complete_place_search`), recherches bloquées (`fail_stale_place_searches`), consentement à la position par appareil avec journal, dernière position chiffrée de 3 heures au plus, suivi de trajet interdit pour un RDV médical ou sans adresse, purges.

**Fait**
- **Alerte « RDV rapproché »** (US-107 RF1, CA 1.1 et 1.2) : `nearbyOf` (events.ts) cherche, pour un membre commun (ou toute la famille), un autre RDV qui se termine moins de 30 minutes avant (`before`) ou commence moins de 30 minutes après la fin (`after`) ; l'écart est le réglage `travel_gap_alert_minutes`. Pas de chevauchement (c'est un conflit), pas de RDV sur la journée entière, annulé ou ignoré ; vaut pour un RDV médical ; ne demande ni adresse ni position. Affichée en information sur l'écran du RDV, sans empêcher de confirmer. Phrase « commence après » écrite par MAAQ (le texte de la spécification ne donne que « se termine avant ») : à relire. 7 tests.

- **Champ « Adresse »** (US-107 RF2, RF3, RF4, RT2) : le champ « Lieu » du formulaire d'un RDV propose, pendant la saisie, jusqu'à 5 adresses de la recherche d'adresses de l'État (`address.ts`, route `GET /api/family/address?q=`). Le service est la Géoplateforme (`data.geopf.fr/geocodage`), qui a remplacé l'ancienne API Adresse : gratuite, sans clé, hébergée en France, adresses françaises seulement. Elle ne reçoit que le texte tapé, jamais journalisé ; sans réponse, le texte saisi est gardé et l'écran dit qu'il n'y aura pas de suivi du trajet. Choisir une suggestion garde ses coordonnées chiffrées (`location_point`, jamais lues hors du serveur : l'écran sait seulement `placeKnown`). Un texte modifié à la main, un lieu vidé ou un RDV médical les effacent. Pour une série, l'adresse choisie vaut pour toutes les séances à venir. Le lieu n'est réécrit que s'il change, pour ne pas effacer les résultats « Sur place » (la base les rend obsolètes à chaque réécriture). Un RDV médical garde un champ « Lieu » simple, sans suggestions. Un RDV scolaire, professionnel, familial ou personnel sans adresse choisie reçoit la proposition « Ajoutez l'adresse pour suivre votre trajet avant ce RDV » (jamais médical ni administratif, une simple proposition). 16 tests (avec l'alerte). **Écran non vu dans un navigateur ; service d'adresses essayé en vrai.** Pas de limitation de débit propre à cette route : le champ attend 350 ms de pause avant d'interroger.
- **Consentement à la position** (US-107 RF11, RF12, RT3, RT5 ; `location-consent.ts`, routes `/api/family/location-consent` et `/api/family/location`) : propre à chaque appareil. `GET` donne l'état (`none`, `active`, `withdrawn`, `outdated`) et le texte à montrer, celui de la spécification validé par le DPO, version `2026-10` ; `PUT` autorise pour la version montrée (refusé si le texte a changé) ; `DELETE` retire. La base inscrit chaque accord et chaque retrait au journal (appareil, profil, version, cause, conservation 5 ans) ; un appareil révoqué ou supprimé laisse la preuve du retrait ; un texte plus ancien que le courant redemande l'accord. `POST /api/family/location` garde la dernière position (chiffrée, une ligne par appareil, 3 heures au plus, jamais au-delà de la fin du RDV suivi quand `eventId` est donné), refusée (403) sans accord actif. **Aucune route ne la lit** : seul le serveur s'en servira (`readLastPosition`), pour l'estimation du trajet de son propre profil ; jamais lisible par un autre profil ni un autre appareil. Effacée au retrait, à la révocation de l'appareil, à la déconnexion (triggers) et par la purge toutes les 5 minutes (`purge_expired_device_positions`) ; le journal est purgé au-delà de 5 ans. Écrans : `LocationConsentExplainer` (l'explication, avant la demande du téléphone, à réutiliser par l'écran « Suivi du trajet ») et la carte « Position » des Réglages (état, autoriser, retirer avec confirmation). Le téléphone ne demandera son propre accord qu'à la première lecture de la position, sur l'écran de suivi (à écrire). 14 tests. **Écrans jamais vus dans un navigateur ni sur un téléphone.** Reste pour le lot 9 : export et suppression de ces données (US-55, US-56).
- **Suivi du trajet, avec un service interchangeable** (US-107 RF4 à RF13 ; `travel.ts`, `travel-provider.ts`, `travel-format.ts`) : `TRAVEL_MODE` = `off` (par défaut : suivi fermé, rien n'est affiché), `fake` (durées inventées d'après la distance, plus longues aux heures de pointe : pour essayer les écrans et les notifications sans compte, **essais et zone de test seulement**) ou `live` (TomTom, clé `TOMTOM_API_KEY` dans Secret Manager). L'adaptateur TomTom (`calculateRoute`, voiture, `departAt`, avec ou sans trafic) est écrit et testé sur des réponses simulées, **jamais essayé contre le vrai service** (la clé manque) ; le service ne reçoit que deux couples de coordonnées et l'heure.
  - **Interrupteur « Suivre mon trajet »** (`TravelSection`, `PUT/DELETE /api/family/events/[id]/tracking`) : propre à chaque profil, sur un RDV ou sur toute sa série (une séance peut en être écartée) ; désactivé avec l'invitation à choisir l'adresse tant que les coordonnées sont inconnues, absent pour un RDV médical (la base refuse). À l'activation, si l'appareil a autorisé la position, elle est lue et la durée sans trafic est estimée et gardée (seule la durée), affichée « Environ 40 min de route » sous l'interrupteur, pour ce profil seul.
  - **Point de départ** (RF5), dans l'ordre : le lieu du RDV précédent s'il se termine dans les 30 minutes qui précèdent, sinon la dernière position connue (moins de 3 heures), sinon rien (RF10).
  - **Notifications** (`runTravelNotices`, à chaque passage de 5 minutes, RDV confirmés des 36 prochaines heures) : premier calcul = durée estimée + 1 h 30 avant le RDV (1 h 30 sans estimation) : « Ouvrez MAAQ pour suivre votre trajet vers [titre] : départ estimé vers 17h20 », ou « Partez maintenant pour [titre] : 1 h 20 de trajet » si le départ est dans 15 minutes ou moins, ou « Ouvrez MAAQ pour suivre votre trajet vers [titre] » sans origine connue (alors aucun second calcul). Un premier calcul avant 8 h part la veille à 21 h : « Départ conseillé demain vers 8h30, trafic estimé : la prévision sera affinée. » (un premier calcul tard le soir part à son heure : écart avec la spécification, voir plus bas). Second calcul 15 minutes avant l'heure de départ : « Départ conseillé à 17h20 pour [titre] : 40 min de trajet, trafic compris, estimé depuis votre dernière position / le lieu de votre RDV précédent », ou « Trafic plus dense que prévu : partez dès maintenant pour [titre] (55 min de trajet) » si le trajet s'allonge de plus de 10 minutes ; rien si l'écran de suivi a calculé il y a moins de 4 minutes. Une seule notification de chaque sorte par profil et par RDV (index unique de la base), par notification seulement (jamais par email). Le service est interrogé avant la réservation : s'il ne répond pas, rien n'est réservé et le passage suivant, 5 minutes plus tard, réessaie tant que le RDV n'a pas commencé (RF13).
  - **Écran « Suivi du trajet »** (`/calendrier/rdv/[id]/trajet`, `TravelScreen`, `POST /api/family/events/[id]/travel`) : ouvert par la notification ; affiche d'abord l'écran d'explication de la position s'il n'est pas accordé (CA 11.1), puis lit la position et recalcule avec le trafic toutes les 3 minutes tant qu'il est ouvert et visible ; heure de départ conseillée, durée, temps restant, « Vous êtes arrivé » à moins de 5 minutes du lieu (aucune notification), « Partez maintenant », et en cas de panne du service la dernière estimation avec son heure. « Le suivi s'arrête si vous quittez l'application. »
  - 32 tests (`tests/family-travel-notices.test.ts`) pour les critères 4.1 à 14.1 qui ne demandent pas un téléphone. **Écrans jamais vus dans un navigateur ni sur un téléphone ; la lecture réelle de la position (`navigator.geolocation`) n'a jamais tourné.**
  - **Écarts et choix à confirmer** : (1) la spécification dit que le premier calcul tombant « entre 21 h et 8 h » part la veille à 21 h ; pour un RDV du soir même (premier calcul à 22 h), reculer de plusieurs heures n'a pas de sens : seuls les premiers calculs avant 8 h reculent. (2) Les notifications de trajet ne concernent que les RDV confirmés. (3) « Écran ouvert » = un calcul de l'écran date de moins de 4 minutes.
- **« Sur place »** (US-112 RF1, RF4 à RF12, RT1 à RT5 ; `places.ts`, `place-provider.ts`, route `GET/POST /api/family/events/[id]/place`, `PlaceSection`) : même réglage `TRAVEL_MODE` que les trajets (`fake` : adresses inventées, `live` : TomTom, **pas encore écrit** : « Sur place » reste alors fermé). Une demande (`request_place_search`, par la base) vérifie que le RDV est visible, non médical, avec un lieu, à venir, et applique les 3 recherches par RDV hors échecs et le plafond quotidien du profil ; elle est lancée aussitôt en arrière-plan (`after()`), et le planificateur de 5 minutes ne sert que de filet de sécurité (recherche en attente depuis plus de 30 secondes reprise, en cours depuis plus de 120 secondes ou en attente depuis 15 minutes échouée). Le service ne reçoit que le nom du lieu ou son adresse, des coordonnées arrondies à 100 m environ et l'heure du RDV ; MAAQ recalcule la distance à pied (5 km/h) depuis le vrai lieu, garde les adresses à 15 minutes à pied au plus (réglage `place_search_max_walk_minutes`) et ouvertes autour du RDV, et retient 1 ou 2 parkings, 2 « petite faim » et 2 « grande faim ». Le résultat est chiffré (noms, types, villes, distances ; aucune coordonnée, note ni avis), gardé jusqu'à la fin du RDV, effacé (périmé) si l'adresse change ; « Voir les avis » est une adresse de recherche Google Maps (nom et ville). Section « Sur place » du détail : bouton « Où se garer, où manger ? » (« Actualiser », « Réessayer »), « Recherche en cours… » avec mise à jour automatique, résultat avec la date de vérification et « MAAQ ne réserve rien », compteur « Recherches : N sur 3 », messages d'absence d'information, d'échec et de limite. La notification « Où se garer et où manger près de [lieu] : le résultat est prêt. » part après une recherche lancée depuis le bouton ; pas après une demande du tchat. 17 tests. **Écran jamais vu dans un navigateur ni sur un téléphone.**
  - **Tchat et agent** (US-112 RF2, RF3, RF4, CA 2.1, 3.1 à 3.3 ; `conversation.ts`, `PlaceCards`, routes `POST /api/assistant/place-suggestion` et `GET /api/family/place-searches/[id]`) : toute recherche demandée par un parent (bouton, tchat ou suggestion) pose un message « Sur place » dans son tchat (types `place_suggestion` et `place_results`, sans texte, reliés au RDV et à la recherche) : « Je cherche où se garer et où manger près de [lieu]… » avec mise à jour automatique, puis les trois blocs, ou « Je n'ai pas trouvé d'informations fiables près de [lieu]. », ou « La recherche n'a pas abouti. Réessayez plus tard. » avec « Réessayer ». Un invité secondaire n'a pas de tchat : il voit le résultat dans le détail du RDV seulement. **Suggestion** : l'agent renseigne `lieu_public` (« oui » : lieu public identifiable, « doute » : adresse seule, « non » : lieu manifestement privé) en créant un RDV familial ou personnel avec un lieu ; MAAQ pose alors, juste après la réponse de l'agent, « Voulez-vous que je cherche où se garer et où manger près de [lieu] ? » avec « Oui » et « Non, merci », une seule fois par RDV (clé de la table) ; « Non, merci » est mémorisé et l'assistant répond « D'accord. Vous pourrez lancer la recherche depuis le détail du RDV. ». Rien pour un lieu « non », un RDV médical, scolaire, professionnel ou administratif, une série, ni quand le service est fermé. **Demande à l'agent** : l'outil `chercher_sur_place` (identifiant du RDV, retrouvé avec `rechercher_doublon` ou `lister_evenements`) lance la recherche ; le modèle ne reçoit jamais le lieu du RDV ; un refus (3 recherches atteintes, RDV terminé ou médical) lui revient avec son motif. La recherche demandée à l'agent compte dans le plafond quotidien en plus du message du tchat. La notification « le résultat est prêt » ouvre le tchat pour un parent. 14 tests (`tests/family-places-chat.test.ts`), dont deux passages complets par `sendAssistantMessage` avec un faux modèle. **Écrans jamais vus dans un navigateur ni sur un téléphone.**
  - **Pas encore fait pour « Sur place »** : l'adaptateur TomTom de recherche de lieux ; la mention « Recherche lancée » sur un écran de confirmation de type « sortie » (il n'existe pas de type « sortie » dans l'application : la mention est dans la section « Sur place » du détail). **Comportement de l'agent non mesuré avec le vrai modèle** : six cas ajoutés au banc d'essai (61 à 66 : lieu public, adresse seule, « chez Mamie », médical, demande « Où peut-on se garer… », demande près d'un cabinet médical), essayés à vide seulement ; les consignes de l'agent ont changé (nouvelle règle `lieu_public`, nouvel outil) : le jeu de base de 36 cas et celui de séries et tâches sont aussi à relancer.

**Corrections du 28/10/2026 (deux anomalies relevées par le PO sur Android)**
- **Page « This page couldn't load » sur un RDV après une recherche « Sur place »** : la date de vérification d'une recherche (`checked_on`, colonne `date`) était lue par le pilote de base comme une date JavaScript puis convertie en texte (« Wed Oct 28 2026… ») au lieu de « 2026-10-28 » ; l'écran la passait à `shortDate`, qui plantait (`Cannot read properties of undefined (reading 'slice')`), ce qui faisait tomber toute la page du RDV et la carte du tchat. Reproduit en local, corrigé en lisant la colonne en texte (`checked_on::text`) et en n'affichant la date que si elle est au bon format. Les tests de « Sur place » ne regardaient pas ce format (ils acceptaient la date en texte JavaScript) : ils vérifient maintenant « AAAA-MM-JJ » pour la section du RDV, le message « aucune information » et la carte du tchat. Les sections facultatives de l'écran d'un RDV (suivi du trajet, « Sur place ») et les cartes « Sur place » du tchat sont désormais enveloppées (`OptionalSection`) : si leur affichage échoue, seule la section disparaît avec un mot d'explication, et confirmer, modifier ou annuler un RDV continue de fonctionner. Piège à retenir : le pilote de base rend les colonnes `date` en objets Date ; toute date envoyée à l'écran se lit en texte (`::text`).
- **Dictée vocale qui répète les mots et s'arrête trop tôt (Chrome sur Android)** : en mode continu, Android renvoie des résultats cumulatifs (« rendez-vous », « rendez-vous robotique », « rendez-vous robotique demain »…) ; le texte était reconstruit en les ajoutant bout à bout. Il est maintenant reconstruit en entier à chaque événement, un résultat qui prolonge le texte déjà écrit le remplaçant (`assembleTranscript`). Le navigateur coupe aussi une session après quelques secondes de silence : une nouvelle session repart aussitôt à la suite du texte dicté, jusqu'à « Stop », jusqu'aux 2 minutes, ou après 3 sessions de suite sans un mot (`createDictation`). 17 tests avec une fausse reconnaissance vocale. **Jamais vérifié sur un vrai Android** (à refaire par le PO).
- La réponse « L'assistant n'a pas pu traiter votre demande » vue avec la dictée n'avait pas de lien avec le texte : c'était la limite d'usage de la clé Anthropic (erreurs 502 de 21 h 36 à 21 h 50 UTC, le plafond a été relevé ensuite).

**Anomalies 3 et 4 du PO (28/10/2026), après lecture du registre de la zone de test**
- **Notifications « RDV ajouté » (US-113) : pas de défaut de code.** Registre : les 3 RDV créés par l'invitée entre 22 h 54 et 23 h 14 (heure de Paris) ont bien produit une notification pour le PO, envoyée par push à 8 h 01 le lendemain (règle de nuit 21 h – 8 h) ; les 2 RDV créés par le PO (dont « robotique ») n'ont rien envoyé à l'invitée parce qu'**aucun abonnement push n'existe pour son téléphone** : ligne en canal « aucun », statut « sans objet » (jamais d'email pour cette notification, US-113 RT4). Les journaux montrent une seule inscription aux notifications depuis la recréation de la base (le téléphone du PO, 27/10 à 15 h 22 Paris) : l'invitée n'a jamais activé les siennes. Les réglages signalent maintenant, sous l'interrupteur « Être prévenu des RDV ajoutés », qu'un téléphone non autorisé ne recevra rien.
- **Emails** : voir la liste dans le compte rendu à la session des user stories (types, règles de la spécification). Décision du PO sur la sobriété (D63, 29/10) : **le doublon systématique du rappel J-1 est supprimé** (email seulement à défaut de notification). Repli par email codé : rappels J-7 / J-1 / Jour J (à défaut de push), relances 24 h / 48 h, avis d'enregistrement d'office (éteint), rappel quotidien des tâches, tâche confiée, point de la semaine (à défaut de push) ; jamais par email : RDV ajouté / à confirmer (US-113), rappel une heure avant une tâche, trajets, « Sur place », avis mensuel d'anticipation.
- **« Non, l'ajouter à mes tâches » (ex-« Non, à faire ») du catalogue d'anticipation : la tâche existait.** Question « entretien de la chaudière » en statut « tâche créée » (28/10 à 01 h 18 Paris), tâche « À prévoir : … » à faire, échéance le 30/11, source « anticipation ». Elle était invisible : l'écran Tâches ne montre « À venir » que sur 14 jours (US-110 RF6), et cette échéance est à plus d'un mois. Ajout d'une section **« Plus tard »** (tâches seules à faire au-delà de 14 jours, 100 au plus ; les occurrences lointaines d'une tâche qui revient n'y entrent pas), prise en compte dans « Rien à faire pour le moment » et dans « Mes tâches ». Sous les boutons de la question, une ligne explique : « Non » ajoute une tâche à votre liste ; « Oui » clôt la question sans tâche. Le bouton a été renommé « Non, l'ajouter à mes tâches » le 29/10 (D63).

**Décisions D63 (29/10/2026)** : (1) rappel J-1 sans doublon email (`deliver()` dans `reminders.ts` : email seulement si aucune notification n'est partie) ; (2) bouton « Non, à faire » renommé « Non, l'ajouter à mes tâches » dans les trois endroits où la question d'anticipation s'affiche (catalogue, point de la semaine, accueil). Tests adaptés (`push.test.ts`).

**Zone de test** : `TRAVEL_MODE=fake` depuis le 27/10/2026 (révision `maaq-test-00027`). Les durées de trajet y sont inventées d'après la distance. Pour fermer le suivi : `gcloud run services update maaq-test --region europe-west1 --project maaq-test --update-env-vars TRAVEL_MODE=off`.

**À faire, dans cet ordre**
1. ~~Champ « Adresse »~~ (fait, voir ci-dessus).
2. ~~Consentement à la position~~ (fait, voir ci-dessus).
3. ~~Interrupteur, estimations, notifications et écran « Suivi du trajet »~~ (fait avec le faux service). **Reste : brancher TomTom** (compte, clé et déclaration du sous-traitant par le DPO) et l'essayer en vrai. La politique de consentement à la position est décidée (D47, DPO) : texte de la US-107 RF11 validé par le DPO, journal du consentement gardé 5 ans, dernière position chiffrée et gardée 3 heures au plus, jamais d'adresse de domicile.
4. « Sur place » : bouton, recherche en arrière-plan, message du tchat, section du détail, suggestion automatique (US-112). **Bloqué : même service TomTom** (recherche de lieux).
5. Planificateur (recherches bloquées, purges, notifications), export et suppression des données de position (US-55/US-56, lot 9).

Le service de trajets sera derrière une interface (un faux service sert aux tests), de sorte que tout sauf l'appel à TomTom soit prêt avant d'avoir la clé.

## Réglages
Voir `.env.example`. Tout est facultatif tant que `ASSISTANT_MODE=off`.
```
ASSISTANT_MODE=live
ASSISTANT_PROVIDER=anthropic   # seul fournisseur pour l'instant
ASSISTANT_MODEL=claude-sonnet-5-5
ASSISTANT_EFFORT=medium
ASSISTANT_DIGEST_MODEL=         # facultatif : modèle léger du résumé du point de la semaine
ANTHROPIC_API_KEY=
```
La clé se range dans Secret Manager, jamais dans le dépôt ni dans une conversation. Microsoft Foundry est abandonné (D54, pas de Claude en Europe) : le pilote
utilise l'API Anthropic directe ; Claude sur Vertex AI en région européenne sera étudié si le pilote est concluant.

## Vérifier
```
npx tsc --noEmit
npx vitest run tests/assistant.test.ts     # 46 tests, sans clé
npx tsx scripts/assistant-bench.ts --env agent/.env --runs 2     # vrai modèle, environ 1 à 3 $ par passage pour le jeu de base
npx tsx scripts/assistant-bench.ts --env agent/.env --jeu series # seulement les 24 cas de séries et de tâches (--jeu base : les 36 premiers)
```
`agent/.env` n'est jamais suivi par Git (`agent/.gitignore`). Le banc de bout en bout écrit son rapport dans `agent/resultats/`.

**Cas de séries et de tâches** (`agent/tests/cas_series_taches.json`, numérotés 37 à 60, jamais encore passés avec le vrai modèle) : séries (hebdomadaire avec date de fin, sans fin → « Jusqu'à quand ? », réponse à cette question,
deux jours par semaine avec nombre de séances, premier mardi du mois, un samedi sur deux, « sauf vacances » sans zone réglée, série médicale minimisée, demande trop vague, conflit de la première séance) ; tâches d'un rendez-vous
(anniversaire, anniversaire proche sans échéance déjà passée, rendez-vous médical aux trois titres génériques, rendez-vous courant sans tâche, ajout à un rendez-vous existant, retrait d'une tâche encore proposée, tâche déjà
enregistrée intouchable) ; tâches seules (simple, avec heure et personne, qui revient avec ou sans fin, quotidienne, date passée, mail piégé). Le banc contrôle ce que l'agent demande (répétition, fin, jours), ce qui est
enregistré (nombre et titres des tâches, prénoms absents, titres médicaux génériques) et les cartes de tâche. Un cas peut rejouer d'abord un échange avec le vrai modèle (`precedent`) : les cas 39 et 52 dépendent donc aussi
de la réponse de l'étape préalable. Les cas ont été essayés à vide (fausse clé, aucun appel facturé) pour vérifier le décor et les contrôles.

**Passage du 27/10/2026 avec le vrai modèle** (`--jeu tout --runs 2`, 66 cas, coût estimé 3,82 $ pour 132 demandes, soit 0,029 $ par demande) : **interrompu au milieu du second passage par la limite d'usage de la clé Anthropic** (« You have reached your specified API usage limits », accès rétabli le 01/11/2026 à 00:00 UTC) ; 32 demandes ont été refusées en HTTP 400 et ne comptent pas. **Premier passage complet : 64 cas sur 66** ; second passage valable pour les 36 cas de base seulement. Les 30 cas de séries, de tâches et de « Sur place » (37 à 66) ont tous réussi au premier passage, y compris les six cas « Sur place ». Deux cas de base échouent aux deux passages : **22-recurrent** (le RDV hebdomadaire sans date de fin n'est plus créé : l'assistant demande « Jusqu'à quand ? », comme les consignes du lot 4 le lui demandent : le cas date d'avant les séries et sera à réécrire) et **23-question-planning** (la réponse ne mentionne plus « RDV médical » : cause non établie, le rapport ne gardait pas les réponses ; il les garde maintenant). À relancer après le 01/11 : ces deux cas et le second passage des cas 37 à 66.

**Coût dans les journaux** (`src/server/assistant/cost.ts`) : chaque demande à l'assistant écrit une ligne `assistant_turn` avec le modèle, les jetons (neufs, lus du cache, écrits dans le cache, en sortie) et `costUsd`, une
estimation aux tarifs publics du 06/10/2026 (Sonnet 5.5 : 2 $ et 10 $ par million de jetons en entrée et en sortie, lecture du cache 0,20 $, écriture 1,25 fois l'entrée). Le résumé du point écrit une ligne
`assistant_digest` du même genre. Des chiffres seulement, jamais de contenu ; un modèle absent de la table donne `costUsd: null`. La ligne ne porte pas l'identifiant du foyer : le coût par foyer se déduit des heures,
tant que le pilote reste petit. Le rapport du banc d'essai donne maintenant la part neuve, lue et écrite du cache et le coût estimé. La facture de l'API Anthropic fait foi.

## Pour déployer plus tard (rien de fait)
1. Appliquer la migration `0007` sur Supabase, puis relancer `deploy/supabase-securiser.sql` (nouvelles tables).
2. Ranger les clés dans Secret Manager et les passer à Cloud Run avec les réglages `ASSISTANT_*`.
3. L'image Docker embarque désormais `agent/instructions.md` et `agent/outils/` (lus par le backend au démarrage).
4. Une requête de l'assistant peut durer jusqu'à une minute (plusieurs appels du modèle) : vérifier le délai maximal du service Cloud Run.
5. Informer les familles pilotes que leurs conversations avec l'assistant sont traitées par Anthropic (API directe), et recueillir leur accord écrit : clause du pilote (lot 9).
