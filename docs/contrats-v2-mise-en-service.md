# Contrats V2 : mise en service

État au 02/11/2026 : **tout est en ligne sur la zone de test** (projet `maaq-test`) en mode d'essai. Rien n'est ouvert en production. Ce document dit comment contrôler, ouvrir, et revenir en arrière. `npm run check:contracts` (état) et `npm run check:contracts -- --live` (ce qui bloque l'ouverture réelle) lisent la base et l'environnement du service sans rien modifier.

## Trois niveaux d'ouverture

| Niveau | Réglage | Effet |
|---|---|---|
| Fermé | `CONTRACT_ANALYSIS_MODE=off` (défaut) | L'interrupteur « Analyse IA » est inactif ; aucun document n'est lu ni masqué ; les dépôts, le challenge et « Mes contrats » fonctionnent. |
| Essai | `preview` | Lecture, masquage, aperçu, confirmation, analyses à valider et **rapport de démonstration** ; aucun document n'est envoyé à une IA. |
| Réel | `live` (avec `ASSISTANT_MODE=live`, `ANTHROPIC_API_KEY`) | Le texte masqué part à l'agent d'analyse (API Anthropic). **Fermé jusqu'à l'avis du DPO.** |

Le **challenge** a son propre verrou : il reste fermé aux familles tant que le courtier (nom et email) n'est pas désigné dans la console (Réglages).

**Challenge simulé sur une zone de test** (décision du PO du 13/11/2026, test Friends and family) : quand `MAAQ_ZONE=test`, l'email du challenge ne passe jamais par le serveur d'envoi réel, quelle que soit l'adresse saisie dans la console. Il est déposé dans la boîte de test interne (`/dev/boite`, clé des outils de test), avec un objet commençant par « [Simulation] » et seulement le nom et la taille des pièces jointes. L'écran du contrat ajoute « Essai : vos documents n'ont été envoyés à aucun courtier ». Sur la zone, le courtier de la console est « Courtier simulé (essai) » avec une adresse fictive. La production n'a pas `MAAQ_ZONE` : rien n'y change.

## Ce qui est déjà en place sur la zone de test

- Schéma du lot 11 (appliqué depuis les fichiers d'origine de la base de données, empreintes contrôlées).
- Bucket `maaq-test-contrats` (`europe-west1`) pour les documents chiffrés (`CONTRACT_STORAGE=gcs`, `CONTRACT_BUCKET`).
- Service interne `maaq-lecture` (Cloud Run, sans accès public, 2 vCPU / 4 Go, 0 instance au repos, 3 images conservées) ; `CONTRACT_READER_URL`.
- Tâche planifiée `maaq-cron` (toutes les 5 minutes) : purge, rattrapage du masquage, analyses en cours, délai de 10 minutes, notifications d'échec, reprise du challenge, avertissement J-3.
- Champs de documents des cinq catégories (Assurance auto, Assurance habitation, Mutuelle santé, Assurance emprunteur, Énergie), consigne santé dans l'aide des champs Mutuelle et Emprunteur.

## Pour la production (à faire, rien n'est fait)

À chaque étape, **un accord du PO est nécessaire** : le coût du service de lecture et du bucket n'a été accordé que pour le projet de test.

1. **Sauvegarde** de la base de production, puis application du lot 11 : fichiers d'origine de la base de données (`0015_lot11_valeurs_enumerees.sql` puis `0016_lot11_schema.sql`, ou `rattrapage_lot_11_donnees_existantes.sql` pour une base qui a déjà des contrats V1), empreintes contrôlées (le script refuse si elles diffèrent), puis `deploy/supabase-securiser.sql`. Publier le texte du consentement au challenge (`deploy/donnees_lot_11_texte_challenge.sql`).
2. **Bucket** Cloud Storage chiffré en `europe-west1`, accès réservé au compte de service du service ; **service de lecture** (`services/contract-reader`, même configuration), invocation réservée au compte de service de l'application ; politique de conservation de 3 images.
3. **Variables** du service de l'application : `CONTRACT_STORAGE=gcs`, `CONTRACT_BUCKET`, `CONTRACT_READER_URL`, puis `CONTRACT_ANALYSIS_MODE=preview` pour l'essai. Vérifier la tâche planifiée à 5 minutes.
4. **Contenu** : catégories et champs de documents saisis dans la console (la consigne santé dans l'aide des champs de santé) ; courtier désigné pour ouvrir le challenge.
5. **Contrôle** : `npm run check:contracts` doit ne rien trouver de bloquant ; `npm run bench:ocr -- --url <service>` doit tenir le seuil de non-fuite (C-16) ; recette (`docs/contrats-v2-recette.md`) passée par le PO sur de vrais documents.
6. **Ouverture réelle** (`live`) seulement quand `npm run check:contracts -- --live` ne bloque plus.

## Ce qui bloque l'ouverture réelle (hors technique)

- **Avis du DPO** : traitement hors Union européenne par l'API Anthropic (`inference_geo` « global » ou « us » seulement), pseudonymisation du texte masqué, pièces jointes du challenge, texte de consentement à l'analyse (aujourd'hui provisoire, marqué) (C-06, C-07, C-17).
- **Brief du consultant** : plan et contenu du rapport (C-02, C-05) ; le rapport affiche un contenu de démonstration.
- **Seuil de non-fuite sur de vrais documents** (C-16) : couches 2 (liste du foyer) et 3 (modèle de langue) à mesurer avec de vrais membres.
- **Accord du PO** sur le coût de production du service de lecture et du bucket.

## Revenir en arrière

- Fermer l'analyse : `CONTRACT_ANALYSIS_MODE=off` (`gcloud run services update … --update-env-vars`). Les documents déjà masqués restent chiffrés et sont supprimés à leur échéance.
- Fermer le challenge : vider le nom ou l'email du courtier dans la console (Réglages).
- Le service de lecture n'a aucune donnée à purger : il ne garde rien.
- Le schéma n'a pas de retour arrière prévu : il est additif et vide tant que personne ne dépose de document.

## Exploitation

- **Journaux** : le service de lecture n'écrit que des durées et des compteurs ; l'application écrit les échecs de masquage (`[contrats] masquage reporté`), d'analyse et de notification, sans contenu.
- **Délais** : lecture de l'ordre de 6 s par page scannée (30 pages au plus par document, 10 photos) ; analyse : échec au bout de 10 minutes ; demande « Analyse à valider » : disparaît avec les documents, 48 h après la transmission.
- **Coût** : service de lecture à 0 instance au repos (facturé à l'usage) ; l'agent d'analyse (mode `live`) compte comme une demande dans le plafond quotidien du profil qui transmet.
