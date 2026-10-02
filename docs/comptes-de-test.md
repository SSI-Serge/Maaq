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

## Tchat avec les agents (Digitorn simulé)

- Dashboard > « Ouvrir le tchat » sur une carte d'agent. Un agent « À configurer » affiche l'écran informatif ; un agent bloqué (console > Agents) affiche la bannière de maintenance et grise la saisie, sans effacer l'historique.
- L'agent simulé répond en 1,5 s. Mots-clés de démonstration :
  - « rendez-vous », « rdv » ou « réserver » : carte d'action de rendez-vous (participants automatiques du foyer) ;
  - « mail », « écris » ou « envoie » : carte de validation d'un email (objet, destinataire, brouillon) ;
  - « échec » : l'action validée échouera (« L'action n'a pas pu être exécutée ») ;
  - « silence » : l'agent ne répond jamais — « met plus de temps » à 30 s, « n'a pas pu répondre » + Réessayer à 2 min.
- Plafond de demandes : par défaut 50 par jour. Pour l'essayer vite, baisser `daily_request_limit` du compte en base ; l'avertissement apparaît à 5 demandes restantes.
- Les conversations vivent dans la mémoire du simulateur : elles disparaissent au redémarrage du serveur de développement.

## Contrats (page « Contrats »)

- L'entrée « Contrats » apparaît pour l'utilisateur principal et l'invité 1 (Dominique) ; un invité secondaire ne la voit pas.
- « Mes contrats » : les quatre contrats de démonstration, à renseigner (champs obligatoires, formats), avec documents et consentement au challenge. Les données sont partagées entre Camille et Dominique.
- Le classement des documents exige le Google Drive du compte : sans lui, le document passe à « Classement impossible » (bouton « Réessayer »). Pour le connecter, passer par Connecteurs (agent qui demande le Drive du compte) puis la page Google simulée.
- Pour simuler un classement qui échoue : donner au fichier un nom contenant « echec-classement ». Le fichier de test antivirus EICAR est refusé à l'envoi.
- Les documents classés sont rangés dans `.data/drive/<compte>` (faux Google Drive) ; les envois en cours dans `.data/staging`.
- « Agents des Contrats » : un agent de la rubrique « Agents des Contrats » doit d'abord être créé dans la console (Agents IA), puis ajouté depuis le catalogue.
- Le texte de consentement contient « [nom du partenaire] » : le nom réel est à fournir (une nouvelle version du texte pourra être publiée).

## Réglages, appareils, carnet de bord et support

- Réglages : l'utilisateur principal voit Invités, Connecteurs, Appareils, Aide et support, Carnet ; l'invité voit « Mes connecteurs », Aide et support, Carnet. L'administrateur a Aide et support (`/admin/support`) dans ses Réglages.
- Appareils (utilisateur principal) : « Révoquer » ferme les sessions de l'appareil, prévient la personne par email (boîte de test) et l'oblige à repasser par la vérification d'identité. Révoquer « Cet appareil » déconnecte et efface les tchats. L'administrateur voit aussi les appareils d'un compte sur la fiche du compte.
- Carnet de bord : alimenté par la synchronisation avec Digitorn (simulé). Elle tourne toute seule toutes les X heures (5 par défaut, console > Paramètres) ; pour la lancer tout de suite après avoir fait des demandes dans le tchat :
  `curl -X POST http://localhost:3000/api/dev/sync` (ou, depuis la console du navigateur, `fetch('/api/dev/sync', { method: 'POST' })`).
- Les traitements périodiques (synchronisation, nettoyage du carnet, des signalements et des tables techniques) peuvent aussi être déclenchés par un planificateur externe : `POST /api/cron/run` avec l'en-tête `Authorization: Bearer <CRON_SECRET>` (valeur dans `.env`). `MAAQ_SCHEDULER=off` désactive le planificateur intégré.
- Support : le message arrive dans la boîte de test à `support@maaq.test` (réglage « Boîte du support » de la console), avec prénom, email, rôle, appareil et version ; une copie part au profil. Les alertes (échec de synchronisation) vont à `alertes@maaq.test`.
- Dictée : demande l'accès au micro de l'appareil. La transcription utilise la reconnaissance vocale du navigateur quand elle existe ; sans elle, le texte se saisit à la main. Le texte seul est envoyé, jamais le son.

## Conformité : textes légaux, export, suppression, délai de grâce

- **Textes légaux** : « Confidentialité et conditions d'utilisation » est lisible sans connexion (lien sous le formulaire de connexion, et dans les Réglages). À la première connexion, ou quand une nouvelle version est publiée, un écran impose de les accepter avant tout accès (les comptes de démonstration le voient une fois). Les textes de démonstration sont à remplacer par les textes définitifs.
- **Export** : Réglages > « Exporter mes données ». L'archive (document lisible, données structurées, documents de contrats) est préparée en arrière-plan, chiffrée, et le lien arrive dans la boîte de test (`/dev/boite`) ; il est valable 7 jours et demande d'être connecté.
- **Suppression** : Réglages > « Désabonnement et suppression du compte » (« Supprimer mon compte et mes données » pour un invité). Mot de passe requis. Le profil est déconnecté partout, un email donne la date de suppression définitive ; en se reconnectant, l'écran de reprise propose « Annuler la suppression ». Pour l'utilisateur principal, les invités sont coupés puis prévenus.
- **Désabonnement par la facturation** : `POST /api/webhooks/billing` avec `Authorization: Bearer <BILLING_WEBHOOK_SECRET>` (valeur dans `.env`) et le corps `{"event":"unsubscribed","email":"camille@maaq.test"}` (ou `"resubscribed"`). Après un désabonnement, « Annuler la suppression » indique qu'un nouvel abonnement est nécessaire.
- **Suppression définitive** : le traitement tourne avec le planificateur (voir plus haut) et supprime les comptes dont le délai de 30 jours est écoulé, les invités retirés ou ayant supprimé leur compte, et les comptes ou invités jamais activés (délai réglable, 30 jours). Un rappel part 7 jours avant. Pour essayer sans attendre, avancer `purge_scheduled_at` du compte en base puis `curl -X POST http://localhost:3000/api/dev/sync`.
- **Avant la mise en production** : `npm run check:release` échoue tant que les textes juridiques, le nom du partenaire du consentement et les boîtes du support et des alertes sont encore ceux de démonstration.

