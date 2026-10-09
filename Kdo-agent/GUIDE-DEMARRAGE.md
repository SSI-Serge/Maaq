# MAAQ — Guide de démarrage (sans compétence technique)

Ce guide explique comment faire tourner MAAQ sur votre ordinateur, où mettre les clés, et lesquelles sont nécessaires. Comptez 20 minutes la première fois. Le document technique pour les développeurs est le `README.md` à la racine de l'application (un niveau au-dessus de ce dossier).

## 1. Ce dont vous avez besoin

| Quoi | Obligatoire ? | Pour quoi faire |
|---|---|---|
| Un ordinateur Mac ou Windows avec internet | Oui | Faire tourner l'application en local |
| Node.js (logiciel gratuit) | Oui | C'est le moteur qui exécute l'application |
| Une clé API Anthropic | Oui, pour que l'agent kdo_help réponde vraiment | Sans elle, l'application fonctionne mais l'agent répond par des phrases toutes faites |
| Un compte WhatsApp Business (Meta) | Non | Seulement pour que de vrais messages WhatsApp partent. Sans lui, un simulateur intégré fait le travail |
| Un compte Brevo (emails) | Non | Seulement pour que de vrais emails partent. Sans lui, les emails arrivent dans une boîte de test intégrée |

Rien à payer pour commencer, à part l'usage de la clé Anthropic (quelques centimes par demande à l'agent).

## 2. Installer Node.js

1. Allez sur https://nodejs.org et téléchargez la version **LTS** (le bouton de gauche).
2. Ouvrez le fichier téléchargé et suivez l'installation en laissant tous les choix par défaut.
3. Vérifiez : ouvrez l'application **Terminal** (Mac : Applications › Utilitaires › Terminal ; Windows : menu Démarrer, tapez `PowerShell`), tapez la ligne ci-dessous puis Entrée.

```bash
node --version
```

Vous devez voir un numéro de version qui commence par `v20` ou plus (par exemple `v22.11.0`). Si vous voyez une erreur, l'installation n'a pas abouti : recommencez l'étape 1.

## 3. Récupérer le code

Deux façons, au choix.

**Sans Git (le plus simple)**
1. Allez sur https://github.com/SSI-Serge/Maaq/tree/ulrichagents
2. Cliquez sur le bouton vert **Code**, puis **Download ZIP**.
3. Décompressez le fichier. Vous obtenez un dossier `Maaq-ulrichagents` : placez-le où vous voulez, par exemple dans Documents, et renommez-le `Maaq` si vous le souhaitez.

**Avec Git**, si vous l'avez déjà :

```bash
git clone --branch ulrichagents https://github.com/SSI-Serge/Maaq.git
```

Dans la suite, « le dossier de l'application » désigne ce dossier (celui qui contient `package.json`, `README.md` et ce guide).

## 4. Première installation

Dans le Terminal, placez-vous dans le dossier de l'application. Le plus simple : tapez `cd ` (avec un espace), glissez le dossier depuis le Finder ou l'Explorateur dans la fenêtre du Terminal, puis Entrée. Ensuite :

```bash
npm install
```

Cette commande télécharge les composants nécessaires. Elle prend une à trois minutes et affiche beaucoup de texte : c'est normal. Des lignes `npm warn` ne sont pas des erreurs.

## 5. Démarrer l'application

Toujours dans le dossier de l'application :

```bash
npm run dev
```

Au premier lancement, l'application :
- crée automatiquement un fichier `.env` (vos réglages, voir l'étape 6) avec des clés de sécurité locales ;
- démarre sa propre base de données (rien à installer) ;
- crée des comptes de démonstration.

Quand vous voyez `Ready`, ouvrez http://localhost:3000 dans votre navigateur. Pour arrêter l'application : dans le Terminal, appuyez sur `Ctrl` + `C`. Pour la relancer : `npm run dev` à nouveau.

### Se connecter

Comptes de démonstration (mot de passe commun : `Demo-maaq-2026`) :

| Rôle | Email |
|---|---|
| Utilisateur principal | camille@maaq.test |
| Invité | dominique@maaq.test |
| Administrateur | admin@maaq.test |

À la première connexion sur un navigateur, l'application demande un **code de vérification**. Il n'est pas envoyé par email : il s'affiche sur http://localhost:3000/dev/boite (la « boîte de test »). Elle vous demande ensuite de dessiner un **schéma tactile** (reliez au moins quatre points) : c'est ce schéma qui déverrouille l'application par la suite. Si vous l'oubliez, « Schéma oublié ? » envoie un code dans la même boîte de test.

## 6. Le fichier `.env` : où mettre les clés

Le fichier `.env` se trouve à la racine du dossier de l'application. Il est créé au premier démarrage. C'est un simple fichier texte : ouvrez-le avec TextEdit (Mac) ou le Bloc-notes (Windows). Si vous ne le voyez pas, c'est que les fichiers dont le nom commence par un point sont cachés : sur Mac, dans le Finder, appuyez sur `Cmd` + `Maj` + `.` pour les afficher.

Règles :
- Une ligne = un réglage, sous la forme `NOM=valeur`, sans espace autour du `=`.
- Une ligne qui commence par `#` est un commentaire ignoré. Pour activer un réglage commenté, retirez le `#` au début de la ligne.
- Après toute modification, **arrêtez et relancez** l'application (`Ctrl` + `C`, puis `npm run dev`).
- **Ne partagez jamais ce fichier** et ne l'envoyez jamais sur GitHub : il contient vos clés. Il est déjà exclu des envois.

### 6a. Clé Anthropic (pour que l'agent réponde vraiment)

1. Créez un compte sur https://console.anthropic.com et ajoutez un moyen de paiement (menu Billing). Le paiement est à l'usage : avec l'application en test, comptez quelques centimes par message envoyé à l'agent.
2. Menu **API Keys** › **Create Key**. Donnez-lui un nom (par exemple « MAAQ test ») et copiez la clé affichée : elle commence par `sk-ant-` et ne sera plus jamais affichée ensuite.
3. Dans `.env`, trouvez ces lignes :

```
LOCAL_AGENTS_MODE=off
# LOCAL_AGENTS_MODEL=claude-opus-5-5
# ANTHROPIC_API_KEY=
```

et remplacez-les par (en collant votre clé après le `=`) :

```
LOCAL_AGENTS_MODE=anthropic
ANTHROPIC_API_KEY=sk-ant-votre-cle-ici
```

4. Relancez l'application. Connectez-vous comme Camille, ouvrez le tchat de **kdo_help** et écrivez par exemple « Ajoute ma fille Léa, née le 15 octobre 2019, fan de dinosaures ». Si l'agent répond en reprenant ces informations, la clé fonctionne.

Facultatif : la ligne `LOCAL_AGENTS_MODEL` choisit le modèle. Sans elle, c'est `claude-opus-5-5` (le plus capable). Pour diviser le coût par deux, mettez `LOCAL_AGENTS_MODEL=claude-sonnet-5-5`.

Si l'agent répond « Je n'ai pas réussi à répondre. Réessayez dans un instant. », regardez le Terminal : une ligne commençant par `[agents]` explique le problème (clé invalide, crédit épuisé…).

### 6b. WhatsApp (facultatif)

Sans rien configurer, WhatsApp est **simulé** : rien ne part, et la page http://localhost:3000/dev/whatsapp permet d'écrire comme depuis un téléphone et de voir ce que MAAQ répondrait. C'est suffisant pour essayer toute la fonctionnalité (liaison du numéro, demandes à l'agent, boutons de confirmation, rappels).

Pour que de vrais messages WhatsApp partent, il faut un compte WhatsApp Business chez Meta, une vérification d'entreprise et des modèles de messages approuvés par Meta : c'est une démarche de plusieurs jours, décrite pas à pas dans `whatsapp.md` (même dossier que ce guide). Elle demande aussi que l'application soit accessible sur internet (voir l'étape 8). Les réglages à remplir ensuite dans `.env` sont :

```
WHATSAPP_MODE=cloud
WHATSAPP_ACCESS_TOKEN=        (jeton permanent fourni par Meta)
WHATSAPP_PHONE_NUMBER_ID=     (identifiant du numéro, fourni par Meta)
WHATSAPP_APP_SECRET=          (secret de l'application Meta)
WHATSAPP_VERIFY_TOKEN=        (un mot de passe long que vous inventez, à saisir aussi chez Meta)
WHATSAPP_BUSINESS_NUMBER=     (votre numéro WhatsApp, chiffres seuls, ex. 33612345678)
```

### 6c. Emails réels (facultatif)

Par défaut, aucun email ne part : tout arrive sur http://localhost:3000/dev/boite. Pour envoyer de vrais emails (codes de connexion, invitations), il faut un compte Brevo : la marche à suivre est dans `docs/emails-brevo.md`, et les réglages sont les lignes `MESSAGING_MODE=smtp`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` et `MAIL_FROM` du fichier `.env`.

## 7. Essayer l'agent kdo_help

Une fois connecté comme Camille :
1. **Catalogue** › onglet **Perso** › **kdo_help** › **Ajouter à mon dashboard**.
2. Dashboard › onglet **Perso** › **Ouvrir le tchat**.
3. Essayez : « Ajoute mon frère Thomas, né le 28 octobre 1992, fan de vélo, budget 150 € », puis « Une idée de cadeau pour Thomas », puis « Quels anniversaires arrivent bientôt ? ». Une demande de suppression (« Supprime Thomas ») affiche une carte à valider : rien n'est supprimé tant que vous ne validez pas.
4. **Réglages** › **WhatsApp et rappels** : cochez le consentement, cliquez **Connecter WhatsApp**, puis sur http://localhost:3000/dev/whatsapp envoyez le code affiché. Vous pouvez ensuite écrire à l'agent depuis cette page comme depuis WhatsApp ; la conversation apparaît aussi dans le tchat de l'application.

Les rappels d'anniversaires partent 21, 7 et 2 jours avant la date, automatiquement, toutes les cinq minutes quand l'application tourne.

## 8. Mettre l'application en ligne (pour que d'autres l'utilisent)

Sur votre ordinateur, seul vous y accédez. Pour que des utilisateurs s'y connectent depuis leur téléphone, il faut l'héberger sur un serveur : la procédure existante (Google Cloud Run et Supabase) est décrite dans `docs/deploiement-test.md`. Elle est technique ; faites-vous accompagner. Les mêmes clés qu'au chapitre 6 y sont saisies comme « secrets » du déploiement, jamais dans le code.

## 9. En cas de problème

| Message ou symptôme | Cause probable | Que faire |
|---|---|---|
| `npm error Missing script: "dev"` | Le Terminal n'est pas dans le dossier de l'application | Refaites le `cd` de l'étape 4 vers le dossier qui contient `package.json` |
| `command not found: npm` ou `node` | Node.js n'est pas installé, ou le Terminal a été ouvert avant l'installation | Refaites l'étape 2, puis fermez et rouvrez le Terminal |
| `Port 3000 is in use` | Une autre copie de l'application tourne déjà | Fermez l'autre fenêtre de Terminal (ou `Ctrl` + `C` dedans), puis relancez |
| La page http://localhost:3000 ne s'ouvre pas | L'application n'est pas démarrée | Vérifiez que le Terminal affiche `Ready` et reste ouvert |
| L'agent répond toujours « C'est noté. Je m'occupe de… » | `LOCAL_AGENTS_MODE` est resté sur `off` | Étape 6a, puis relancez l'application |
| L'agent répond « Je n'ai pas réussi à répondre » | Clé Anthropic invalide ou crédit épuisé | Lisez la ligne `[agents]` dans le Terminal ; vérifiez la clé et le crédit sur console.anthropic.com |
| Je ne reçois pas le code de connexion | Les emails ne partent pas réellement en local | Ouvrez http://localhost:3000/dev/boite |
| Je veux repartir de zéro (comptes, données) | — | Arrêtez l'application puis, dans le dossier : `npm run db:reset`, et relancez `npm run dev` |

## 10. Ce qu'il ne faut jamais faire

- Envoyer le fichier `.env` par email, le copier dans un message ou le mettre sur GitHub.
- Utiliser les comptes de démonstration (`@maaq.test`) ailleurs que sur votre ordinateur.
- Lancer `npm run db:reset` sur un serveur en ligne : cela efface toutes les données.
