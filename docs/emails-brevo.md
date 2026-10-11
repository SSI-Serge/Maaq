# Envoyer de vrais emails avec Brevo

Par défaut, MAAQ n'envoie rien : tout va dans la boîte de test (`MESSAGING_MODE=dev`). Avec `MESSAGING_MODE=smtp`, **les emails
partent réellement** par un serveur SMTP, ici celui de **Brevo** (société française, offre gratuite d'environ 300 emails par jour,
à vérifier sur leur site).

- Seuls les **emails** sont concernés. Les **SMS** restent simulés (boîte de test) : les codes de vérification passent donc par l'email.
- Dans la **zone de test** (`MAAQ_ZONE=test`), chaque email part **et** une copie arrive aussi dans `/dev/boite`.
- Les emails partent d'une adresse du domaine, par exemple `ne-pas-repondre@maaq.fr`. Sans les enregistrements DNS de la partie 2,
  ils finiraient en indésirables, voire seraient refusés.

Commandes PowerShell, une par ligne. Remplace ce qui est en MAJUSCULES.

---

## 1. Créer le compte Brevo
1. https://www.brevo.com ▸ **S'inscrire gratuitement** (adresse email, mot de passe), puis valider l'email reçu.
2. Brevo pose quelques questions sur ton activité : réponds honnêtement. Les nouveaux comptes peuvent être **contrôlés avant
   d'être autorisés à envoyer** : cela prend de quelques minutes à un jour ouvré.
3. Choisis l'offre **Free**.

## 2. Authentifier le domaine `maaq.fr`
C'est ce qui prouve aux messageries que tes emails viennent bien de toi.
1. Dans Brevo : menu du compte (en haut à droite) ▸ **Senders, domains & dedicated IPs** ▸ **Domains** ▸ **Add a domain**.
2. Saisis `maaq.fr` (sans `www`). Brevo affiche une liste d'**enregistrements DNS** : en général un code d'**authentification Brevo**
   (TXT), deux enregistrements **DKIM** (CNAME ou TXT) et un enregistrement **DMARC** (TXT).
3. Ajoute-les **exactement comme affichés** chez IONOS : **Domaines & SSL** ▸ `maaq.fr` ▸ **DNS** ▸ **Ajouter un enregistrement**.
   - Recopie le **type**, le **nom d'hôte** et la **valeur** de chacun. Si IONOS ajoute déjà `.maaq.fr` au nom d'hôte, ne le répète pas.
   - **Ne supprime pas** les enregistrements existants (Google, `test`, etc.).
   - S'il existe déjà un enregistrement **SPF** (TXT commençant par `v=spf1`), **ne crée pas un second** : modifie-le pour y ajouter
     `include:spf.brevo.com`.
4. Retourne sur Brevo ▸ **Authenticate this domain**. Cela peut demander quelques minutes à quelques heures. Le domaine doit
   passer à **Authenticated**.

## 3. Créer l'expéditeur
Brevo ▸ **Senders, domains & dedicated IPs** ▸ **Senders** ▸ **Add a sender** : nom `MAAQ`, adresse `ne-pas-repondre@maaq.fr`.
Si Brevo veut confirmer cette adresse par un email de validation et que `maaq.fr` n'a pas de boîte mail, crée une **redirection**
chez IONOS (ou un alias vers ta propre adresse), le temps de recevoir le message de confirmation.

## 4. Récupérer les identifiants SMTP
Brevo ▸ **SMTP & API** ▸ onglet **SMTP**. Tu y trouves :
- **Serveur** : `smtp-relay.brevo.com`, **port** `587` ;
- **Identifiant** (login) : une adresse du type `xxxxxx@smtp-brevo.com`, **différente** de celle de ton compte ;
- **Clé SMTP** : **Generate a new SMTP key** ▸ donne-lui un nom (`maaq-test`) ▸ **copie-la tout de suite**, elle n'est affichée qu'une fois.

Ne les colle jamais dans une conversation ni dans un fichier du projet.

## 5. Ranger l'identifiant et la clé dans Secret Manager
Dans PowerShell, avec la fonction habituelle (à recoller si la fenêtre est neuve) :

```powershell
function New-Secret($name, $value) { $f = New-TemporaryFile; Set-Content -Path $f -Value $value -NoNewline; gcloud secrets create $name --data-file=$f; Remove-Item $f }
```
```powershell
New-Secret SMTP_USER 'IDENTIFIANT_BREVO'
New-Secret SMTP_PASSWORD 'CLE_SMTP_BREVO'
```

## 6. Déployer avec l'envoi réel
Les changements de code (module d'envoi) doivent être déployés. Depuis la racine du projet, sur une seule ligne :

```powershell
gcloud run deploy maaq-test --source . --region europe-west1 --update-env-vars "MESSAGING_MODE=smtp,SMTP_HOST=smtp-relay.brevo.com,SMTP_PORT=587,MAIL_FROM=MAAQ <ne-pas-repondre@maaq.fr>" --update-secrets "SMTP_USER=SMTP_USER:latest,SMTP_PASSWORD=SMTP_PASSWORD:latest"
```

Sans ces cinq réglages, l'application **refuse de démarrer** en mode `smtp` et nomme ce qui manque dans les journaux :
`gcloud run services logs read maaq-test --region europe-west1 --limit 30`.

## 7. Tester
1. Console d'administration ▸ **Comptes** ▸ **Créer un compte** avec **ta propre adresse** : l'email d'activation doit arriver dans ta
   messagerie (regarde aussi les indésirables la première fois).
2. Côté Brevo : **Transactional** ▸ **Logs** liste chaque envoi, avec son statut (envoyé, distribué, rejeté).
3. En cas d'échec, l'application affiche l'erreur habituelle et la copie reste lisible dans `/dev/boite?cle=…`.

## Bon à savoir
- **Quota** : l'offre gratuite plafonne le nombre d'emails par jour. Pour la zone de test, c'est largement suffisant.
- **Retour en arrière** : remettre `MESSAGING_MODE=dev` (`--update-env-vars "MESSAGING_MODE=dev"`) ramène la boîte de test seule.
- **Données personnelles** : en production, Brevo devient un sous-traitant (il voit les adresses et le contenu des emails). Il faudra
  le mentionner dans la politique de confidentialité et signer son accord de traitement des données.
- **Contenu des emails** : texte brut, sans mise en forme ni image. Une version plus soignée est possible plus tard.
- **SMS** : un fournisseur de SMS reste à choisir (envoi payant au message). Tant qu'il n'est pas branché, les codes de vérification
  arrivent par email et les invitations par SMS ne partent pas.
