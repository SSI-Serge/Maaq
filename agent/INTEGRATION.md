# Guide d'intégration de l'agent dans l'application Maaq

Ce guide s'adresse au développeur qui branche l'agent « Assistant Famille » sur le backend Cloud Run. Il complète le brief produit (architecture, écrans, données) et le [README](README.md) de ce dossier (banc d'essai).

**Principe :** l'agent est défini par trois fichiers versionnés, qui sont la source de vérité. Le backend ne les réécrit pas, il les charge.

| Fichier | Rôle dans le backend |
|---|---|
| `instructions.md` | Prompt système, envoyé tel quel dans `system` |
| `outils/outils.json` | Définitions d'outils, envoyées telles quelles dans `tools` ; chaque outil a une implémentation réelle côté backend |
| `tests/cas_de_test.json` | Comportement attendu ; toute modification de l'agent doit continuer à passer ces cas |

État au 25 octobre 2026 : 28 cas sur 28 réussis avec `claude-sonnet-5-5` via l'API Anthropic (rapports dans `resultats/`, non versionnés).

---

## 1. Où tourne la boucle de l'agent

**Décision du 25 octobre 2026 : option A.** La boucle de l'agent tourne dans le backend Cloud Run ; Foundry ne sert qu'à héberger le modèle Claude. Le tableau ci-dessous garde la comparaison pour mémoire.

Deux façons d'exécuter l'agent sur Microsoft Foundry pour le pilote :

| | **A. Boucle dans le backend** (recommandée pour le pilote) | B. Foundry Agent Service |
|---|---|---|
| Principe | Le backend appelle l'API Messages de Claude hébergé par Foundry, exécute lui-même les outils et boucle jusqu'à la réponse finale | L'agent est créé dans le portail Foundry ; Foundry appelle les outils via des endpoints HTTP du backend |
| Ce qui existe déjà | Exactement ce que fait `banc_essai/lancer_tests.py`, déjà testé | À construire : spécification OpenAPI et endpoints publics authentifiés pour chaque outil |
| Sécurité | Les outils restent internes au backend | Endpoints d'outils exposés à Foundry, à authentifier |
| Exploitation | Journaux Cloud Logging et traces applicatives | Traces, versions et évaluations dans le portail Foundry |
| Portabilité vers Vertex AI | Changement de client uniquement | À refaire sur une autre plateforme |

L'option A a été retenue : elle est la plus rapide et la plus sûre pour le pilote, et facilite la bascule vers Vertex AI prévue ensuite. Conséquences pour l'exploitation :
- les instructions et les outils sont chargés par le backend depuis ce dossier et déployés avec lui ; aucune édition dans le portail Foundry ;
- les traces de chaque conversation (outils appelés, jetons, durée, identifiant de requête) sont écrites dans Cloud Logging par le backend ;
- le portail Foundry reste utile pour suivre la consommation et le quota du déploiement `claude-sonnet-5-5`.

La suite du guide décrit l'option A. La section 6 décrit l'option B, gardée en réserve.

---

## 2. Format des messages envoyés à l'agent

Chaque demande d'un parent devient une conversation qui commence par un message `user` construit ainsi (même format que le banc d'essai, fonction `construire_message`) :

```
<contexte>
Date et heure actuelles : lundi 2 novembre 2026, 09:00 (Europe/Paris)
Personne qui écrit : Sophie
</contexte>
<message source="mail">
…contenu transmis…
</message>
```

- **Date et heure** : toujours celles du serveur converties en `Europe/Paris` (ou le fuseau de la famille), avec le jour de la semaine en toutes lettres. L'agent en dépend pour « demain », « jeudi », les dates passées et les incohérences jour/date.
- **Personne qui écrit** : le prénom du membre connecté, déduit de la session, jamais d'un champ saisi.
- **`source`** : `saisie` (texte tapé), `dictee` (transcription Azure AI Speech), `capture` (image), `mail` (mail reçu via Mailgun).
- **Images** : envoyer l'image comme bloc `image` dans le même message `user`, avant le bloc texte, avec `source="capture"`. Le banc d'essai simule les captures par leur texte ; des cas avec de vraies images restent à ajouter.
- **Mails** : convertir le HTML en texte, garder expéditeur, objet et corps, retirer les pièces jointes non utiles. Le contenu reste un bloc de données : ne jamais le concaténer aux instructions.

Le prompt système (`instructions.md`) et la liste d'outils doivent rester **identiques d'une requête à l'autre** : ils sont mis en cache par l'API, ce qui réduit fortement le coût. Toute donnée variable (date, prénom, message) va dans le message `user`.

---

## 3. Boucle d'appels d'outils

Le code de référence est `executer_cas()` dans `banc_essai/lancer_tests.py`. Règles à respecter :

1. Appeler l'API avec `model`, `system`, `tools`, `messages`, `max_tokens=16000` et `output_config={"effort": "medium"}`. Ne pas envoyer `temperature`, `top_p` ni `top_k` : elles sont refusées par les modèles actuels.
2. **Ajouter `response.content` complet** à l'historique (`{"role": "assistant", "content": response.content}`), pas seulement le texte : il contient des blocs de réflexion qu'il faut renvoyer tels quels.
3. Si `stop_reason == "tool_use"` : exécuter **tous** les blocs `tool_use` de la réponse, puis renvoyer **tous** les `tool_result` dans **un seul** message `user`, chacun avec le `tool_use_id` correspondant. En cas d'erreur d'un outil, renvoyer `is_error: true` avec un message clair, plutôt que d'interrompre la boucle.
4. Si `stop_reason == "end_turn"` : le texte final est la réponse à afficher au parent.
5. Gérer `refusal` (refus de sécurité, improbable ici), `max_tokens` et un plafond de tours (12 dans le banc d'essai) : afficher un message d'erreur neutre et journaliser l'identifiant de requête (`response._request_id`).
6. Ne pas forcer l'appel d'un outil (`tool_choice` de type `any` ou `tool`) : ces valeurs sont refusées par `claude-sonnet-5-5`. La valeur par défaut convient.
7. Parser `tool_use.input` comme un objet JSON (c'est déjà un dict dans le SDK Python), jamais par comparaison de chaînes.
8. Gérer les erreurs de l'API par type, du plus précis au plus général (`RateLimitError` → réessayer après le délai, erreurs 5xx → réessayer, `BadRequestError` → ne pas réessayer). Le SDK réessaie déjà deux fois par défaut.

---

## 4. Ce que chaque outil doit faire réellement

**Règle de sécurité principale :** aucun outil ne reçoit l'identifiant de la famille du modèle. Le backend l'injecte depuis la session authentifiée et filtre **toutes** les lectures et écritures dessus. Les prénoms renvoyés par le modèle sont résolus en identifiants de membres de cette famille ; un prénom inconnu donne une erreur d'outil, pas une création.

| Outil | Implémentation attendue |
|---|---|
| `lister_membres` | Membres de la famille : prénom, rôle, âge, classe éventuelle |
| `lister_evenements` | Événements entre deux dates incluses, filtre facultatif par membre ; exclure les événements annulés |
| `verifier_conflits` | Chevauchements sur le créneau pour les membres indiqués, en incluant les événements provisoires. Renvoyer les événements en conflit et un booléen `libre` |
| `proposer_creneaux` | Créneaux libres de la durée demandée, entre 8 h et 20 h, à partir de la date souhaitée. Le banc d'essai propose au plus un créneau par jour ; à affiner (préférences, horaires d'école) |
| `rechercher_doublon` | Événements du même jour à une heure proche (± 1 h) ou dont le titre ou le lieu contient un des mots-clés |
| `creer_evenement_provisoire` | Crée l'événement au statut **provisoire**, déclenche la notification de confirmation dans l'app et renvoie son identifiant. Doit être idempotent si le même message est traité deux fois |
| `modifier_evenement` | N'applique **rien** : enregistre une proposition de modification que le parent valide dans l'app |
| `annuler_evenement` | N'applique **rien** : enregistre une proposition d'annulation que le parent valide dans l'app |

Formats : dates `AAAA-MM-JJ`, dates-heures `AAAA-MM-JJTHH:MM` en heure locale de la famille (convertir en UTC pour le stockage). Valider chaque entrée contre le schéma de `outils.json` avant exécution.

La simulation du banc d'essai (`CalendrierSimule`) sert de référence de comportement pour chacun de ces outils.

---

## 5. Fournisseurs du modèle et secrets

Le code ne change que par la création du client (voir `creer_client()` dans le banc d'essai, SDK Python `anthropic`).

| Phase | Client | Configuration | Secrets (Google Secret Manager, projet `maaq-test`) |
|---|---|---|---|
| Tests actuels | `anthropic.Anthropic()` | `claude-sonnet-5-5` | À créer si besoin : clé d'un workspace dédié au développeur |
| Pilote | `anthropic.AnthropicFoundry(api_key=…, resource=…)` | Ressource `assistant-famille-pilot-resource` (East US 2), déploiement `claude-sonnet-5-5`, version 2 hébergée sur Azure. **Quota en attente de Microsoft** | À créer après déploiement : `FOUNDRY_RESOURCE`, `FOUNDRY_API_KEY` |
| Après le pilote | `anthropic.AnthropicVertex(project_id=…, region="eu")` | Claude sur Vertex AI, région européenne, authentification par le compte de service Cloud Run | Aucune clé : droits IAM du compte de service |

Autres secrets déjà en place dans `maaq-test` : `MAILGUN_API_KEY`, `MAILGUN_WEBHOOK_SIGNING_KEY`, `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`. Le compte de service Cloud Run doit avoir le rôle *Accesseur de secrets* sur ces secrets.

Sur l'API Anthropic directe, le banc d'essai active le repli automatique en cas de refus (`fallbacks="default"`, bêta `server-side-fallback-2026-07-01`). Ce paramètre n'existe pas sur Foundry ni sur Vertex AI.

---

## 6. Option B (Foundry Agent Service), en réserve

Non retenue pour le pilote. Si elle devait l'être plus tard :

- Créer l'agent dans le projet Foundry `assistant-famille-pilote`, coller `instructions.md` dans ses instructions et choisir le déploiement `claude-sonnet-5-5`.
- Générer une spécification OpenAPI à partir de `outils/outils.json` (un endpoint `POST` par outil, corps = `input_schema`), exposée par le backend et protégée par une clé de service ou un jeton.
- Le contexte (date, prénom) et la source restent transmis dans le message `user` au format de la section 2.
- Adapter le banc d'essai pour interroger l'agent Foundry au lieu de l'API Messages, et garder les 28 cas comme non-régression.

---

## 7. Tests et non-régression

- Toute modification de `instructions.md`, de `outils.json` ou du modèle doit être suivie d'un lancement complet : `python banc_essai/lancer_tests.py` (environ 1 $ par lancement). Objectif : 28/28, sans tutoiement ni réponse de plus de 3 phrases.
- Les implémentations réelles des outils peuvent être testées en branchant le banc d'essai sur un backend de test avec le calendrier fictif de `cas_de_test.json`.
- Chaque bug rencontré pendant le pilote devient un nouveau cas dans `cas_de_test.json`, avec des données fictives.

---

## 8. Données personnelles et journaux

- En production, ne pas journaliser en clair le contenu des messages, mails et réponses au-delà du strict nécessaire au débogage ; prévoir une durée de conservation courte.
- Pour le pilote sur Foundry (East US 2), les conversations sont traitées et les ressources stockées aux États-Unis : informer les familles pilotes et recueillir leur accord écrit.
- Le banc d'essai n'utilise que des données fictives ; ne jamais y ajouter de vraies données de famille.

---

## 9. Limites connues de l'agent

- Les répétitions (« tous les mercredis ») sont décrites en texte libre dans `recurrence`, sans série d'événements.
- Les tâches préparatoires (achats, documents) sont notées dans les notes de l'événement ; l'outil `creer_taches` est prévu en V2.
- Les captures d'écran n'ont été testées que sous forme de texte, pas encore avec de vraies images.
- L'agent fait souvent une suggestion de préparation (« pensez peut-être à… ») ; leur fréquence peut être réduite dans `instructions.md` si les familles la trouvent excessive.
