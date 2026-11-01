# Contrats V2 : état d'avancement et choix techniques

Spécification validée : `Projets Claude/Business Analyst/MAAQ_US_Detaillees_BA_Contrats_V2.md` (US-122 à 139, décisions C-01 à C-19, règles CT-1 à CT-5). Cette page tient le journal de ce qui est construit, des choix faits et de ce qui attend une décision. Les écrans de la V1 (envoi vers Google Drive, tri automatique `classification_*`, consentement par catégorie) disparaissent.

## Étapes

| Étape | Contenu | État |
|---|---|---|
| E0 | Moteur de masquage (US-136) et jeu de non-fuite (C-16) | fait (module pur, non branché) |
| E1 | Administration : catégories, champs de documents, archivage, réglages | fait sur la branche `contrats-v2` (non déployé : le schéma du lot 11 ne s'applique à la zone de test qu'avec E2) |
| E2 | Famille : contrats groupés, complémentaires, dépôt, purge, J-3, consentements | fait et **en ligne sur la zone de test** (révision 00054, 02/11/2026) avec le lot 11 |
| E3 | Transmission et challenge par email | après E2 |
| E4 | OCR, reconnaissance des noms propres, aperçu (US-137) | attend l'accord sur le coût du stockage et du service interne |
| E5 | Analyse, rapport, validation administrateur (US-138) | après E4 |
| E6 | Recette, mise en service | à la fin |

## Branche et schéma

Développement sur la branche `contrats-v2` (partie de `assistant-famille`). Le schéma final du lot 11 est recopié depuis la base de données : `db/migrations/0015_lot11_valeurs_enumerees.sql` (930347978665…), `0016_lot11_schema.sql` pour une base neuve (df7dbf501a46…) ; pour une base qui contient déjà des contrats (zone de test, base locale) : `0015` puis `deploy/rattrapage_lot_11_donnees_existantes.sql` (72a5f7168a69…) À LA PLACE de `0016`, une seule fois, après une sauvegarde vérifiée et un contrôle des empreintes juste avant. Appliqué sur la base locale le 02/11/2026 ; structure comparée à une base neuve migrée d'un coup : aucun écart sur le lot 11 (seules les partitions mensuelles du carnet de bord diffèrent, créées selon la date). **Ne pas appliquer sur la zone de test avant le déploiement d'E2**, qui remplace la page Contrats de la V1 (le rattrapage change `account_contracts` et vide `contract_documents`). Tant qu'E2 n'est pas livrée, les tests de la V1 des contrats échouent sur cette branche : c'est attendu.

## E1 : administration (US-122, US-123, US-139, US-65)

- `src/server/admin/contracts.ts` : catégories (liste avec archivées, nombre de familles et de contrats), champs de documents (ajout, renommage, aide, obligatoire, ordre, retrait avec le nombre de documents supprimés), archivage, suppression d'une catégorie sans contrat. Les refus de la base (nom déjà pris, 10 champs au plus, au moins un champ obligatoire, catégorie archivée) sont traduits en messages. Journal d'administration : `contract_document_field_changed` ; la suppression d'une catégorie est notée `contract_updated` avec `deleted: true` (la liste d'actions de la base n'a pas de valeur dédiée).
- Routes : `/api/admin/contracts/[id]/archive`, `/document-fields`, `/document-fields/[fieldId]` ; `DELETE /api/admin/contracts/[id]` supprime (et n'archive plus).
- Écrans : liste « Catégories de contrats » (archivées grisées), détail avec « Documents attendus » (`DocumentFieldsPanel`) puis les champs de détail ; Réglages : plafond de contrats, conservation, seuil de lecture, nom et adresse du courtier (texte libre ajouté).
- Tests : `tests/admin-contracts-v2.test.ts`.

## E2 : famille, contrats et documents (US-124 à 128, 130 en partie, 133, 134)

- `src/server/contracts/service.ts` (remplace la V1) : « Mes contrats » groupés par catégorie, contrat de base créé d'office (`ensure_base_contracts`) ; contrats complémentaires (ajout, nom unique, plafond, renommage, suppression avec retrait des consentements journalisé) ; détails texte (US-33, US-35) ; interrupteurs « Analyse IA » et « Challenge » avec preuve de consentement par contrat et version du texte ; dépôt d'un document par champ (un PDF, ou 1 à 10 photos qui forment un seul document), remplacement, retrait, aperçu. Un contrat est celui d'une famille : aucune opération ne traverse un compte.
- Stockage (`storage.ts`) : les fichiers sont chiffrés par l'application (AES-256-GCM) avant d'être confiés au stockage ; seule la clé d'objet est en base. `CONTRACT_STORAGE=local` (dossier de données : développement et tests) ou `gcs` (bucket Cloud Storage en `europe-west1`, avec `CONTRACT_BUCKET`, accès par le compte de service de Cloud Run). La suppression d'un fichier passe par la file de la base (`storage_deletion_queue`) : jamais avant la suppression de la ligne.
- Entretien horaire (`maintenance.ts`, branché sur `/api/cron/run`) : purge des documents échus (48 h après la transmission, 30 jours sans transmission), fichiers effacés, avertissement unique « supprimés dans 3 jours » au déposant (push, sinon email), reporté à 8 h s'il tombe entre 21 h et 8 h, texte propre aux catégories archivées.
- Conformité : l'export (US-55) contient les documents encore présents, les rapports, les consentements par canal et par contrat ; la suppression d'un compte vide la file de suppression des fichiers.
- Écrans : liste « Mes contrats » (catégories, cartes à interrupteurs), détail d'un contrat (`/contrats/[id]`) avec nom, détails, documents par champ (envoi avec progression, « Annuler », « Réessayer »). La transmission arrive avec E3, le masquage et l'aperçu avec E4.
- **Écarts à connaître** : (1) le texte du consentement au challenge en base est celui de la V1 (« L'entreprise [nom du partenaire] … ») : il est affiché tel quel avec le nom du courtier ; l'US-128 RF2 demande « Les documents de [nom du contrat] seront transmis à [courtier], partenaire de MAAQ, pour challenger votre contrat. » : à publier comme nouvelle version du texte (donnée de la base). (2) Le texte du consentement à l'analyse est PROVISOIRE et marqué comme tel, en attendant le DPO (C-07) ; il est créé dans la base au premier consentement. (3) « Supprimé le [date] » après la purge (US-134 RF3) n'est pas affiché : la base ne garde pas la date de suppression d'un document ; la date de suppression est annoncée avant (`expiresAt`).

## Mise en ligne d'E2 sur la zone de test (02/11/2026)

- Sauvegarde de la base relue avant la migration (110 tables, 1 097 lignes) ; lot 11 appliqué depuis les fichiers d'origine de la base de données après contrôle des empreintes (`lot_11_1` 9303…44c9, `rattrapage_lot_11_donnees_existantes` 72a5…afd9) ; le contrat V1 existant est devenu le contrat de base de sa catégorie ; script de sécurisation Supabase rejoué. Les copies versionnées ont les mêmes empreintes dans le dépôt (fins de ligne LF) ; une copie extraite sous Windows peut avoir des fins de ligne CRLF et une autre empreinte : toujours contrôler les fichiers d'origine.
- Bucket `maaq-test-contrats` (Cloud Storage, `europe-west1`, classe Standard, accès uniforme, accès public interdit, règle de sécurité : suppression au bout de 45 jours), droit `objectAdmin` au seul compte de service de Cloud Run ; `CONTRACT_STORAGE=gcs`, `CONTRACT_BUCKET=maaq-test-contrats`. Les appels de dépôt, de lecture et de suppression ont été vérifiés avec un jeton d'administration ; le chemin par le compte de service de Cloud Run attend un premier dépôt réel depuis un compte famille.
- L'analyse IA reste fermée (`CONTRACT_ANALYSIS_MODE` non défini = `off`). Le service interne OCR et NER n'est pas créé : il le sera avec E4.

## Interrupteur de l'analyse IA : `CONTRACT_ANALYSIS_MODE`

`off` (défaut) : l'interrupteur « Analyse IA » est inactif, aucun appel. `preview` : masquage et aperçu fonctionnent, la transmission pour analyse ne fait aucun appel au modèle. `live` : appel réel, demande `ASSISTANT_MODE=live`, à ouvrir seulement après l'avis du DPO (C-07, C-17). Fermé par défaut sur la zone de test, comme `OUTINGS_MODE`.

## Briques pures déjà écrites (sans base ni service externe)

- `src/server/contracts/masking/` : masquage en trois couches prévues. Faites : règles avec contrôle (IBAN, numéro de sécurité sociale, plaques, téléphones, emails, valeurs après étiquette, adresses, civilités), liste du foyer tolérante aux erreurs de lecture, mots ajoutés à la main, pages de santé retirées ou douteuses. À faire en E4 : reconnaissance des noms propres inconnus par un modèle de langue français (couche 3).
  - Jetons typés et stables dans un contrat (`[PERSONNE_1]`) ; un membre du foyer est reconnu par son prénom et devient une référence ; un nom de famille partagé ne désigne personne.
  - Naissance → âge, permis → ancienneté, code postal et ville → département. Les montants, franchises, plafonds, dates d'échéance et noms d'assureurs sont gardés.
  - Rien de ce qui est masqué n'est conservé : le résultat porte le texte masqué, des compteurs par type et les références aux membres.
- `retention.ts` : suppression 48 h après la transmission, ou 30 jours sans transmission, avertissement unique à J-3 (27 jours), reporté à 8 h s'il tombe entre 21 h et 8 h (heure de la famille) ; texte propre à une catégorie archivée.
- `transmission.ts` : ce qui autorise ou bloque la transmission pour analyse (champ obligatoire vide, masquage en cours, document non confirmé, illisible obligatoire, page de santé douteuse), documents facultatifs illisibles laissés de côté, lecture incertaine → décision d'un administrateur.
- `report.ts` : nettoyage du HTML du rapport (liste blanche de balises, aucun attribut, aucun lien), jetons → références `[[membre:id]]` ou forme neutre, affichage, contrôle qu'aucun motif personnel ne reste, mention finale obligatoire ajoutée par le code.
- `analysis.ts` : cadre de l'agent d'analyse (entrée = catégorie + texte masqué, jamais le nom du contrat ; sortie contrôlée). **Le plan du rapport est un contenu de démonstration** : le brief du consultant (C-05) n'est pas livré.

## Tests

`tests/contract-masking.test.ts` : jeu fictif annoté (auto, habitation, emprunteur) et 240 identifiants tirés au hasard (seuil C-16 : aucune fuite d'identifiant direct, ≥ 99 % des identifiants structurés masqués). `tests/contract-bricks.test.ts` : conservation, transmission, rapport, agent.

## Décisions et points ouverts

- Décidé (PO, 01/11/2026) : texte masqué seul en V1, aperçu obligatoire pendant le pilote, pages de santé refusées, OCR auto-hébergé en UE, échec ou doute = jamais d'envoi en clair, challenge = originaux.
- **En attente de l'accord du PO sur les coûts** : bucket Cloud Storage en `europe-west1` pour les documents chiffrés, service Cloud Run interne (OCR et reconnaissance des noms).
- En attente : empreintes finales du lot 11 (BDD), documents fictifs photographiés pour mesurer l'OCR (PO), contenu du rapport (consultant, C-05), texte du consentement à l'analyse (DPO, C-07), pièces jointes du challenge (DPO, C-06), traitement hors UE (DPO, C-17).
