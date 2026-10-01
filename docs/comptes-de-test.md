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
