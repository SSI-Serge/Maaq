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
Les rappels et relances partent d'abord **par notification** sur chaque appareil autorisé du parent ; **par email** s'il n'en a aucun ou si la notification n'est pas partie ; le rappel J-1 est toujours doublé par un email (AF-3). Si seul l'email de J-1 échoue après une notification réussie, la notification n'est pas rejouée.
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
  **Non mesuré avec le vrai modèle** : il faut relancer le banc d'essai (`scripts/assistant-bench.ts`) et ajouter des cas de série avant le pilote.
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
  déplacées une à une. **Non mesuré avec le vrai modèle** (nouveaux cas de tâches à ajouter au banc d'essai) ; **écrans jamais essayés dans un navigateur ni sur téléphone**.

## Réglages
Voir `.env.example`. Tout est facultatif tant que `ASSISTANT_MODE=off`.
```
ASSISTANT_MODE=live
ASSISTANT_PROVIDER=anthropic   # seul fournisseur pour l'instant
ASSISTANT_MODEL=claude-sonnet-5-5
ASSISTANT_EFFORT=medium
ANTHROPIC_API_KEY=
```
La clé se range dans Secret Manager, jamais dans le dépôt ni dans une conversation. Microsoft Foundry est abandonné (D54, pas de Claude en Europe) : le pilote
utilise l'API Anthropic directe ; Claude sur Vertex AI en région européenne sera étudié si le pilote est concluant.

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
5. Informer les familles pilotes que leurs conversations avec l'assistant sont traitées par Anthropic (API directe), et recueillir leur accord écrit : clause du pilote (lot 9).
