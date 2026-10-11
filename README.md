# MAAQ

Vos agents IA pour l'administratif et le quotidien, en toute transparence.

Application web mobile installable (PWA) avec sa console d'administration, construite à partir de :

- `docs/specs/MAAQ_US_Detaillees_BA.md` — les 70 user stories détaillées ;
- `docs/specs/MAAQ_BDD_Conception.md` et `db/migrations/0001_schema_initial.sql` — la base de données ;
- `docs/maquettes/` — les maquettes HTML (ouvrir un fichier `.html` dans un navigateur).

## Stack

| Couche | Choix |
|---|---|
| Application | Next.js 16 (App Router), React 19, TypeScript |
| Base de données | PostgreSQL 17, schéma SQL de la conception appliqué tel quel, requêtes typées avec Kysely |
| Sécurité | argon2id (mots de passe, schémas), AES-256-GCM (informations des agents), SHA-256 (jetons, codes) |
| Tests | Vitest (unitaires et base de données réelle) |
| Services externes | Digitorn, emails/SMS et Google Drive derrière des adaptateurs, simulés en développement |

## Prérequis

- Node.js 20.9 ou plus récent (testé avec Node 24) — c'est tout : la base PostgreSQL est embarquée.

## Démarrer

```bash
npm install
npm run dev
```

Au premier lancement, `npm run dev` :

1. crée `.env` à partir de `.env.example` avec des clés locales générées ;
2. démarre un PostgreSQL embarqué dans `.data/pg` (port 5433) ;
3. applique les migrations et crée les comptes de démonstration (voir `docs/comptes-de-test.md`) ;
4. lance l'application sur http://localhost:3000.

Ctrl-C arrête l'application et la base.

## Outils de développement

| Adresse | Rôle |
|---|---|
| http://localhost:3000/dev/charte | Charte et composants de base |
| http://localhost:3000/dev/digitorn | Simulateur Digitorn : demandes, actions à valider |
| http://localhost:3000/dev/boite | Boîte de test : emails et SMS « envoyés » par l'application |

Ces pages n'existent pas en production.

## Commandes

| Commande | Rôle |
|---|---|
| `npm run dev` | Base embarquée + application en développement |
| `npm test` | Tests automatiques (démarre sa propre base temporaire) |
| `npm run lint` / `npm run typecheck` | Qualité du code |
| `npm run build` / `npm start` | Version de production |
| `npm run db:start` | Base embarquée seule |
| `npm run db:migrate` | Applique les migrations sur `DATABASE_URL` |
| `npm run db:seed` | Ajoute les données de démonstration |
| `npm run db:reset` | Efface et recrée la base de développement |
| `npm run db:types` | Régénère `src/server/db/schema.generated.ts` depuis la base |

## Organisation du code

```
db/migrations/          Migrations SQL, appliquées dans l'ordre
scripts/                Démarrage, base embarquée, données de démonstration
src/app/                Écrans et routes d'API (Next.js)
src/client/             Client réseau commun (comportements CC-1 à CC-10) et hooks
src/components/ui/      Composants de base aux couleurs des maquettes
src/server/adapters/    Digitorn, messagerie, Google Drive (simulés pour l'instant)
src/server/db/          Connexion, migrations, types générés
src/server/security/    Mots de passe, chiffrement, jetons et codes
tests/                  Tests Vitest
```

## Branches

Le développement se fait sur `test`. `master` et `prod` ne sont modifiées qu'après validation.

## Suivi de l'avancement

`build-status.json` est lu par `dashboard.html` :

```bash
python -m http.server 4321
```

puis ouvrir http://localhost:4321/dashboard.html.
