# Contrats V2 : état d'avancement et choix techniques

Spécification validée : `Projets Claude/Business Analyst/MAAQ_US_Detaillees_BA_Contrats_V2.md` (US-122 à 139, décisions C-01 à C-19, règles CT-1 à CT-5). Cette page tient le journal de ce qui est construit, des choix faits et de ce qui attend une décision. Les écrans de la V1 (envoi vers Google Drive, tri automatique `classification_*`, consentement par catégorie) disparaissent.

## Étapes

| Étape | Contenu | État |
|---|---|---|
| E0 | Moteur de masquage (US-136) et jeu de non-fuite (C-16) | fait (module pur, non branché) |
| E1 | Administration : catégories, champs de documents, archivage, réglages | fait sur la branche `contrats-v2` (non déployé : le schéma du lot 11 ne s'applique à la zone de test qu'avec E2) |
| E2 | Famille : contrats groupés, complémentaires, dépôt, purge, J-3, consentements | attend le schéma, le stockage des documents |
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
