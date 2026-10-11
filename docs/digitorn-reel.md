# Brancher un agent Digitorn réel

Le tchat d'un agent peut être celui de **Digitorn**, affiché dans l'application (cadre intégré). Les autres agents gardent le
tchat simulé construit par MAAQ. Documentation de Digitorn : https://docs.digitorn.ai/docs/api/api-embed

Il existe **deux niveaux**, selon ce que l'administrateur renseigne à la publication de l'agent.

| | Adresse seule | Adresse + clé secrète du projet |
|---|---|---|
| Ce qu'il faut | l'adresse de l'application publiée (`https://….digitorn.app`) | idem, plus la clé secrète `sk_…` du projet, et `DIGITORN_MODE=live` |
| Pour Digitorn, l'utilisateur est | un **visiteur anonyme** (ses conversations restent dans le navigateur de l'appareil) | **reconnu** : son identifiant MAAQ, son prénom, son rang |
| Rang du demandeur, membres du compte | envoyés par la page, **non vérifiés** par Digitorn | posés par le serveur MAAQ (`claims`), **vérifiés** |
| Effacement des conversations à la déconnexion | impossible : l'historique reste dans le navigateur | fait par MAAQ chez Digitorn |
| Suppression d'un profil (RGPD) | MAAQ ne peut rien supprimer chez Digitorn | le profil est supprimé dans le projet |
| Plafond quotidien de demandes | non appliqué | à appliquer par les plans de Digitorn (pas encore branché) |

## Brancher un agent (adresse seule)

1. Dans Digitorn (Studio) : publier l'application de l'agent, puis **Project → Embed** donne l'adresse à utiliser.
2. Console d'administration MAAQ ▸ **Agents IA** ▸ **Mettre à disposition un agent**.
3. Saisir le **nom** de l'agent et l'**adresse de l'application publiée**, laisser la clé vide, puis toucher
   **Utiliser l'adresse de l'application**.
4. Compléter la rubrique, les descriptions, puis **Publier**.
5. Un utilisateur ajoute l'agent à son dashboard depuis le catalogue ; **Ouvrir le tchat** affiche le tchat de Digitorn.

Digitorn propose une liste de sites autorisés (**Project → Access**) : si le cadre reste vide en ligne, y ajouter le domaine de MAAQ (par exemple `test.maaq.fr`). En local, l'adresse s'affiche sans réglage.

## Brancher un agent avec sa clé (utilisateur reconnu)

1. Dans Digitorn : **Project → Access** ▸ copier la clé **secrète** (`sk_…`, jamais la clé publique `pk_…`).
2. Dans la console MAAQ, saisir le nom de l'agent **et** la clé, puis **Rechercher l'agent** : MAAQ interroge Digitorn,
   vérifie que la clé est bien celle du projet de cet agent, et préremplit la fiche.
3. Publier. La clé est conservée **chiffrée** dans la base ; elle n'est jamais réaffichée ni journalisée.
4. Activer l'API réelle : variable `DIGITORN_MODE=live` (et, sur Cloud Run, `--update-env-vars "DIGITORN_MODE=live"`).

Un projet Digitorn par agent : chaque agent a sa propre clé et sa propre adresse.

## Limites à connaître

- **Mode test de Digitorn : 10 utilisateurs au plus par projet, visiteurs compris.** Au-delà, Digitorn refuse (`test_mode_limit`).
  Pour dépasser cette limite : Digitorn ▸ **Project → Billing** ▸ **Go to production**.
- **Les connecteurs Google** sont guidés par le tchat de Digitorn. MAAQ n'en connaît pas l'état (Digitorn ne le
  documente pas encore) : les écrans « Connecteurs » de MAAQ restent simulés pour ces agents et ne bloquent plus l'ouverture du tchat.
- **Resté simulé tant que Digitorn ne l'a pas documenté** : carnet de bord, classement des documents, export et anonymisation
  des données.
- L'application MAAQ se **verrouille après 5 minutes** sans toucher hors du cadre : les touchers dans le cadre de Digitorn
  ne remontent pas jusqu'à MAAQ, qui ne voit que le moment où le cadre prend le focus.
- Le bandeau « Vous échangez avec une IA » de MAAQ s'ajoute à celui de Digitorn.

## Mise à jour d'une base existante

La migration `0006_digitorn_projects.sql` ajoute à chaque agent la clé chiffrée et l'adresse. Sur une base en ligne
(Supabase), l'appliquer depuis le poste, comme les migrations précédentes (`npm run db:migrate` avec les variables de
connexion), **avant** de redéployer.
