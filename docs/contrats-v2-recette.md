# Contrats V2 : recette

Deux niveaux : ce que les **tests automatiques** vérifient à chaque modification (`npm test`, rejoués par la CI), et ce que **le PO essaie à la main sur la zone de test** (https://test.maaq.fr). Les cases à cocher servent de feuille d'essai.

Prérequis sur la zone : `CONTRACT_ANALYSIS_MODE=preview` (masquage, aperçu et rapport de démonstration ouverts, **aucun document envoyé à une IA**), service de lecture `maaq-lecture` en ligne, champs de documents créés dans les catégories, un courtier désigné dans la console (Réglages) pour essayer le challenge. `npm run check:contracts` dit ce qui manque.

## 1. Couverture automatique

| Sujet | US | Tests |
|---|---|---|
| Catégories, champs de documents, archivage, réglages | 122, 123, 139, 65 | `admin-contracts-v2.test.ts`, `admin.test.ts` |
| Mes contrats : contrat de base, complémentaires, noms, plafond, suppression | 124, 125, 133 | `contracts-v2.test.ts` |
| Dépôt, remplacement, retrait, formats, taille, 10 photos, chiffrement, conservation 30 j / 48 h, avertissement J-3 | 126, 134 | `contracts-v2.test.ts`, `contract-bricks.test.ts` |
| Interrupteurs et preuves de consentement (analyse, challenge) | 127, 128 | `contracts-v2.test.ts` |
| Transmission, plan, plafond quotidien, proposition de l'autre canal, challenge par email, reprise 1 h, « Renvoyer » | 129, 130, 135 | `contracts-transmit.test.ts` |
| Lecture, masquage en trois couches, états, aperçu, masques à la main, confirmation, remplacement | 136, 137 | `contract-masking.test.ts` (dont le seuil de non-fuite C-16 et les cas de courriers photographiés), `contracts-masking-flow.test.ts` |
| Analyse, rapport, remplacement, références, délai de 10 min, verrou, échec, notification, relance | 131, 132, 135 | `contracts-analysis.test.ts` |
| Analyses à valider : demande, consultation journalisée, masques, décision, expiration, droits | 138 | `contracts-analysis.test.ts` |
| Export et suppression de compte | US-92 | `compliance.test.ts` |

Banc de lecture de bout en bout (hors CI, il faut le service de lecture) : `npm run bench:ocr -- --url <service>` rend des documents fictifs en photos (propre, penchée, sombre), les fait lire, masque et mesure ce qui reste lisible. Il échoue si un identifiant direct reste lisible. Dernier passage sur la zone (02/11/2026) : 0 identifiant direct lisible sur 57 contrôles, 0 nom lisible sur 42, 25 à 27 données utiles gardées sur 27.

## 2. Essai à la main sur la zone (PO)

Se connecter avec un compte noyau (utilisateur principal ou invité 1), onglet **Contrats**.

### Dépôt et masquage (US-126, 136, 137)
- [ ] Ouvrir « Assurance Auto », activer **Analyse IA** : le texte de consentement s'affiche (texte provisoire marqué), accepter.
- [ ] Déposer une photo (ou un PDF) dans « Conditions particulières » : l'état passe à « Masquage en cours » puis « À vérifier ».
- [ ] Ouvrir « Vérifier le texte masqué » : les jetons sont surlignés (« Personne 1 », « Adresse 1 »…), aucun nom ni numéro lisible. Toucher un mot qui reste visible : « Masquer aussi ce mot » le remplace partout ; « Annuler ce masque » le rend.
- [ ] « Confirmer ce document » : « Vérifié par [prénom] le [date] ». Remplacer le document : retour à « Masquage en cours » puis « À vérifier ».
- [ ] Photo floue ou de travers : « Lecture incertaine » (sous 80 %) ; photo illisible : « Document illisible : reprenez une photo plus nette. ».
- [ ] Dans un contrat Mutuelle : l'aide du champ dit « Ne déposez que vos documents contractuels… » ; une page de remboursement déposée est retirée et signalée.

### Transmission et rapport (US-129, 130, 131, 132)
- [ ] Remplir les champs obligatoires, vérifier chaque document : « Transmettre » devient actif, avec « Pour analyse » (ou « Pour analyse et challenge »).
- [ ] Transmettre : « Documents transmis. Ils seront supprimés le … ». Le rapport de démonstration apparaît en tête du contrat, « Analyse — [nom] — [date] », avec la mention finale ; la carte dit « Rapport du … ».
- [ ] Activer seulement un canal : à la transmission, la fenêtre propose l'autre ; « Non, seulement … » transmet sans lui ; Échap ne transmet rien.
- [ ] Deux contrats de la même catégorie : deux rapports distincts.

### Analyses à valider (US-138)
- [ ] Déposer une photo mal lue (sous 80 %), la vérifier, transmettre : le contrat affiche « En cours de vérification par MAAQ ».
- [ ] Console d'administration : « Analyses à valider » (compteur dans le menu). La demande montre la catégorie, le texte masqué, le score, les passages mal lus surlignés ; ni le nom du contrat, ni la famille, ni le document.
- [ ] « Poursuivre l'analyse » (avec confirmation) : le rapport arrive chez la famille. Sur une autre demande, « Ne pas poursuivre » : la famille lit « La lecture de vos documents n'était pas assez fiable… » et reçoit une notification.

### Échec, relance, suppression (US-134, 135)
- [ ] Un rapport qui échoue (essai difficile à provoquer sur la zone : voir `contracts-analysis.test.ts`) affiche « L'analyse a échoué » avec « Relancer l'analyse ».
- [ ] Challenge (courtier désigné) : l'email part avec les originaux en pièces jointes, la catégorie et une référence famille, sans le nom du contrat ; en cas d'échec d'envoi, « Renvoyer » après une heure.
- [ ] 48 h après la transmission, les documents sont supprimés : « Documents supprimés : déposez-les à nouveau pour relancer. » ; le rapport reste.
- [ ] Un contrat non transmis : avertissement unique trois jours avant la suppression à 30 jours.

### Sur téléphone
- [ ] Aperçu du texte masqué lisible, barre « Masquer aussi ce mot » au-dessus de la navigation ; dépôt par l'appareil photo ; zone de transmission.

## 3. Avant l'ouverture réelle de l'analyse

Voir `docs/contrats-v2-mise-en-service.md` : avis du DPO, brief du consultant, accord du PO sur le coût de production, essai du PO sur de vrais documents (couches 2 et 3 avec les vrais membres du foyer).
