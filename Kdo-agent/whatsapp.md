# WhatsApp : écrire à kdo_help et recevoir ses rappels

Spécification d'origine : « WhatsApp Channel + Shared Conversation Layer » (07/10/2026). Cette page décrit ce qui est construit, ce qui diffère de la spécification à cause des règles de MAAQ, et ce qu'il reste à faire chez Meta.

## Ce que fait MAAQ

- **Même conversation.** Un message WhatsApp suit exactement le chemin d'un message de l'application : plafond quotidien, agent bloqué ou à configurer, carnet de bord, historique. Il apparaît dans le tchat de kdo_help avec la mention « Envoyé depuis WhatsApp », et la réponse repart vers WhatsApp. « La deuxième idée » envoyée depuis WhatsApp renvoie bien à ce qui a été montré dans l'application dix minutes plus tôt.
- **Liaison par code.** Jamais sur le seul numéro : la personne coche le consentement dans Réglages › WhatsApp et rappels, obtient un code `LINK-XXXXXX` (10 minutes) et l'envoie depuis son WhatsApp. Un numéro inconnu reçoit la marche à suivre et n'accède à rien. Un numéro déjà relié à un autre compte est refusé.
- **Consentement et arrêt.** Le texte de consentement et sa version sont enregistrés à la liaison ; `STOP` coupe les rappels (confirmé une fois), `REPRENDRE` les réactive ; « Délier ce numéro » retire tout.
- **Cartes à valider.** Une suppression demandée dans le tchat produit une carte Valider / Refuser ; sur WhatsApp, ce sont deux boutons dont la charge utile porte l'identifiant de la carte. Rien n'est supprimé sur simple texte.
- **Rappels.** 21, 7 et 2 jours avant une occasion : un message de kdo_help dans l'application et/ou sur WhatsApp selon le réglage, un seul message par passage même si plusieurs dates tombent ensemble, jamais pendant les heures calmes (21 h – 8 h par défaut, fuseau de la personne), jamais deux fois la même échéance, rien pour une occasion réglée ou reportée. Boutons : Voir les idées · Plus tard (3 jours) · C'est réglé.
- **Fenêtre de 24 h.** Dans les 24 h qui suivent un message de la personne, MAAQ envoie des messages libres ; au-delà, seulement le modèle approuvé `maaq_rappel_occasions`. Un appui sur un bouton du modèle rouvre la fenêtre.
- **Garde-fous.** Signature `X-Hub-Signature-256` vérifiée sur chaque webhook, réponse 200 immédiate puis traitement en file par numéro, dédoublonnage sur l'identifiant WhatsApp du message, 30 messages par minute et par numéro, aucun texte de message conservé par MAAQ (seuls l'identifiant, le sens et l'état de remise, pour le dédoublonnage et le suivi).
- **Messages non pris en charge.** Vocaux, images, contacts : réponse polie demandant d'écrire. La transcription des vocaux n'est pas branchée (pas de fournisseur retenu).

## Écarts avec la spécification, et pourquoi

| Spécification | MAAQ | Raison |
|---|---|---|
| Table `messages` persistante, fil partagé stocké par MAAQ | Le fil reste celui du tchat (Digitorn simulé) : partagé entre canaux, mais effacé à la déconnexion et après 4 jours | Règles US-43 et US-44 du produit ; une mémoire longue des conversations serait une décision du PM |
| Compte « WhatsApp seulement » créé depuis un numéro inconnu | Pas de création de compte depuis WhatsApp | Les comptes MAAQ sont créés par l'administrateur ; un invité est activé par l'utilisateur principal |
| Notifications push dans l'application | Message de kdo_help déposé dans son tchat (visible à l'ouverture) | Les notifications push sont hors V1 ; les rappels WhatsApp sont le premier canal proactif |
| Idées précalculées la nuit pour répondre instantanément au bouton « Voir les idées » | Calculées à la demande (5 à 20 s) | À faire quand le volume le justifiera ; coût d'un appel modèle par occasion |
| Alertes de baisse de prix | Non | Pas de source de prix |
| Formulaires WhatsApp Flows | Dialogue guidé par l'agent, une question à la fois | Prévu v1.1 par la spécification |
| Un fil par personne ou par occasion | Un fil par profil et par agent | V1 de la spécification |

Le fuseau de la personne est celui de son profil (`users.timezone`, Europe/Paris par défaut), mis à jour par ses appareils ; il sert aux dates relatives et aux heures calmes.

## Essayer sans compte Meta

`WHATSAPP_MODE=dev` (par défaut) : rien ne part, tout arrive sur http://localhost:3000/dev/whatsapp, qui permet aussi d'écrire comme depuis un téléphone.

1. Connecté comme Camille : Réglages › WhatsApp et rappels › cocher le consentement › Connecter WhatsApp. Un code s'affiche.
2. Sur /dev/whatsapp, envoyer ce code depuis le numéro 33612345678 : le message de bienvenue apparaît.
3. Envoyer « Ajoute ma fille Léa, née le 15 octobre 2019, fan de dinosaures », puis « Une idée pour Léa, 20 € ». Les réponses s'affichent sur /dev/whatsapp et dans le tchat de kdo_help de l'application.
4. Envoyer « Supprime Léa » : une carte à boutons apparaît ; appuyer sur Valider ou Refuser.
5. Les rappels partent au passage du planificateur (toutes les 5 minutes en développement, `/api/cron/run` en ligne) : avec un anniversaire dans moins de 21 jours et le réglage « Sur WhatsApp », le modèle `maaq_rappel_occasions` apparaît sur /dev/whatsapp.

## Mise en service chez Meta (à faire)

- [ ] Compte Meta Business et compte WhatsApp Business (WABA), numéro dédié.
- [ ] Application Meta : jeton permanent d'utilisateur système (`WHATSAPP_ACCESS_TOKEN`), identifiant du numéro (`WHATSAPP_PHONE_NUMBER_ID`), secret de l'application (`WHATSAPP_APP_SECRET`).
- [ ] Webhook : `https://<zone>/api/webhooks/whatsapp`, champ `messages`, jeton de vérification `WHATSAPP_VERIFY_TOKEN` (celui de votre choix).
- [ ] Vérification de l'entreprise et nom affiché (nécessaires au-delà du volume de test).
- [ ] Modèles à soumettre, catégorie Utilitaire (textes dans `src/server/adapters/whatsapp/templates.ts`) :
  - `maaq_rappel_occasions` : « Bonjour {{1}}, une date approche : {{2}}. Souhaitez-vous des idées de cadeaux ? » + réponses rapides « Voir les idées », « Plus tard », « C'est réglé ».
  - `maaq_bienvenue` : confirmation de liaison (envoyée aujourd'hui en message libre, la fenêtre étant ouverte).
  Garder les modèles factuels : un modèle contenant des produits ou des prix risque d'être reclassé « Marketing » (plus cher, plus limité). Les idées partent en message libre après l'appui sur un bouton.
- [ ] Passer `WHATSAPP_MODE=cloud` et `WHATSAPP_BUSINESS_NUMBER=<numéro>` dans les secrets du déploiement (voir docs/deploiement-test.md).
- [ ] Surveiller les statuts `failed` dans `channel_messages` et l'état des modèles ; en cas de rejet, les rappels retombent sur l'application.

Alternative : un BSP (Twilio…) en implémentant `WhatsAppTransport` (`src/server/adapters/whatsapp/types.ts`) ; le reste ne change pas.

## Où est le code

| Rôle | Fichiers |
|---|---|
| Transport WhatsApp (Cloud API, boîte de test), modèles | `src/server/adapters/whatsapp/` |
| Webhook, liaison, préférences, outils de dev | `src/app/api/webhooks/whatsapp`, `src/app/api/channels`, `src/app/api/me/notification-prefs`, `src/app/api/dev/whatsapp`, `src/app/dev/whatsapp` |
| Cœur de conversation (identité, file par numéro, relais vers le tchat, rendu) | `src/server/channels/` |
| Proches, occasions, idées, préférences, rappels | `src/server/gifts/` |
| Outils de l'agent et cerveau | `src/server/agents/kdo-help-tools.ts`, `src/server/agents/kdo-help.ts` |
| Écran Réglages | `src/app/(app)/reglages/whatsapp/page.tsx` |
| Base | `db/migrations/0006_gifts_and_channels.sql` |

## Évaluations

- `npm test` : règles de dates, outils (faux modèle), stockage, simulateur, rendu WhatsApp, cœur de conversation, rappels.
- `npm run eval:kdo-help -- --intents` : intention → outil sur les phrases de `Kdo-agent/evals/utterances.json` (modèle réel).
- `npm run eval:kdo-help` : cas qualitatifs de `Kdo-agent/evals/golden.json`, à noter à la main ; sur WhatsApp, ajouter la concision.
