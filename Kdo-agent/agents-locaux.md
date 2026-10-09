# Agents locaux (en attendant Digitorn)

L'intelligence des agents doit être hébergée chez Digitorn, dont l'API n'est pas encore publiée. Pour construire et essayer un agent dès maintenant, MAAQ peut en exécuter certains elle-même, derrière le même contrat `DigitornClient` : le simulateur Digitorn (`src/server/adapters/digitorn/mock.ts`) délègue la réponse à un « cerveau » (`src/server/agents/`) au lieu de ses réponses figées. Le reste de l'application (tchat, carnet de bord, plafond quotidien, effacement, export) ne change pas.

Quand Digitorn livrera son API ou son tchat embarqué, ces agents y seront transférés : le cerveau contient tout ce qu'il faut (texte système, outils, contexte attendu, contrôles).

## Activer

Dans `.env` :

```
LOCAL_AGENTS_MODE=anthropic
# LOCAL_AGENTS_MODEL=claude-opus-5-5   # facultatif
```

Le SDK Anthropic lit `ANTHROPIC_API_KEY`, ou le profil créé par `ant auth login`. Avec `LOCAL_AGENTS_MODE=off` (valeur par défaut), le simulateur répond seul, comme avant.

Le texte des demandes transite alors par les serveurs de MAAQ puis d'Anthropic : acceptable pour la zone de test, à revoir avec le tchat embarqué de Digitorn.

## Comment un cerveau fonctionne

- Il reçoit la demande, l'historique récent du tchat (4 jours au plus), le contexte du profil, la date, le fuseau et le canal (application ou WhatsApp).
- Il appelle le modèle avec des **outils** (`betaZodTool` du SDK) : le modèle choisit l'outil, l'outil vérifie et borne. Les écritures passent par le magasin de données du profil ; une **action sensible** (suppression) ne s'exécute pas dans l'outil : elle devient une carte « Valider / Refuser » du tchat (US-39), exécutée seulement après accord, dans l'application comme sur WhatsApp.
- Il rend un texte prêt à afficher. Les échecs du modèle donnent un message d'excuse, jamais une erreur technique.

## Agents disponibles

| Agent | Rubrique | Connecteurs | Données |
|---|---|---|---|
| `kdo_help` | Perso | aucun | Proches, occasions, idées et préférences de rappel du profil (tables `gift_*`, `users`) |

`kdo_help` est créé par `npm run dev` ou `npm run db:seed` dans la base de développement ; en ligne, l'administrateur le met à disposition depuis la console (il figure dans la liste des agents hébergés).

### Ce que fait kdo_help

- **Proches et occasions en langage naturel** : créer, retrouver, modifier, supprimer (avec confirmation, annulable 30 jours) ; occasions autres que les anniversaires (Noël, fête…) ; dates relatives résolues à partir de la date du jour et répétées en absolu ; homonymes levés avant toute écriture.
- **Idées de cadeaux** : raisonne d'abord sur la personne, puis au plus 3 idées classées avec une fourchette de prix constatée ; retire lui-même une idée hors du budget de la demande ou du proche, ou déjà proposée ; les idées sont gardées avec leur statut (proposée, gardée, achetée, écartée).
- **Occasions à venir** : anniversaires déduits des proches et occasions enregistrées, avec l'âge atteint ; réglées ou reportées à la demande.
- **Rappels** : 21, 7 et 2 jours avant, dans l'application et/ou sur WhatsApp (voir `whatsapp.md`, même dossier).
- Ne propose ni lien, ni boutique précise, ni promotion.

Pas encore : lecture du Google Agenda, recherche de prix en ligne, transcription des vocaux. Les proches sont des données personnelles sur des tiers : exportées avec les données du profil, supprimées avec lui, en clair en base (comme les coordonnées des profils).

## Évaluer

```bash
npm run eval:kdo-help              # cas qualitatifs (golden.json), à noter à la main
npm run eval:kdo-help -- --intents # intention → outil (utterances.json), précision mesurée
npm run eval:kdo-help -- --dry     # vérifie les jeux sans appel au modèle
```

Les évaluations tournent sur un magasin en mémoire et le vrai modèle. Les tests automatiques (`tests/agents-kdo-help.test.ts`, `tests/whatsapp.test.ts`) utilisent un faux modèle qui joue des appels d'outils prévus : ils n'appellent jamais l'API.
