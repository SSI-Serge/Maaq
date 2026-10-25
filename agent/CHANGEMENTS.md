# Changements pour rester sur les choix du PO

Version du 25 octobre 2026 du dossier `agent/`, alignée sur les décisions D31 à D37 du PO là où l'agent d'origine divergeait.
Les fichiers d'origine (zip reçu) ne sont pas modifiés. Contrôle hors ligne : `python banc_essai/lancer_tests.py --verifier` (réussi).
**Pas encore mesuré avec un vrai modèle** : le taux de réussite des 35 cas et le temps de réponse sont à relever avec une clé.

## Ce qui a changé

| Décision du PO | Agent d'origine | Changement | Fichiers |
|---|---|---|---|
| D31/D37 : prénoms remplacés par des alias | Prénoms en clair partout | « Parent N » / « Enfant N » envoyés au modèle ; alias retraduits dans la réponse et dans les paramètres des outils | `banc_essai/pseudonymisation.py`, `instructions.md` |
| D37 : adresses email et téléphones masqués | Non traité | Remplacés par `[email]` et `[téléphone]` avant l'envoi ; le modèle les ignore | `pseudonymisation.py`, `instructions.md` |
| D37 : âges par tranche | Âge exact et classe | `lister_membres` renvoie la tranche (0-2, 3-5, 6-10, 11-14, 15-17, 18+), sans classe ni école | `lancer_tests.py` (outil simulé) |
| D31 : événements existants sans titre, lieu ni note | Événements complets | Les outils décrivent un événement par `id`, créneau, type, statut et membres seulement | `lancer_tests.py`, `outils.json` |
| D31 : RDV médical au titre générique, sans lieu ni note | Titre type « Dentiste Léo – Dr Martin », lieu et notes libres | Le backend range « RDV médical — [prénom] » et supprime lieu et notes ; l'agent ne les renseigne pas | `instructions.md`, `outils.json`, `lancer_tests.py` |
| D35 : six types de RDV | Huit types | `ecole`, `medical`, `pro`, `familial`, `perso`, `admin` | `outils.json`, `instructions.md`, `cas_de_test.json` |
| D35 : doublon | ± 1 h, mots-clés, sans membre | Même jour, membre commun, heure de début à 30 min près, objet équivalent (RDV médical : même type) | `outils.json` (`rechercher_doublon`), `lancer_tests.py` |
| D35 : durée par défaut 1 h | 30 min pour un RDV médical | 1 h pour tous | `instructions.md` |
| D35 : 30 RDV par mail au plus | Pas de plafond | Plafond écrit dans les instructions | `instructions.md` |
| D35 : créneaux alternatifs de 8 h à 20 h | Déjà le cas | Inchangé | |

Nouveaux cas de test (29 à 36) : RDV médical sans détail, doublon à 15 minutes, même heure pour une autre personne (pas un doublon), type admin, type familial, mail avec email et téléphone, question sur le planning, rappel de réunion de parents par mail. Le banc d'essai vérifie aussi, pour tous les cas, qu'aucun prénom, email ou téléphone n'est parti chez le modèle.

Option `--sans-pseudo` : même agent sans alias ni minimisation, pour mesurer l'écart de qualité demandé par le PO (D37).

## Décisions du PO sur les deux points ouverts (D39)

1. **Questions sur le planning : décidé.** L'agent cite les rendez-vous par leur identifiant entre doubles crochets (`[[evt-003]]`), et l'application le remplace par le titre à l'affichage. Un identifiant inconnu, ou que le profil n'a pas le droit de voir (D26), s'affiche « un rendez-vous », sans titre. Un rendez-vous médical garde son titre générique. Le banc d'essai applique ces règles d'affichage ; le cas 23 attend donc « RDV médical » et non « dentiste ».
2. **Doublon et membre commun : option (a) retenue (D39, US-89 RF2).** La règle stricte du membre commun (D35) est conservée, mais le serveur ajoute d'office le parent qui écrit ou qui transfère aux membres de la recherche de doublon, quand des membres sont donnés (sans membres, aucun filtre). Cette règle est fixe, elle ne dépend pas du modèle : implémentée dans `src/server/assistant/tools.ts` et dans la référence Python (`auteur`). Mesure avant : 3 doublons manqués sur 10 (cas 24 et 30, « réunion parents de Léo »). Mesure après, vrai modèle, 3 passages : **0 manqué sur 15**, et le cas 31 (même heure, autre personne) reste correctement créé.

3. **Ce que la pseudonymisation ne protège pas.** Noms de famille, noms de praticiens et d'écoles, lieux : ils restent dans le texte des mails et des messages. Les images et PDF ne sont pas pseudonymisables. Le modèle lit la spécialité d'un RDV médical dans le mail : seul ce qui est rangé ou renvoyé est minimisé. Il s'agit d'une pseudonymisation, pas d'une anonymisation.
4. **Qualité du français avec alias.** « Parent 1 » et « Enfant 2 » rendent la réponse moins naturelle ; la retraduction la corrige à l'affichage. À juger sur les rapports.

## Ce que le backend doit reprendre (contrat)

- Le pseudonymiseur de `pseudonymisation.py` est la référence : numéro d'alias attribué à la création du membre et jamais réutilisé, comparaison sans accent ni casse, limites de mots tenant compte de l'apostrophe et du trait d'union, retraduction du texte affiché et des paramètres d'outils.
- Un paramètre d'outil qui désigne un membre doit être un alias renvoyé par `lister_membres` ; sinon l'outil renvoie une erreur.
- Les outils ne reçoivent jamais l'identifiant de la famille : il vient de la session authentifiée.
- La règle du RDV médical (titre générique, ni lieu ni note) est appliquée par le backend, pas par le modèle.
- Les identifiants `[[evt-…]]` sont remplacés par le titre à l'affichage, après retraduction des alias.
- Les statuts « Écarté » et « Ignoré » (D32) sont gérés par le backend : l'agent ne crée que des rendez-vous provisoires.
- Le contenu exact de ce qui part chez le modèle (instructions, messages, résultats d'outils) ne doit pas être journalisé en clair au-delà du strict nécessaire.

## Lancer

```
python banc_essai/lancer_tests.py --verifier      # sans clé, sans frais
python banc_essai/lancer_tests.py                 # règles du PO appliquées (clé nécessaire)
python banc_essai/lancer_tests.py --sans-pseudo   # mesure de référence
python banc_essai/lancer_tests.py --cas 29 30 34  # seulement les nouveaux cas sensibles
```
Chaque rapport donne la durée de chaque cas : le critère du brief est un RDV provisoire en moins de 10 secondes.
