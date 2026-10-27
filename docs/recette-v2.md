# Recette de la vague V2 — Assistant Famille (MVP2, lots 4 à 6)

Préparé le 27/10/2026. Zone de test : https://test.maaq.fr (révision `maaq-test-00022`, 10 migrations appliquées, aucune différence avec le schéma de référence).

## 1. Ce que contient la vague V2

| Lot | Histoires | Ce que la famille peut faire |
|---|---|---|
| 4 | US-109 | Créer un RDV qui revient (chaque semaine, toutes les deux semaines, chaque mois), le confirmer d'un coup, modifier ou annuler « cette séance », « cette séance et les suivantes » ou « toute la série ». |
| 5 | US-110, US-95, US-96 | Créer des tâches seules ou qui reviennent ; voir les tâches à préparer proposées avec un RDV ; assigner une tâche à un membre. |
| 6 | US-97, US-98, US-96 (suite) | Être rappelé des tâches (chaque matin à 8 h, une heure avant) ; être prévenu qu'on vous a confié une tâche ; recevoir « Votre semaine est prête » avec l'écran Point de la semaine. |

La zone de test porte aussi le lot 7 (questions d'anticipation). Il ne fait pas partie de cette recette : il sera recetté avec la vague V3.

## 2. État avant la recette

**Vérifié par la machine** : 654 tests automatiques réussis, compilation et contrôle du code sans erreur, construction de l'application réussie, schéma de la zone de test identique aux migrations de la session base de données.

**Essayé par moi dans un navigateur local le 27/10** : création et cochage d'une tâche (la tâche passe dans « Faites »), liste « À préparer » et bouton « Confirmer le RDV et 1 tâche » (la tâche passe « à faire »), vue Jour avec ses filtres, écran Point de la semaine.

**Jamais essayé** (c'est l'objet de la recette) :
- sur un téléphone, quel qu'il soit : réception des notifications, toucher sur une notification, installation de l'application ;
- les cartes du tchat avec le vrai assistant (tâches proposées, RDV qui revient) ;
- le formulaire de répétition d'un RDV et le choix « cette séance / les suivantes / toute la série » ;
- le résumé du point de la semaine avec le vrai modèle (jamais produit) ;
- le mode sombre.

**Réglages de la zone de test à connaître** : assistant actif ; planificateur toutes les 5 minutes ; l'enregistrement d'office après 72 h de silence est **éteint** (rien n'est confirmé sans réponse) ; le modèle léger du résumé n'est pas choisi (le résumé utilise le modèle principal).

## 3. Préparation (10 minutes)

1. Une famille de test avec **deux parents** (deux profils sur deux appareils), **un invité secondaire** et **un enfant sans compte**.
2. Notifications autorisées sur au moins un téléphone par parent (application installée sur l'écran d'accueil sur iPhone). Un parent sans appareil sert à vérifier le repli par email.
3. Réglages ▸ zone de vacances scolaires renseignée par un parent (sans elle, « Sauf vacances scolaires » n'est pas proposé). Les vacances 2025-2026 et 2026-2027 sont chargées ; 2027-2028 n'a pas l'été.
4. Réglages ▸ Mes notifications : rappel quotidien des tâches et point de la semaine activés.

## 4. Scénarios

Chaque ligne se coche « oui / non / à revoir ». Les cases « Sur téléphone » ne peuvent pas être remplacées par un essai sur ordinateur.

### A. RDV qui reviennent (US-109)

| # | Faire | Résultat attendu |
|---|---|---|
| A1 | Écrire à l'assistant : « Foot de Léo chaque mercredi à 14h » (sans date de fin). | L'assistant demande « Jusqu'à quand ? ». |
| A2 | Répondre « jusqu'à Noël ». | Une carte propose la série avec sa règle écrite en clair. |
| A3 | Confirmer. | Toutes les séances des 6 prochains mois entrent au calendrier ; s'il y a des conflits, ils sont comptés (« 3 séances sur 24 ») et listés, à garder explicitement. |
| A4 | Modifier **une** séance (heure). | Elle porte la mention « Modifiée » ; les autres ne bougent pas. |
| A5 | Modifier « cette séance et les suivantes » (nouvelle heure). | Les séances avant restent à l'ancienne heure, les suivantes changent. |
| A6 | Modifier « toute la série » (lieu), après A4. | Toutes changent **sauf** la séance modifiée seule en A4. |
| A7 | Annuler une séance, puis annuler « les suivantes ». | Les séances disparaissent du calendrier ; la précédente reste. |
| A8 | Créer une série « chaque mercredi, sauf vacances scolaires ». | Aucune séance pendant les vacances de la zone. |
| A9 | Sur l'autre parent : regarder les notifications. | **Une seule** notification pour toute la série (« Camille a ajouté : Foot — Léo, chaque mercredi à 14h00… »). Sur téléphone. |
| A10 | La veille d'une séance. | Un seul rappel (J-1) pour une série hebdomadaire. Sur téléphone. |
| A11 | Créer une série et ne pas la confirmer ; toucher « Ignorer ». | Toute la série passe à « Ignoré ». |

### B. Tâches (US-110)

| # | Faire | Résultat attendu |
|---|---|---|
| B1 | Tâches ▸ « + Tâche » : titre, échéance demain, heure, assignée à l'autre parent. | La tâche apparaît dans « À venir » avec la couleur de la personne. |
| B2 | Cocher une tâche du jour. | Elle passe dans « Faites » (« Faite par … ») ; le lien « Annuler » reste proposé 10 secondes. |
| B3 | Créer une tâche « chaque semaine ». | Les prochaines fois existent déjà (8 semaines) ; chacune se coche seule. |
| B4 | Modifier « cette fois » / « cette fois et les suivantes » / « toutes ». | Mêmes règles que pour les RDV ; « toutes » respecte une occurrence modifiée seule. |
| B5 | Avoir une tâche dont l'échéance est passée. | Mention grise « En retard », sans rouge ni message de reproche. |
| B6 | Invité secondaire : ouvrir Tâches. | Il ne voit que ses tâches, celles qui lui sont assignées et celles des RDV qu'il voit ; il n'assigne qu'à lui-même. |
| B7 | Vue Jour : filtres « Tout / RDV / Tâches ». Vues Semaine et Mois. | Les tâches apparaissent, avec leur nombre dans Semaine et Mois. |

### C. Tâches à préparer d'un RDV (US-95)

| # | Faire | Résultat attendu |
|---|---|---|
| C1 | Écrire : « RDV chez le dentiste pour Léo jeudi à 10h ». | Carte de proposition avec une liste « À préparer » : titres génériques composés avec le prénom (« Préparer la carte Vitale — RDV médical de Léo »). |
| C2 | Retirer une tâche, en modifier une, en ajouter une. | La carte se met à jour ; au plus 10 tâches par RDV. |
| C3 | Toucher « Confirmer le RDV et N tâches ». | Le RDV est confirmé ; les tâches passent « à faire » (visibles dans Tâches). |
| C4 | Autre RDV : « Confirmer sans les tâches ». | Aucune tâche ne reste. |
| C5 | Déplacer le RDV confirmé. | Les tâches gardent leur écart avec le RDV (« la veille » reste la veille). |
| C6 | Annuler le RDV. | Message « N tâches de préparation ont été retirées ». |
| C7 | Ouvrir la carte d'un RDV sur deux appareils, modifier sur l'un, confirmer sur l'autre. | L'autre voit « Mis à jour » et doit recharger. |
| C8 | Écrire à l'assistant de retirer une tâche déjà enregistrée. | Réponse polie qui renvoie vers l'écran Tâches (l'assistant ne voit pas les titres). |

### D. Assignation (US-96)

| # | Faire | Résultat attendu |
|---|---|---|
| D1 | Assigner une tâche à l'autre parent, puis à l'enfant, puis à personne. | Appui sur le nom pour réassigner ; la tâche de l'enfant s'affiche « Mia — préparer son sac » chez les deux parents. |
| D2 | Côté destinataire : notification. | « Camille vous a confié … ». Pas de notification à l'ancien assigné, ni à celui qui assigne. Sur téléphone. |
| D3 | Retirer un membre de la famille. | Ses tâches restent, non assignées. (L'information des parents n'est pas faite : voir § 6.) |

### E. Rappels de tâches (US-97)

| # | Faire | Résultat attendu |
|---|---|---|
| E1 | Avoir une tâche du jour et une tâche des derniers jours, non faites. | À 8 h (heure de la famille) une notification récapitule, **sans** le mot « retard ». Toucher ouvre la section « Aujourd'hui ». Sur téléphone. |
| E2 | Une tâche à heure précise, non faite. | « Dans 1 h : … » à la personne assignée (sinon aux deux parents). Notification seulement. Sur téléphone. |
| E3 | Parent sans appareil autorisé. | Il reçoit le récapitulatif quotidien par email, une seule fois. |
| E4 | Rien à rappeler. | Aucun message envoyé. |
| E5 | Réglages ▸ Mes notifications : désactiver le rappel quotidien. | Plus de rappel pour ce profil seulement. |

### F. Point de la semaine (US-98)

| # | Faire | Résultat attendu |
|---|---|---|
| F1 | Avoir des RDV et des tâches la semaine suivante. | Le dimanche à 19 h (par défaut) chaque profil reçoit « Votre semaine est prête : N RDV, M tâches » (ses chiffres). Sur téléphone. |
| F2 | Ouvrir l'écran Point de la semaine. | Onglet Synthèse (fait la semaine passée, résumé, chiffres, 7 jours, points d'attention) et onglet Détail jour par jour. |
| F3 | Lire le résumé. | Phrases claires et exactes ; **aucun** prénom, titre ou lieu envoyé au modèle (le résumé les récupère à l'affichage). À juger sur plusieurs semaines fictives. |
| F4 | Changer le jour et l'heure dans Réglages. | Envoi à l'heure choisie ; la semaine couverte reste le lundi-dimanche qui suit. |
| F5 | Invité secondaire. | Résumé de MAAQ, ses propres RDV et tâches, pas de questions. |
| F6 | Semaine vide. | Le point part quand même, calme. |

### G. À regarder partout

- Les messages d'erreur sont lisibles et proposent « Réessayer » ; aucun bouton ne reste bloqué.
- Écrans lisibles sur un petit téléphone, en mode clair et en mode sombre.
- Aucune alerte rouge ou culpabilisante pour une tâche en retard.

## 5. Ce qui n'est pas à recetter (volontairement)

- L'enregistrement d'office après 72 h (lot 3) : éteint sur la zone de test.
- Les questions d'anticipation et le catalogue (lot 7), les trajets et « Sur place » (lot 8).
- La console d'administration du catalogue (reportée).

## 6. Limites connues, à accepter ou à décider

| Sujet | Où on en est | Décision attendue |
|---|---|---|
| Carte « Tâche proposée » seule (hors RDV) | Elle disparaît quand la conversation est rechargée : la base n'a pas de tâche proposée sans RDV. | Accepté par le PO ; à confirmer à la recette. |
| Modifier ou retirer une tâche en l'écrivant à l'assistant | Impossible (il ne reçoit jamais les titres, règle AT-4). Seul l'ajout par le tchat existe. | Accepter, ou ouvrir une exception. |
| Information des parents quand un membre est retiré (US-96 RF8) | Non faite : aucun type de notification n'existe pour cela dans la base. | Demander l'ajout à la session base de données, ou reporter. |
| Notification d'annulation « tâches retirées » | Le message s'affiche seulement à l'écran à l'annulation. | Idem. |
| Semaine couverte par le point | Le lundi-dimanche qui suit l'envoi (schéma de référence) ; la US-98 RF7 dit « les 7 jours qui suivent ». Écart signalé à la session des user stories. | Trancher. |
| Résumé du point | Jamais produit avec le vrai modèle ; modèle léger à choisir (`ASSISTANT_DIGEST_MODEL`) ; coût à mesurer. | Choisir le modèle après la lecture de F3. |
| Banc d'essai de l'assistant | Non relancé avec le vrai modèle depuis les séries, tâches et point (coût d'environ 1 à 3 $ par passage, sur votre clé). | Autoriser un passage avant le pilote. |
| Alerte de septembre si les vacances de l'année suivante manquent | Non faite. | À planifier avant septembre 2027. |
| Recette sur iPhone | Attend un utilisateur équipé que le responsable produit doit recruter. | Recruter. |

## 7. Comment signaler

Pour chaque ligne en « non » ou « à revoir » : le numéro du scénario, ce qui s'est passé, ce qui était attendu, le téléphone utilisé, l'heure. Une capture d'écran aide. Je corrige par lot, redéploie sur la zone de test et vous prévient.
