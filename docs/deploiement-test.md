# Déployer MAAQ sur une zone de test en ligne

Objectif : une adresse web (`https://maaq-test-xxxx.run.app`) où l'on peut essayer MAAQ depuis un téléphone, avec les
comptes de démonstration. Application sur **Google Cloud Run**, base de données sur **Supabase** (PostgreSQL).

> Ce n'est **pas** une mise en production : Digitorn, Google, les emails et les SMS restent simulés (voir
> `docs/comptes-de-test.md`). N'y mets aucune vraie donnée de personne.

Les commandes sont pour **PowerShell** (Windows), chacune sur une seule ligne. Remplace ce qui est en MAJUSCULES.

## Vue d'ensemble

```
Ton PC ──migrations──▶ Supabase (base PostgreSQL)
   │                        ▲
   └─ gcloud run deploy ─▶ Cloud Run (MAAQ) ──connexion chiffrée──┘
                              ▲
                  Cloud Scheduler (toutes les 5 min : carnet, suppressions, exports)
```

---

## Partie A — La base de données sur Supabase

### A1. Créer le compte
1. Va sur https://supabase.com, clique **Start your project** et connecte-toi (le plus simple : avec ton compte GitHub).

### A2. Créer le projet
1. **New project** (dans une organisation, à créer si c'est la première fois).
2. **Name** : `maaq-test`.
3. **Database Password** : clique sur **Generate a password**, puis **copie-le et garde-le** (gestionnaire de mots de passe). Il ne sera plus affiché.
   Un mot de passe de lettres et chiffres évite les caractères spéciaux à encoder dans l'adresse de connexion.
4. **Region** : une région **européenne**, proche de celle de Cloud Run (`europe-west1`, en Belgique) : *West EU (Ireland)* ou *Central EU (Frankfurt)*. Note laquelle tu choisis.
5. Plan **Free**. **Create new project** et attends environ 2 minutes.

### A3. Récupérer l'adresse de connexion
1. En haut de la page du projet, clique **Connect**.
2. Onglet **Connection string** ou **ORMs** : choisis la méthode **Session pooler** (adresse du type
   `aws-0-eu-west-1.pooler.supabase.com`, port **5432**).
3. Copie l'adresse. Elle ressemble à :
   `postgresql://postgres.abcdefghijklmno:[YOUR-PASSWORD]@aws-0-eu-west-1.pooler.supabase.com:5432/postgres`
4. Remplace `[YOUR-PASSWORD]` par ton mot de passe (sans les crochets).

> **Pourquoi le « Session pooler » ?** Cloud Run n'a pas d'IPv6, et la connexion directe de Supabase (`db.xxx.supabase.co`)
> est IPv6 seulement sur l'offre gratuite. Le Session pooler passe en IPv4.
> **N'ajoute pas `?sslmode=...`** à l'adresse : MAAQ active le chiffrement avec `DATABASE_SSL=require`.

### A4. Fermer l'accès web direct aux tables (important)
Supabase propose par défaut une interface web (Data API) qui peut lire les tables avec une clé publique. MAAQ n'en a
pas besoin et ses tables contiennent des données personnelles.
1. **Project Settings** (roue crantée) ▸ **API** (ou **Data API**) ▸ désactive **Enable Data API** si l'option existe.
2. Dans tous les cas, fais aussi l'étape A7 (elle verrouille les tables même si l'interface est active).

### A5. Créer les tables (migrations), depuis ton PC
Dans PowerShell, à la racine du projet (`MAAQ Projet`) :

```powershell
$env:DATABASE_URL = "COLLE_ICI_L_ADRESSE_DE_L_ETAPE_A3"
$env:DATABASE_SSL = "require"
npm run db:migrate
```

Résultat attendu : `Migrations appliquées : 0001_schema_initial.sql, 0002_…, 0003_…, 0004_…, 0005_compliance.sql`.
Si tu relances, il affiche `Base déjà à jour.`

### A6. Créer les comptes de démonstration
Choisis un mot de passe **à toi** pour la zone de test (pas celui de la documentation, l'adresse sera publique) :

```powershell
$env:DEMO_PASSWORD = "UN_MOT_DE_PASSE_A_TOI_12_CARACTERES_MINIMUM"
npm run db:seed
```

Résultat : `Données de démonstration créées.` (administrateur, Camille, Dominique, Lou, agents, contrats).
Les emails sont les mêmes que dans `docs/comptes-de-test.md` ; seul le mot de passe change.

### A7. Verrouiller les tables
1. Dans Supabase : **SQL Editor** ▸ **New query**.
2. Ouvre le fichier `deploy/supabase-securiser.sql` du projet, copie tout son contenu, colle-le, clique **Run**.
3. Le résultat final doit lister toutes les tables avec `rls_active = true`.

Fin de la partie A. Garde l'adresse de l'étape A3 (avec le mot de passe) : tu en auras besoin.

---

## Partie B — L'application sur Google Cloud Run

### B1. Préparer Google Cloud
1. Il faut un compte Google, et un projet avec la **facturation activée** : https://console.cloud.google.com ▸ *Nouveau projet*.
   L'**identifiant du projet** (Project ID) est en minuscules avec des tirets (par exemple `maaq-test-123456`) : copie-le depuis la console.
2. Installe l'outil en ligne de commande, puis **ferme et rouvre ton terminal** :
   ```powershell
   winget install --id Google.CloudSDK -e
   ```
3. Connecte-toi et choisis le projet :
   ```powershell
   gcloud auth login
   gcloud config set project TON_PROJECT_ID
   ```
4. Active les services nécessaires :
   ```powershell
   gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com cloudscheduler.googleapis.com
   ```

### B2. Générer les secrets de cet environnement
```powershell
npm run deploy:secrets
```
Il affiche six lignes `NOM=valeur` (clés de chiffrement, secret du planificateur, clé des outils de test…).
**Copie-les maintenant** : elles ne sont affichées qu'une fois. Ce ne sont pas celles de ton `.env` : ne les réutilise pas.

### B3. Les ranger dans Secret Manager
Colle d'abord cette fonction (elle écrit chaque secret sans retour à la ligne parasite) :

```powershell
function New-Secret($name, $value) { $f = New-TemporaryFile; Set-Content -Path $f -Value $value -NoNewline; gcloud secrets create $name --data-file=$f; Remove-Item $f }
```

Puis une ligne par secret, avec les valeurs de l'étape B2 (et l'adresse de la base de l'étape A3) :

```powershell
New-Secret DATABASE_URL "ADRESSE_DE_LA_BASE_ETAPE_A3"
New-Secret ENCRYPTION_KEY "VALEUR"
New-Secret HMAC_KEY "VALEUR"
New-Secret AUTH_SECRET "VALEUR"
New-Secret CRON_SECRET "VALEUR"
New-Secret BILLING_WEBHOOK_SECRET "VALEUR"
New-Secret MAAQ_DEV_TOOLS_KEY "VALEUR"
```

Autorise ensuite Cloud Run à les lire (les deux commandes à la suite) :

```powershell
$numero = gcloud projects describe TON_PROJECT_ID --format="value(projectNumber)"
gcloud projects add-iam-policy-binding TON_PROJECT_ID --member="serviceAccount:$numero-compute@developer.gserviceaccount.com" --role="roles/secretmanager.secretAccessor"
```

### B4. Construire et déployer
Toujours à la racine du projet. Une seule commande construit l'image (Cloud Build, avec le `Dockerfile` du projet) et la déploie :

```powershell
gcloud run deploy maaq-test --source . --region europe-west1 --allow-unauthenticated --port 8080 --memory 1Gi --min-instances 0 --max-instances 1 --set-env-vars "DIGITORN_MODE=mock,MESSAGING_MODE=dev,DRIVE_MODE=local,MAAQ_ZONE=test,MAAQ_SCHEDULER=off,DATABASE_SSL=require,APP_URL=https://a-remplacer.invalid" --set-secrets "DATABASE_URL=DATABASE_URL:latest,ENCRYPTION_KEY=ENCRYPTION_KEY:latest,HMAC_KEY=HMAC_KEY:latest,AUTH_SECRET=AUTH_SECRET:latest,CRON_SECRET=CRON_SECRET:latest,BILLING_WEBHOOK_SECRET=BILLING_WEBHOOK_SECRET:latest,MAAQ_DEV_TOOLS_KEY=MAAQ_DEV_TOOLS_KEY:latest"
```

- La première fois, `gcloud` propose de créer un dépôt d'images (« Artifact Registry ») : réponds `Y`.
- Compte 3 à 8 minutes pour la construction.
- `--max-instances 1` : le Digitorn simulé garde ses conversations en mémoire, une seule instance évite des réponses incohérentes.
- `--min-instances 0` : le service s'éteint sans visiteur (gratuit), mais le premier accès après une pause prend quelques secondes.

### B5. Donner à l'application sa propre adresse
L'adresse n'est connue qu'après le premier déploiement. Récupère-la :

```powershell
gcloud run services describe maaq-test --region europe-west1 --format "value(status.url)"
```

Puis dis à l'application où elle se trouve (liens des emails, retours Google simulés) :

```powershell
gcloud run services update maaq-test --region europe-west1 --update-env-vars "APP_URL=https://L_ADRESSE_AFFICHEE"
```

### B6. Lancer les traitements périodiques
Cloud Run s'éteint sans visiteur : le planificateur intégré à MAAQ ne tourne donc pas. Cloud Scheduler appelle à sa place
toutes les 5 minutes l'adresse qui synchronise le carnet, prépare les exports et exécute les suppressions arrivées à échéance :

```powershell
gcloud scheduler jobs create http maaq-cron --location europe-west1 --schedule "*/5 * * * *" --uri "https://L_ADRESSE_AFFICHEE/api/cron/run" --http-method POST --headers "Authorization=Bearer VALEUR_DE_CRON_SECRET"
```

### B7. Vérifier
1. Ouvre `https://L_ADRESSE_AFFICHEE/api/health` : tu dois voir `{"status":"ok","migrations":5}`.
2. Ouvre `https://L_ADRESSE_AFFICHEE` sur ton téléphone : l'écran de bienvenue puis la connexion.
3. Connecte-toi avec `camille@maaq.test` et le mot de passe choisi à l'étape A6.
4. Sur un navigateur neuf, un **code de vérification** est demandé. Il n'arrive pas par email : ouvre, une première fois,
   `https://L_ADRESSE_AFFICHEE/dev/boite?cle=VALEUR_DE_MAAQ_DEV_TOOLS_KEY` (la clé de l'étape B2). Elle est mémorisée 12 heures dans ce
   navigateur ; sans elle, ces pages répondent « introuvable ».
5. Pour déclencher tout de suite la synchronisation du carnet : `https://L_ADRESSE_AFFICHEE/api/dev/sync` (méthode POST).

---

## Mettre à jour la zone de test
Après de nouveaux changements dans le code, depuis la racine du projet :

```powershell
gcloud run deploy maaq-test --source . --region europe-west1
```

Les réglages et secrets déjà enregistrés sont conservés. Si une migration a été ajoutée : relance d'abord l'étape A5
(`npm run db:migrate` avec `DATABASE_URL` et `DATABASE_SSL`), puis l'étape A7.

## Ce que ça coûte
| Poste | Coût |
|---|---|
| Cloud Run (usage de test, éteint sans visiteur) | gratuit dans les limites mensuelles offertes |
| Cloud Build, Secret Manager (7 secrets), Cloud Scheduler (1 tâche) | gratuit ou quelques centimes à ce volume |
| Supabase, offre Free | gratuit ; le projet est **mis en pause après une période d'inactivité** (le relancer depuis le tableau de bord) |

À vérifier sur les pages de tarifs avant de t'engager : ils changent.

## Sécurité de cette zone de test
- L'adresse est publique : toute personne qui la connaît peut afficher la page de connexion. Les comptes de démonstration y sont
  protégés par le mot de passe choisi à l'étape A6 ; ne le partage qu'avec les testeurs.
- La boîte de test (qui contient les codes de connexion) n'est lisible qu'avec la clé `MAAQ_DEV_TOOLS_KEY`.
- N'y saisis aucune vraie donnée de personne : les documents envoyés sont stockés sur le disque temporaire du service
  (effacé à chaque redémarrage) et les services externes sont simulés.
- Les secrets sont dans Secret Manager, jamais dans l'image ni dans le code.

## Dépannage
| Message | Cause probable |
|---|---|
| `gcloud : le terme n'est pas reconnu` | Fermer et rouvrir le terminal après l'installation. |
| `INVALID_ARGUMENT` sur `config set project` | Le Project ID est en minuscules avec des tirets : le copier depuis la console. |
| Erreur de facturation | Activer la facturation sur https://console.cloud.google.com/billing. |
| Le déploiement réussit mais `/api/health` répond 500 | Voir les journaux : `gcloud run services logs read maaq-test --region europe-west1 --limit 50`. Cause fréquente : mauvaise adresse de base (mot de passe, ou connexion directe au lieu du *Session pooler*). |
| `no pg_hba.conf entry` ou `SSL` | `DATABASE_SSL=require` manquant, ou `sslmode` ajouté à l'adresse (le retirer). |
| `ENETUNREACH` / `ETIMEDOUT` vers `db.xxx.supabase.co` | Adresse de connexion directe (IPv6) : utiliser celle du *Session pooler*. |
| `Permission denied on secret` | Refaire la commande `add-iam-policy-binding` de l'étape B3. |
| Connexion impossible (code de vérification) | Ouvrir `/dev/boite?cle=…` avec la clé de l'étape B2. |
| Projet Supabase en pause | Le relancer depuis https://supabase.com/dashboard. |
