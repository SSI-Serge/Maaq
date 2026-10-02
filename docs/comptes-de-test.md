# Comptes de test (développement local uniquement)

Créés automatiquement par `npm run dev` (ou `npm run db:reset`) dans la base embarquée.
Ces comptes n'existent que sur ton poste ; ils ne doivent jamais être créés en production.

Mot de passe commun : `Demo-maaq-2026`

| Rôle | Email | État |
|---|---|---|
| Administrateur | admin@maaq.test | actif |
| Utilisateur principal | camille@maaq.test | actif, configuration terminée |
| Invité 1 (noyau) | dominique@maaq.test | actif |
| Invité secondaire | lou@maaq.test | invitation en attente |

Les emails et SMS envoyés par l'application arrivent dans la boîte de test : http://localhost:3000/dev/boite

## Parcours de connexion en développement

- Première connexion sur un navigateur : un code de vérification est demandé. Il arrive dans la boîte de test.
- Puis l'application demande de créer un schéma tactile (tracer au doigt ou toucher les points un à un).
- Les codes de « Schéma oublié ? » et « Mot de passe oublié ? » arrivent aussi dans la boîte de test.
- Pour repartir de zéro : `npm run db:reset` (efface la base de développement et recrée les comptes).

## Console d'administration

- Se connecter avec admin@maaq.test : on arrive sur « Agents IA ».
- Deux agents (Admin_Classify, Admin_lib) et quatre contrats obligatoires sont déjà créés.
- « Créer un compte » envoie un lien d'activation dans la boîte de test ; l'ouvrir permet d'activer le compte.
- Astuce : ouvrir la console sur http://127.0.0.1:3000 et l'application sur http://localhost:3000 garde deux sessions séparées.

## Invités et informations par agent

- Camille (utilisateur principal) voit l'onglet « Invités » : quota, ajout, modification, suppression, renvoi de lien.
- « Envoyer l'invitation » ou « Ajouter un invité » dépose l'invitation dans la boîte de test (`/dev/boite`) : ouvrir le lien reçu active l'accès de l'invité.
- Astuce : activer l'invité sur http://127.0.0.1:3000 pendant que Camille reste sur http://localhost:3000.
- Le dashboard d'agents arrive au lot 4 : pour essayer « Informations par agent », ajouter l'agent à un profil directement en base (table `profile_agents`).
- Pour repartir de zéro : `npm run db:reset`.

## Catalogue et dashboard

- Quatre agents de démonstration : Admin_Classify (Pro, bloqué pour maintenance), Admin_Courriers et Admin_Impots (Pro), Admin_lib (Perso).
- Depuis le dashboard, « Catalogue » ouvre le catalogue ; la recherche ignore accents et majuscules.
- Un agent qui demande des informations ouvre le formulaire dès l'ajout ; fermé sans enregistrer, l'agent reste « À configurer ».
- Pour essayer la limite par rubrique : modifier « Agents maximum par rubrique » dans la console (Paramètres).

## Connecteurs (Google simulé)

- Réglages > Connecteurs : un onglet par agent qui demande un connecteur (Agenda, Drive, boîte de validation) ou des adresses en copie.
- « Autoriser » envoie vers http://localhost:3000/dev/google, qui remplace la page de consentement Google : autoriser (avec un autre compte si on le saisit), autoriser en partie, ou refuser. On revient ensuite dans MAAQ.
- Pour simuler une autorisation retirée côté Google : ouvrir http://localhost:3000/dev/google sans paramètre, puis « Retirer l'autorisation côté Google » ; le connecteur passe à « À reconnecter ».
- Le code de la boîte de validation arrive dans http://localhost:3000/dev/boite.
- Tester en restant sur http://localhost:3000 : la page Google simulée y renvoie toujours.
