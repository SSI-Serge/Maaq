# Agent « Assistant Famille » : instructions, outils et banc d'essai

Ce dossier contient tout ce qui définit l'agent, indépendamment de l'endroit où il tournera (API Anthropic directe pour les tests et le pilote ; un hébergement en Union européenne plus tard si le DPO l'exige). Microsoft Foundry est abandonné (D54).

| Fichier | Contenu | À modifier par vous ? |
|---|---|---|
| `instructions.md` | Le rôle, les règles et le ton de l'agent (son « prompt système ») | Oui, librement |
| `outils/outils.json` | La liste des outils que l'agent peut appeler et leurs paramètres. C'est le contrat avec le futur backend | Avec prudence |
| `tests/cas_de_test.json` | La famille fictive, son calendrier et 28 situations avec le résultat attendu | Oui, pour ajouter des cas |
| `banc_essai/lancer_tests.py` | Le script qui envoie les cas à Claude et vérifie les réponses | Non |
| `resultats/` | Les rapports produits à chaque lancement | Lecture seule |

## Ce que fait le banc d'essai

Pour chaque cas, le script envoie le message à Claude avec les instructions et les outils. Quand Claude appelle un outil (vérifier un conflit, créer un rendez-vous…), le script répond à la place du backend avec un **calendrier fictif** : aucune donnée réelle n'est utilisée. Il compare ensuite ce que l'agent a fait au résultat attendu, et écrit un rapport lisible dans `resultats/`.

Il vérifie notamment que l'agent :
- crée les bons rendez-vous (date, heure, membres) ;
- ne crée rien en cas de conflit, de doublon ou d'information manquante, et pose alors une question ;
- vérifie toujours doublons et conflits avant de créer ;
- n'obéit pas aux instructions cachées dans un mail.

## Lancer les tests

1. **Créer une clé API Anthropic** (une seule fois) : sur platform.claude.com, créez un compte, ajoutez un moyen de paiement et quelques euros de crédit, puis créez une clé dans *API Keys*.
2. **Configurer** : copiez `.env.exemple` en `.env` dans ce dossier, puis collez votre clé après `ANTHROPIC_API_KEY=`. Le fichier `.env` reste sur votre ordinateur. Ne l'envoyez à personne.
3. **Lancer**, depuis ce dossier :

```
python banc_essai/lancer_tests.py
```

Options utiles :
- `python banc_essai/lancer_tests.py --cas 04 12` : seulement les cas 04 et 12 ;
- `python banc_essai/lancer_tests.py --verifier` : contrôle hors ligne des fichiers, sans appeler Claude et sans frais.

Un lancement complet coûte de l'ordre de 1 à 3 $ avec Claude Sonnet 5.5. C'est une estimation : le total de jetons consommés figure en tête de chaque rapport.

## Améliorer l'agent

1. Lancez les tests et lisez le rapport : chaque échec indique ce qui était attendu, les outils appelés et la réponse de l'agent.
2. Ajustez `instructions.md` (une règle à la fois).
3. Relancez les cas concernés avec `--cas`, puis tous les cas, pour vérifier que rien d'autre ne s'est dégradé.

## Microsoft Foundry : abandonné

Foundry a été écarté (décision D54 : Claude n'y est pas disponible en Europe) et son code a été retiré de l'application. Le fournisseur `foundry` du banc d'essai Python et les variables `FOUNDRY_*` de `.env.exemple` sont des restes sans usage. Ce banc Python est lui-même périmé : seul le banc TypeScript (`scripts/assistant-bench.ts`) fait foi. Le traitement par l'API Anthropic directe, qui ne propose pas de région UE (`inference_geo` : « global » ou « us »), est un point à soumettre au DPO (C-17 de la spécification Contrats V2).

Sur l'API Anthropic, le script active le repli automatique d'Anthropic : si Claude refuse une demande pour raison de sécurité, la requête est relancée sur un autre modèle. Ce cas ne devrait pas se présenter avec des rendez-vous familiaux.
