# MAAQ — User stories détaillées (Business Analyst)

Rédigé le 30/09/2026, mis à jour le 30/09/2026 avec les décisions du document de validation puis le 01/10/2026 avec les décisions issues de la conception de la base de données, à partir du dossier « MAAQ — Dossier de transmission au Business Analyst » (version du 29/09/2026) et des réponses du Product Manager lors du cadrage.

---

## 1. Mode d'emploi du document

- Chaque user story (US) reprend la référence et le titre du PM et contient : règles fonctionnelles (RF), règles techniques (RT), notes UX / Design et critères d'acceptance (CA) au format Gherkin.
- Numérotation : RF et RT numérotées par US. Les CA sont numérotés par règle fonctionnelle : CA 3.1 et CA 3.2 couvrent la RF3.
- **Aucune équipe technique, UX ni base de code n'était disponible pendant la rédaction.** Les hypothèses ont été soumises au PM dans le document de validation du 30/09/2026. Les points confirmés ne portent plus de marqueur. Les points encore ouverts restent marqués [À CONFIRMER avec PM], [À CONFIRMER avec backend], [À CONFIRMER avec frontend], [À CONFIRMER avec UX], [À CONFIRMER avec DPO] ou [À CONFIRMER avec Digitorn].
- Les notes UX / Design décrivent ce que montre la maquette. Tout ajout au-delà de la maquette est marqué [À CONFIRMER avec UX].
- La section 5 récapitule toutes les US et tous les points à confirmer.

---

## 2. Décisions de cadrage (réponses du PM du 30/09/2026)

Ces décisions complètent ou corrigent le dossier de transmission. Elles s'appliquent à toutes les US concernées.

**D1 — Le noyau du compte.** L'utilisateur principal et son premier invité (appelé « invité 1 ») forment le noyau du compte. Les invités ajoutés ensuite sont appelés « invités secondaires » (invités 2 à n). Il existe une relation de subordination entre les invités secondaires et le noyau.

**D2 — Participants automatiques des rendez-vous.**
- Un rendez-vous créé par un agent à la demande de l'utilisateur principal inclut automatiquement l'invité 1 comme participant.
- Un rendez-vous créé à la demande de l'invité 1 inclut automatiquement l'utilisateur principal comme participant.
- Un rendez-vous créé à la demande d'un invité secondaire inclut automatiquement l'utilisateur principal et l'invité 1 comme participants.
- Un invité secondaire n'est ajouté à un rendez-vous du noyau que si le demandeur le précise dans sa demande, ou s'il valide la proposition de l'agent.
- Les listes d'adresses en copie systématique (US-16 et US-17) servent à ajouter d'autres personnes, en plus de ces participants automatiques.

**D3 — Visibilité du carnet de bord.** L'utilisateur principal et l'invité 1 voient toutes les entrées du carnet. Un invité secondaire voit ses propres demandes, ainsi que les demandes du noyau pour lesquelles il a été ajouté comme participant.

**D4 — Alimentation du carnet de bord.** Le carnet de bord n'est pas mis à jour en temps réel. Il récupère auprès de Digitorn, toutes les X heures, les demandes traitées par les agents. La valeur de X est paramétrable.


**Décisions du 30/09/2026 (document de validation)**

- **D5 — Adresses en copie.** La liste de l'utilisateur principal ne s'applique qu'à ses propres rendez-vous, et plus à ceux de ses invités. L'adresse d'un participant automatique est son email de connexion.
- **D6 — Invité 1.** L'invité 1 est le premier invité ajouté. S'il est supprimé, aucun invité secondaire n'est promu.
- **D7 — Contrats réservés au noyau.** Les informations et documents de contrats ne sont accessibles qu'à l'utilisateur principal et à l'invité 1. Ils sont stockés dans le Google Drive de l'utilisateur principal. Un document retiré dans MAAQ reste dans ce Drive.
- **D8 — Console d'administration.** L'administrateur crée les comptes des utilisateurs principaux (US-64). Lors de la publication d'un agent, il précise les informations à demander à l'utilisateur et les éléments de configuration requis (US-45). Il définit les champs de chaque contrat (US-48). Il règle la fréquence de synchronisation du carnet (5 heures par défaut) et le délai de suppression des données d'un invité (US-65).
- **D9 — Validation des emails dans le tchat.** Le brouillon est envoyé dans la boîte de validation pour relecture ; la validation se fait par une carte dans le tchat.
- **D10 — Désabonnement.** La suppression du compte par l'utilisateur principal vaut désabonnement (« Désabonnement et suppression du compte »). Un invité peut reprendre son compte pendant son délai de grâce.
- **D11 — Divers.** Les nouvelles informations sont transmises immédiatement à Digitorn. La session mémorisée dure 3 mois. La récupération d'accès se fait par code. L'administrateur utilise un mot de passe, et non un schéma. Les alertes sont envoyées par email. La dictée au support est transcrite en texte. Les signalements sont conservés 14 mois, et les sauvegardes 2 ans. L'API du carnet Digitorn est annoncée vers le 14/10/2026.

**Décisions du 01/10/2026 (validation de la conception de la base de données)**

- **D12 — Mot de passe oublié.** La réinitialisation du mot de passe se fait par un code à 6 chiffres envoyé par email, jamais par un lien. Une fois le mot de passe réinitialisé, l'utilisateur peut recréer son schéma tactile.
- **D13 — Preuve de consentement.** Le journal des consentements au challenge d'un contrat conserve, en plus des identifiants, une empreinte de l'email du consentant, pour établir qui a consenti même après la suppression du compte.
- **D14 — Google Drive du compte.** Le Google Drive utilisé pour les contrats est une connexion unique par compte, indépendante des agents, établie par l'utilisateur principal. Un agent peut aussi utiliser ce Drive. La connexion se fait soit depuis l'agent dans MAAQ, soit directement par un widget Digitorn.
- **D15 — Informations propres à chaque agent.** Les informations à fournir sont définies librement par l'administrateur pour chaque agent, à la publication, et complétées par l'utilisateur au moment de configurer l'agent. Une valeur déjà saisie pour un autre agent est proposée pré-remplie lorsque l'administrateur a donné aux deux champs la même clé commune.
- **D16 — Adresses en copie fixées par agent.** À la publication d'un agent, l'administrateur précise s'il propose des adresses en copie et le nombre maximal (10 recommandé).
- **D17 — Durées et limites réglables.** Sont réglables dans la console : la durée de conservation du carnet de bord (14 mois par défaut), des signalements (14 mois) et du journal de sécurité (36 mois), la taille maximale d'un document de contrat (15 Mo) et le nombre maximal de documents par contrat (20).
- **D18 — Délai de grâce de 30 jours.** Le délai de grâce est unique : 30 jours, que la suppression vienne d'un désabonnement ou d'une demande depuis les Réglages. Un invité qui demande la suppression de son compte sort du quota dès sa demande.
- **D19 — Comptes et invités jamais activés.** Un compte ou un invité jamais activé est supprimé 30 jours après le dernier lien d'activation envoyé. Le délai est réglable.
- **D20 — Plafond quotidien de demandes.** Chaque profil peut envoyer un nombre limité de demandes aux agents par jour (50 par défaut). Le plafond est fixé par compte, selon le plan, et réglable par l'administrateur. L'application refuse les demandes au-delà, avec un message.
- **D21 — Fuseau horaire de l'appareil.** Le fuseau horaire de l'appareil est mémorisé à chaque connexion. Il sert aux heures citées dans les emails du serveur et à définir la journée du plafond de demandes. Aucun choix de fuseau n'est proposé dans les Réglages.
- **D22 — Badge « Nouvelle réponse » supprimé.** Seul le badge disparaît ; l'agent continue de traiter la demande en arrière-plan et la réponse s'affiche au retour dans le tchat.

---

## 3. Comportements communs (réseau et chargement)

MAAQ exige une connexion internet, et le réseau est parfois dégradé en mobilité. Toute US qui déclenche un échange avec le serveur applique les quatre comportements ci-dessous. Chaque US les reprend dans ses propres RF et CA, en précisant l'élément concerné.

- **CC-1 — État de chargement.** Pendant l'échange, un indicateur de chargement s'affiche dans la zone concernée. Le bouton qui a déclenché l'action est désactivé, pour éviter un double envoi.
- **CC-2 — Erreur serveur.** Si le serveur répond par une erreur ou est indisponible, le message « Le service est momentanément indisponible. Veuillez réessayer dans quelques instants. » s'affiche avec un bouton « Réessayer ». Les informations déjà saisies sont conservées.
- **CC-3 — Délai dépassé.** Si le serveur ne répond pas dans un délai de 15 secondes, le message « La connexion semble lente. Veuillez réessayer. » s'affiche avec un bouton « Réessayer ». Les informations déjà saisies sont conservées.
- **CC-4 — Absence de connexion.** Si l'appareil n'a aucune connexion internet, un bandeau « Pas de connexion internet — MAAQ nécessite une connexion pour fonctionner » s'affiche en haut de l'écran. Il disparaît dès le retour de la connexion.

### Comportements résilients communs

Le réseau mobile est souvent dégradé. Les comportements ci-dessous complètent CC-1 à CC-4. Ils s'appliquent à toutes les US qui échangent avec le serveur, sans être répétés dans chacune. Les US où ils ont un effet particulier contiennent une règle dédiée.

- **CC-5 — Nouvelles tentatives automatiques.** Avant d'afficher une erreur de chargement (CC-2 ou CC-3), l'application fait deux nouvelles tentatives silencieuses, espacées d'environ 1 puis 3 secondes. Les enregistrements (ajout, modification, suppression) ne sont pas renvoyés automatiquement, sauf s'ils sont protégés contre la double exécution (CC-7).
- **CC-6 — Attente longue signalée.** Si une opération dure plus de 5 secondes, l'indicateur de chargement est complété par le message « Toujours en cours… », avant le message de connexion lente de CC-3.
- **CC-7 — Pas de double exécution.** Une action touchée deux fois, ou relancée avec « Réessayer », n'est jamais exécutée deux fois : pas de doublon d'invité, de document, de rendez-vous ou de signalement.
- **CC-8 — Saisie préservée.** Un texte saisi mais pas encore envoyé (message au tchat, formulaire, message au support) est conservé sur l'appareil. Il est retrouvé après un verrouillage, une coupure réseau ou une fermeture de l'application, jusqu'à son envoi ou son abandon. Il est effacé à la déconnexion.
- **CC-9 — Reprise au retour de la connexion.** Quand la connexion revient (fin de CC-4), l'écran affiché se recharge automatiquement, sans que l'utilisateur ait à toucher « Réessayer ».
- **CC-10 — Traitements longs en arrière-plan.** Les traitements longs ne bloquent jamais l'écran : traitement d'une demande par un agent, envoi de document, export, suppression de compte, synchronisation du carnet, envoi d'invitation. L'utilisateur peut quitter l'écran ou l'application, et retrouve le résultat à son retour.

---

## 4. Ordre de réalisation recommandé

Les US sont présentées dans l'ordre du PM pour faciliter la traçabilité. L'ordre de réalisation recommandé, du socle vers les fonctionnalités qui en dépendent, est le suivant :

1. **Socle accès et sécurité :** US-2, US-3, US-51, US-6, US-7, US-8, US-66, US-52, US-9, US-1.
2. **Socle administration :** US-64, US-69, US-65, US-45, US-46, US-47, US-48.
3. **Compte et invités :** US-10, US-11, US-12, US-18, US-4, US-5, US-19, US-20, US-21.
4. **Catalogue et dashboard :** US-23, US-24, US-25, US-26, US-27, US-28, US-22.
5. **Connecteurs :** US-67, US-13, US-14, US-15, US-16, US-17, US-29.
6. **Tchat :** US-37, US-60, US-41, US-38, US-70, US-39, US-42, US-61, US-43, US-44.
7. **Contrats :** US-30, US-31, US-32, US-33, US-34, US-35, US-36.
8. **Réglages, carnet et support :** US-49, US-50, US-40, US-53, US-62, US-63.
9. **Conformité :** US-54, US-55, US-56, US-57, US-58, US-68, US-59.

---

# Module A — Accès & Connexion

## US-1 — Être guidé pour installer MAAQ sur l'écran d'accueil

**En tant qu'** utilisateur ou invité,
**je souhaite** être guidé pas à pas pour ajouter MAAQ à l'écran d'accueil de mon téléphone lors de ma première visite,
**afin de** pouvoir accéder à l'application aussi rapidement qu'une app native par la suite.

**Écran(s) maquette :** Installation (onglets Android / iPhone). **Dépendances :** US-2, US-4.

### Règles fonctionnelles

RF1 — Lorsque MAAQ est ouverte dans le navigateur d'un smartphone et n'est pas lancée depuis l'écran d'accueil, un écran de guidage à l'installation s'affiche. Il apparaît à la première visite, et après l'activation du compte pour un invité.

RF2 — Le guidage affiche automatiquement les étapes correspondant au système détecté : Android ou iPhone.

RF3 — Sur iPhone, le guidage détaille pas à pas la manipulation manuelle : ouvrir le menu de partage du navigateur, choisir « Sur l'écran d'accueil », puis confirmer avec « Ajouter ».

RF4 — Sur Android, si le navigateur propose l'installation, un bouton « Installer MAAQ » déclenche cette proposition. Sinon, le guidage détaille les étapes manuelles depuis le menu du navigateur.

RF5 — Sur iPhone, si MAAQ est ouverte dans un navigateur qui ne permet pas l'ajout à l'écran d'accueil, le guidage indique d'ouvrir MAAQ dans Safari.

RF6 — L'utilisateur peut basculer manuellement entre les onglets Android et iPhone, au cas où la détection automatique serait erronée.

RF7 — L'utilisateur peut ignorer le guidage avec un bouton « Plus tard » et continuer dans le navigateur. Le guidage est reproposé à la prochaine ouverture de MAAQ dans le navigateur.

RF8 — Le guidage ne s'affiche jamais lorsque MAAQ est lancée depuis l'écran d'accueil, ni sur un ordinateur.

### Règles techniques

RT1 — [frontend] Le système d'exploitation est détecté à partir des informations fournies par le navigateur. Une détection impossible affiche par défaut l'onglet iPhone, le parcours le plus détaillé.

RT2 — [frontend] L'application sait distinguer une ouverture depuis l'écran d'accueil d'une ouverture dans le navigateur, afin de ne pas afficher le guidage inutilement.

RT3 — [frontend] L'application déclare les éléments nécessaires à son installation : nom « MAAQ », icône, couleur et écran de démarrage.

### UX / Design

D'après la maquette : un écran avec deux onglets, « Android » et « iPhone ». Chaque onglet présente les étapes numérotées accompagnées d'un pictogramme représentant le bouton à toucher. L'onglet du système détecté est ouvert par défaut. Le bouton « Plus tard » est placé en bas d'écran.

**Impact maquette :** Ajustement — Bouton « Plus tard » ; Message « Ouvrez MAAQ dans Safari » pour un navigateur non compatible sur iPhone.

### Critères d'acceptance

**CA 1.1 — Affichage du guidage à la première visite**
- Étant donné que j'ouvre MAAQ pour la première fois dans le navigateur de mon smartphone
- Quand la page se charge
- Alors l'écran de guidage à l'installation s'affiche

**CA 2.1 — Détection d'un iPhone**
- Étant donné que j'utilise un iPhone
- Quand l'écran de guidage s'affiche
- Alors l'onglet « iPhone » est ouvert par défaut

**CA 2.2 — Détection d'un Android**
- Étant donné que j'utilise un téléphone Android
- Quand l'écran de guidage s'affiche
- Alors l'onglet « Android » est ouvert par défaut

**CA 3.1 — Étapes iPhone**
- Étant donné que l'onglet « iPhone » est affiché
- Quand je lis le guidage
- Alors je vois les étapes « Toucher le bouton de partage », « Choisir Sur l'écran d'accueil » et « Toucher Ajouter », dans cet ordre

**CA 4.1 — Installation proposée par le navigateur Android**
- Étant donné que mon navigateur Android propose l'installation
- Quand je touche « Installer MAAQ »
- Alors la fenêtre d'installation du navigateur s'ouvre

**CA 4.2 — Installation manuelle sur Android**
- Étant donné que mon navigateur Android ne propose pas l'installation
- Quand l'onglet « Android » s'affiche
- Alors les étapes manuelles depuis le menu du navigateur sont affichées à la place du bouton « Installer MAAQ »

**CA 5.1 — Navigateur non compatible sur iPhone**
- Étant donné que j'ouvre MAAQ sur iPhone dans un navigateur qui ne permet pas l'ajout à l'écran d'accueil
- Quand l'écran de guidage s'affiche
- Alors un message m'invite à ouvrir MAAQ dans Safari

**CA 6.1 — Changement manuel d'onglet**
- Étant donné que l'onglet « Android » est affiché
- Quand je touche l'onglet « iPhone »
- Alors les étapes iPhone s'affichent

**CA 7.1 — Report du guidage**
- Étant donné que l'écran de guidage est affiché
- Quand je touche « Plus tard »
- Alors j'accède à l'écran suivant du parcours dans le navigateur
- Et le guidage s'affiche de nouveau à ma prochaine ouverture de MAAQ dans le navigateur

**CA 8.1 — Pas de guidage depuis l'écran d'accueil**
- Étant donné que MAAQ est installée sur mon écran d'accueil
- Quand je lance MAAQ depuis son icône
- Alors l'écran de guidage ne s'affiche pas

**CA 8.2 — Pas de guidage sur ordinateur**
- Étant donné que j'ouvre MAAQ sur un ordinateur
- Quand la page se charge
- Alors l'écran de guidage ne s'affiche pas

---

## US-2 — Accéder à l'application depuis l'écran d'accueil

**En tant qu'** utilisateur, invité ou administrateur,
**je souhaite** lancer MAAQ depuis un raccourci sur l'écran d'accueil de mon téléphone (ou depuis un navigateur pour l'administrateur),
**afin de** retrouver l'application aussi simplement qu'une app native, sans passer par un store.

**Écran(s) maquette :** aucun écran dédié. **Dépendances :** US-1, US-3, US-6.

### Règles fonctionnelles

RF1 — Le raccourci installé sur l'écran d'accueil porte le nom « MAAQ » et l'icône de MAAQ.

RF2 — Lancée depuis ce raccourci, MAAQ s'ouvre en plein écran, sans barre d'adresse ni boutons du navigateur.

RF3 — Au lancement, l'utilisateur arrive sur l'écran de déverrouillage par schéma si une session est mémorisée sur cet appareil (US-6). Sinon, il arrive sur l'écran de connexion (US-3).

RF4 — L'administrateur accède à MAAQ depuis le navigateur de son ordinateur, à une adresse web dédiée, sans installation.

RF5 — Pendant le démarrage, un écran de démarrage aux couleurs de MAAQ s'affiche (CC-1).

RF6 — Si le serveur ne répond pas au démarrage, le message d'erreur standard s'affiche avec un bouton « Réessayer » (CC-2).

RF7 — Si le démarrage dépasse le délai standard, le message de connexion lente s'affiche avec un bouton « Réessayer » (CC-3).

RF8 — Si l'appareil n'a aucune connexion internet au lancement, un écran indique que MAAQ nécessite une connexion, avec un bouton « Réessayer » (CC-4).

RF9 — Lorsqu'une nouvelle version de MAAQ est disponible, elle est appliquée au lancement suivant, sans réinstallation du raccourci.

### Règles techniques

RT1 — [frontend] MAAQ est une application web installable, fonctionnant sur les versions récentes des navigateurs mobiles Android et iPhone. Les versions minimales supportées restent à définir.

RT2 — [frontend] Aucune donnée personnelle n'est conservée sur l'appareil pour un usage hors connexion. Seuls les éléments d'interface nécessaires à l'écran de démarrage et au message d'absence de connexion sont conservés localement.

RT3 — [backend] Toutes les données sont hébergées dans l'Union européenne.

### UX / Design

Aucun écran dédié dans la maquette. L'écran de démarrage affiche le logo MAAQ sur fond uni.

**Impact maquette :** Nouvel écran — Écran de démarrage et écran hors connexion (voir MT-2).

### Critères d'acceptance

**CA 1.1 — Raccourci installé**
- Étant donné que j'ai suivi le guidage d'installation
- Quand je regarde l'écran d'accueil de mon téléphone
- Alors je vois une icône MAAQ portant le nom « MAAQ »

**CA 2.1 — Ouverture en plein écran**
- Étant donné que MAAQ est installée sur mon écran d'accueil
- Quand je touche l'icône MAAQ
- Alors l'application s'ouvre sans barre d'adresse ni boutons du navigateur

**CA 3.1 — Session mémorisée**
- Étant donné que je me suis déjà connecté sur cet appareil et que je ne me suis pas déconnecté
- Quand je lance MAAQ
- Alors l'écran de déverrouillage par schéma s'affiche

**CA 3.2 — Aucune session mémorisée**
- Étant donné que je ne me suis jamais connecté sur cet appareil
- Quand je lance MAAQ
- Alors l'écran de connexion s'affiche

**CA 4.1 — Accès administrateur**
- Étant donné que je suis administrateur
- Quand j'ouvre l'adresse web de MAAQ dans le navigateur de mon ordinateur
- Alors l'écran de connexion s'affiche sans proposition d'installation

**CA 5.1 — Écran de démarrage**
- Étant donné que je lance MAAQ
- Quand l'application est en cours de chargement
- Alors l'écran de démarrage MAAQ s'affiche

**CA 6.1 — Serveur indisponible au lancement**
- Étant donné que le serveur MAAQ est indisponible
- Quand je lance MAAQ
- Alors le message « Le service est momentanément indisponible. Veuillez réessayer dans quelques instants. » s'affiche avec un bouton « Réessayer »

**CA 7.1 — Démarrage lent**
- Étant donné que le réseau est très lent
- Quand le démarrage dépasse 15 secondes
- Alors le message « La connexion semble lente. Veuillez réessayer. » s'affiche avec un bouton « Réessayer »

**CA 8.1 — Lancement sans connexion**
- Étant donné que mon téléphone n'a aucune connexion internet
- Quand je lance MAAQ
- Alors un écran m'indique que MAAQ nécessite une connexion internet
- Et un bouton « Réessayer » relance le démarrage

**CA 9.1 — Mise à jour de l'application**
- Étant donné qu'une nouvelle version de MAAQ a été publiée
- Quand je relance MAAQ depuis l'écran d'accueil
- Alors la nouvelle version s'affiche sans que j'aie à réinstaller le raccourci

---

## US-3 — Se connecter à MAAQ

**En tant qu'** utilisateur, invité ou administrateur,
**je souhaite** me connecter à mon compte MAAQ,
**afin d'** accéder à mes agents, ma configuration et mon carnet de bord.

**Écran(s) maquette :** Connexion (onglets mot de passe / schéma tactile). **Dépendances :** US-51, US-6, US-10, US-4, US-66.

### Règles fonctionnelles

RF1 — Sur un appareil sans session mémorisée, la connexion se fait avec l'email de connexion et le mot de passe du compte.

RF2 — Les deux champs sont obligatoires. Le bouton « Se connecter » reste inactif tant qu'ils ne sont pas remplis. Un email au format invalide affiche le message « Adresse email invalide » sous le champ.

RF3 — Si l'email ou le mot de passe est incorrect, le message « Email ou mot de passe incorrect » s'affiche, sans préciser lequel des deux est erroné.

RF4 — Après 5 tentatives échouées consécutives pour un même compte, la connexion par mot de passe est bloquée pendant 15 minutes, avec un message indiquant l'heure à laquelle réessayer. Le blocage est levé après une réinitialisation réussie du mot de passe (US-66). L'heure indiquée est celle du fuseau de l'appareil (décision D12, D21 du 01/10/2026).

RF5 — Sur un appareil non reconnu, une connexion réussie déclenche la vérification d'identité (US-51) avant tout accès.

RF6 — Après la connexion (et la vérification si nécessaire), l'utilisateur est dirigé selon son profil :
- l'administrateur vers l'écran d'administration des agents ;
- l'utilisateur principal dont la configuration initiale n'est pas terminée vers la configuration initiale (US-10) ;
- l'utilisateur principal configuré et l'invité vers leur dashboard.

RF7 — Après la première connexion d'un utilisateur ou d'un invité sur un appareil, la création d'un schéma tactile lui est demandée (US-6).

RF8 — L'email de connexion est mémorisé sur l'appareil et pré-rempli lors des connexions suivantes.

RF9 — Un lien « Mot de passe oublié ? » envoie vers le parcours de réinitialisation du mot de passe par code (US-66) (décision D12 du 01/10/2026).

RF10 — Un compte supprimé définitivement, ou un invité supprimé par l'utilisateur principal, obtient le même message que des identifiants incorrects.

RF11 — Un compte en délai de grâce de suppression est dirigé vers l'écran de reprise de compte (US-59).

RF12 — Pendant la vérification des identifiants, le bouton « Se connecter » affiche un indicateur de chargement et est désactivé (CC-1).

RF13 — En cas d'erreur serveur, le message d'erreur standard s'affiche et l'email saisi est conservé (CC-2).

RF14 — En cas de délai dépassé, le message de connexion lente s'affiche et l'email saisi est conservé (CC-3).

### Règles techniques

RT1 — [backend] Les mots de passe ne sont jamais conservés en clair. Seule une empreinte irréversible est stockée.

RT2 — [backend] Le compteur de tentatives échouées est tenu côté serveur, par compte, pour ne pas pouvoir être contourné en changeant d'appareil.

RT3 — [backend] Le compte de l'utilisateur principal est créé par l'administrateur depuis la console d'administration (décision du 30/09/2026). L'utilisateur principal choisit son premier mot de passe grâce au lien d'activation reçu par email (US-64).

RT4 — [backend] Les règles de robustesse des mots de passe sont d'au moins 10 caractères, dont une lettre et un chiffre.

### UX / Design

D'après la maquette : l'écran propose deux onglets, « Mot de passe » et « Schéma tactile ». L'onglet « Schéma tactile » n'est actif que si un schéma existe pour cet appareil. Le lien « Mot de passe oublié ? » se trouve sous le champ mot de passe.

**Impact maquette :** Ajustement — Le lien « Mot de passe oublié ? » ouvre le parcours de réinitialisation par code (US-66) ; Message de blocage après 5 échecs, avec l'heure de nouvel essai ; Lien « Mot de passe oublié ? » ; Onglet « Schéma tactile » inactif sans schéma ; États de chargement et d'erreur du bouton « Se connecter ».

### Critères d'acceptance

**CA 1.1 — Connexion réussie sur un appareil reconnu**
- Étant donné que je suis un invité déjà vérifié sur cet appareil
- Quand je saisis mon email et mon mot de passe corrects
- Et que je touche « Se connecter »
- Alors j'accède à mon dashboard

**CA 2.1 — Bouton inactif tant qu'un champ est vide**
- Étant donné que le champ mot de passe est vide
- Quand je saisis mon email
- Alors le bouton « Se connecter » reste inactif

**CA 2.2 — Email au format invalide**
- Étant donné que je saisis « camille.faucher » dans le champ email
- Quand je quitte le champ
- Alors le message « Adresse email invalide » s'affiche sous le champ

**CA 3.1 — Identifiants incorrects**
- Étant donné que je saisis un mot de passe erroné
- Quand je touche « Se connecter »
- Alors le message « Email ou mot de passe incorrect » s'affiche

**CA 4.1 — Blocage après 5 échecs**
- Étant donné que j'ai échoué 4 fois de suite à me connecter
- Quand j'échoue une cinquième fois
- Alors la connexion par mot de passe est bloquée pendant 15 minutes
- Et un message m'indique l'heure à partir de laquelle je peux réessayer

**CA 5.1 — Nouvel appareil**
- Étant donné que je me connecte pour la première fois depuis ce téléphone
- Quand mes identifiants sont acceptés
- Alors l'écran de vérification d'identité s'affiche

**CA 6.1 — Redirection de l'administrateur**
- Étant donné que je suis administrateur
- Quand ma connexion réussit
- Alors l'écran d'administration des agents s'affiche

**CA 6.2 — Utilisateur principal non configuré**
- Étant donné que je suis utilisateur principal et que je n'ai pas terminé la configuration initiale
- Quand ma connexion réussit
- Alors la configuration initiale s'affiche

**CA 6.3 — Utilisateur principal configuré**
- Étant donné que je suis utilisateur principal et que ma configuration initiale est terminée
- Quand ma connexion réussit
- Alors mon dashboard s'affiche

**CA 7.1 — Création du schéma après la première connexion**
- Étant donné que je me connecte pour la première fois sur cet appareil en tant qu'utilisateur
- Quand la vérification d'identité est réussie
- Alors l'écran de création du schéma tactile s'affiche

**CA 8.1 — Email mémorisé**
- Étant donné que je me suis déjà connecté sur cet appareil
- Quand l'écran de connexion s'affiche
- Alors le champ email est pré-rempli avec mon email de connexion

**CA 9.1 — Mot de passe oublié**
- Étant donné que je suis sur l'écran de connexion
- Quand je touche « Mot de passe oublié ? »
- Alors l'écran de réinitialisation du mot de passe s'affiche (US-66)

**CA 10.1 — Invité supprimé**
- Étant donné que l'utilisateur principal m'a supprimé de ses invités
- Quand je tente de me connecter avec mes anciens identifiants
- Alors le message « Email ou mot de passe incorrect » s'affiche

**CA 11.1 — Compte en délai de grâce**
- Étant donné que mon compte est en délai de grâce de suppression
- Quand ma connexion réussit
- Alors l'écran de reprise de compte s'affiche

**CA 12.1 — Chargement**
- Étant donné que j'ai touché « Se connecter »
- Quand la vérification est en cours
- Alors un indicateur de chargement s'affiche sur le bouton, qui est désactivé

**CA 13.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand je touche « Se connecter »
- Alors le message d'erreur standard s'affiche
- Et mon email reste saisi

**CA 14.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand la réponse dépasse 15 secondes
- Alors le message de connexion lente s'affiche
- Et mon email reste saisi

---

## US-4 — Activer son accès en tant qu'invité

**En tant qu'** invité,
**je souhaite** recevoir une invitation (email et/ou SMS) après avoir été ajouté par un utilisateur principal, et activer mon accès à MAAQ depuis cette invitation,
**afin de** pouvoir me connecter à l'application pour la première fois.

**Écran(s) maquette :** Activation du compte invité. **Dépendances :** US-18, US-5, US-6, US-54, US-1.

### Règles fonctionnelles

RF1 — Dès que l'utilisateur principal ajoute un invité (US-18), une invitation est envoyée par email. Elle est aussi envoyée par SMS si un numéro de téléphone a été renseigné.

RF2 — L'invitation mentionne le prénom et le nom de l'utilisateur principal qui invite, présente MAAQ en une phrase, contient un lien d'activation personnel et indique que ce lien est valable 30 minutes.

RF3 — Le lien d'activation est valable 30 minutes après son envoi et ne peut être utilisé qu'une seule fois.

RF4 — Le lien valide ouvre l'écran d'activation. Les nom, prénom et email de l'invité y sont affichés, non modifiables. L'invité doit ensuite, dans l'ordre :
- accepter la politique de confidentialité et les conditions d'utilisation (US-54) ;
- créer son mot de passe (règles de robustesse de US-3) ;
- créer son schéma tactile (US-6).

RF5 — L'activation depuis le lien vaut vérification de l'appareil utilisé : aucun code de vérification (US-51) n'est demandé sur cet appareil.

RF6 — Un lien expiré affiche le message « Ce lien d'invitation a expiré. Demandez à [prénom de l'utilisateur principal] de vous renvoyer une invitation. », sans formulaire.

RF7 — Un lien déjà utilisé affiche le message « Votre accès est déjà activé » avec un bouton « Se connecter ».

RF8 — Un lien remplacé par un nouvel envoi (US-5), ou dont l'invité a été supprimé entre-temps, affiche le même message que pour un lien expiré.

RF9 — Une fois l'activation terminée, l'invité voit le guidage d'installation (US-1) s'il est dans le navigateur, puis son dashboard, vide à ce stade (US-22).

RF10 — Une fois l'activation terminée, le statut de l'invité passe de « Invitation envoyée » à « Actif » sur l'écran de gestion des invités de l'utilisateur principal.

RF11 — L'invité ne passe pas par la configuration initiale de l'utilisateur principal. Ses informations générales ont été renseignées par l'utilisateur principal (US-11). Il devra en revanche connecter ses propres comptes pour chaque agent qui le nécessite (US-13).

RF12 — Pendant la validation de l'activation, le bouton « Activer mon accès » affiche un indicateur de chargement et est désactivé (CC-1).

RF13 — En cas d'erreur serveur, le message d'erreur standard s'affiche. Les choix déjà faits sont conservés, sauf le mot de passe (CC-2).

RF14 — En cas de délai dépassé, le message de connexion lente s'affiche avec un bouton « Réessayer » (CC-3).

RF15 — Un invité qui n'a jamais activé son accès est supprimé automatiquement 30 jours après le dernier lien envoyé (US-68). Sa place est libérée dans le quota (décision D19 du 01/10/2026).

### Règles techniques

RT1 — [backend] Le lien d'activation contient un jeton unique, impossible à deviner, qui n'est valable qu'une fois et pendant 30 minutes.

RT2 — [backend] Les SMS sont envoyés par un prestataire hébergeant ses données dans l'Union européenne.

RT3 — [backend] L'acceptation de la politique de confidentialité et des conditions d'utilisation est enregistrée avec sa date, son heure et la version des textes acceptés.

RT4 — [frontend] Sur iPhone, le lien s'ouvre dans le navigateur. L'activation se fait donc dans le navigateur, puis l'invité est guidé vers l'installation. Il faut vérifier que la session est bien reconnue une fois l'application installée.

### UX / Design

D'après la maquette : un écran d'accueil au nom de l'utilisateur principal qui invite, suivi d'étapes successives (consentement, mot de passe, schéma) avec un indicateur de progression. Le lien vers la politique de confidentialité et les conditions d'utilisation se trouve à côté de la case à cocher.

**Impact maquette :** Nouvel écran — Écran « Lien expiré » ; Écran « Accès déjà activé » ; Étapes « mot de passe » et « schéma » du parcours d'activation, avec l'indicateur de progression.

### Critères d'acceptance

**CA 1.1 — Envoi par email et SMS**
- Étant donné que Camille ajoute Thomas avec son email et son numéro de téléphone
- Quand l'ajout est validé
- Alors Thomas reçoit une invitation par email et une par SMS

**CA 1.2 — Envoi par email seul**
- Étant donné que Camille ajoute un invité sans numéro de téléphone
- Quand l'ajout est validé
- Alors l'invité reçoit l'invitation uniquement par email

**CA 2.1 — Contenu de l'invitation**
- Étant donné que Thomas a reçu une invitation de Camille
- Quand il l'ouvre
- Alors il voit le nom de Camille, une présentation de MAAQ, un lien d'activation et la mention de validité de 30 minutes

**CA 3.1 — Lien à usage unique**
- Étant donné que Thomas a activé son accès avec le lien
- Quand il ouvre de nouveau le même lien
- Alors le lien n'ouvre pas l'écran d'activation

**CA 4.1 — Activation complète**
- Étant donné que Thomas ouvre un lien valide
- Quand il accepte les conditions, crée son mot de passe et crée son schéma
- Alors son accès est activé

**CA 4.2 — Consentement obligatoire**
- Étant donné que Thomas est sur l'étape de consentement
- Quand il n'a pas coché l'acceptation des conditions
- Alors il ne peut pas passer à l'étape suivante

**CA 5.1 — Pas de code de vérification**
- Étant donné que Thomas vient d'activer son accès sur son téléphone
- Quand il se connecte ensuite sur ce même téléphone
- Alors aucun code de vérification ne lui est demandé

**CA 6.1 — Lien expiré**
- Étant donné que le lien a été envoyé il y a 31 minutes
- Quand Thomas l'ouvre
- Alors le message « Ce lien d'invitation a expiré. Demandez à Camille de vous renvoyer une invitation. » s'affiche

**CA 7.1 — Lien déjà utilisé**
- Étant donné que Thomas a déjà activé son accès
- Quand il ouvre de nouveau le lien
- Alors le message « Votre accès est déjà activé » s'affiche avec un bouton « Se connecter »

**CA 8.1 — Lien remplacé**
- Étant donné que Camille a renvoyé un nouveau lien à Thomas
- Quand Thomas ouvre l'ancien lien
- Alors le message de lien expiré s'affiche

**CA 8.2 — Invité supprimé avant activation**
- Étant donné que Camille a supprimé Thomas avant qu'il n'active son accès
- Quand Thomas ouvre le lien
- Alors le message de lien expiré s'affiche

**CA 9.1 — Arrivée sur le dashboard**
- Étant donné que Thomas a terminé son activation dans le navigateur
- Quand il ignore le guidage d'installation
- Alors son dashboard vide s'affiche avec une invitation à parcourir le catalogue

**CA 10.1 — Statut mis à jour chez l'utilisateur principal**
- Étant donné que Thomas vient d'activer son accès
- Quand Camille ouvre l'écran de gestion des invités
- Alors le statut de Thomas est « Actif »

**CA 11.1 — Pas de configuration initiale pour l'invité**
- Étant donné que Thomas a terminé son activation
- Quand il accède à MAAQ
- Alors la configuration initiale de l'utilisateur principal ne lui est pas proposée

**CA 12.1 — Chargement**
- Étant donné que Thomas a touché « Activer mon accès »
- Quand la validation est en cours
- Alors un indicateur de chargement s'affiche et le bouton est désactivé

**CA 13.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand Thomas valide son activation
- Alors le message d'erreur standard s'affiche
- Et son consentement reste coché

**CA 14.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand la validation dépasse 15 secondes
- Alors le message de connexion lente s'affiche avec un bouton « Réessayer »

**CA 15.1 — Invité jamais activé**
- Étant donné que Thomas n'a pas activé son accès 30 jours après le dernier lien envoyé
- Quand le traitement quotidien s'exécute
- Alors Thomas est supprimé et sa place est libérée dans le quota de Camille

---

## US-5 — Renvoyer un nouveau lien d'invitation expiré

**En tant qu'** utilisateur principal,
**je souhaite** renvoyer un nouveau lien d'invitation à un invité dont le précédent lien a expiré,
**afin qu'** il puisse activer son accès à MAAQ.

**Écran(s) maquette :** Gestion des invités (fiche d'un invité). **Dépendances :** US-4, US-18, US-19.

### Règles fonctionnelles

RF1 — Un invité non activé dont le lien a plus de 30 minutes apparaît avec le statut « Invitation expirée » sur l'écran de gestion des invités.

RF2 — Un bouton « Renvoyer un nouveau lien » est disponible sur la fiche de tout invité non activé, que son lien soit expiré ou non.

RF3 — Le renvoi génère un nouveau lien, valable 30 minutes et envoyé par les mêmes canaux (email et SMS si numéro renseigné), aux coordonnées actuelles de l'invité. L'ancien lien est invalidé immédiatement.

RF4 — Après le renvoi, le message « Nouveau lien envoyé à [prénom] » s'affiche, et le statut repasse à « Invitation envoyée » avec l'heure d'envoi.

RF5 — Le bouton n'est pas proposé pour un invité dont le statut est « Actif ».

RF6 — Au-delà de 3 renvois en une heure pour un même invité, le bouton est désactivé avec le message « Trop d'envois récents. Réessayez dans une heure. » Le bouton se réactive une heure plus tard (décision du 30/09/2026).

RF7 — L'écran de gestion des invités n'est accessible qu'à l'utilisateur principal.

RF8 — Pendant l'envoi, le bouton affiche un indicateur de chargement et est désactivé (CC-1).

RF9 — En cas d'erreur serveur, le message d'erreur standard s'affiche et aucun nouveau lien n'est généré (CC-2).

RF10 — En cas de délai dépassé, le message de connexion lente s'affiche avec un bouton « Réessayer » (CC-3).

RF11 — Un invité qui n'a jamais activé son accès est supprimé automatiquement 30 jours après le dernier lien envoyé (US-68). Le renvoi d'un lien remet ce délai à zéro (décision D19 du 01/10/2026).

### Règles techniques

RT1 — [backend] Un seul lien d'activation est valide à un instant donné pour un même invité.

RT2 — [backend] Le nombre de renvois est limité à 3 par heure côté serveur, pour éviter les abus d'envoi de SMS (décision du 30/09/2026).

### UX / Design

D'après la maquette : la fiche de l'invité affiche le statut « Invitation expirée » dans une couleur d'alerte, avec le bouton « Renvoyer un nouveau lien » juste en dessous. Le bouton de démonstration « Simuler l'expiration » ne fait pas partie de l'interface réelle.

**Impact maquette :** Ajustement — Statuts « Envoi en cours » et « Échec d'envoi » ; Message de limite de renvois ; Retirer le bouton de démonstration « Simuler l'expiration ».

### Critères d'acceptance

**CA 1.1 — Statut expiré**
- Étant donné que Camille a invité Élodie il y a 45 minutes et qu'Élodie n'a pas activé son accès
- Quand Camille ouvre l'écran de gestion des invités
- Alors la fiche d'Élodie affiche le statut « Invitation expirée »

**CA 2.1 — Renvoi avant expiration**
- Étant donné qu'Élodie a été invitée il y a 10 minutes
- Quand Camille ouvre la fiche d'Élodie
- Alors le bouton « Renvoyer un nouveau lien » est disponible

**CA 3.1 — Nouveau lien envoyé**
- Étant donné que le lien d'Élodie a expiré
- Quand Camille touche « Renvoyer un nouveau lien »
- Alors Élodie reçoit un nouveau lien valable 30 minutes
- Et l'ancien lien n'est plus utilisable

**CA 4.1 — Confirmation du renvoi**
- Étant donné que Camille a renvoyé un lien à Élodie
- Quand l'envoi réussit
- Alors le message « Nouveau lien envoyé à Élodie » s'affiche
- Et le statut d'Élodie redevient « Invitation envoyée » avec l'heure d'envoi

**CA 5.1 — Invité déjà actif**
- Étant donné que Thomas a activé son accès
- Quand Camille ouvre la fiche de Thomas
- Alors le bouton « Renvoyer un nouveau lien » n'est pas affiché

**CA 6.1 — Limite de renvois**
- Étant donné que Camille a renvoyé 3 liens à Élodie dans la dernière heure
- Quand elle consulte la fiche d'Élodie
- Alors le bouton est désactivé avec le message « Trop d'envois récents. Réessayez dans une heure. »

**CA 7.1 — Écran réservé à l'utilisateur principal**
- Étant donné que je suis connecté en tant qu'invité
- Quand je consulte mes Réglages
- Alors l'écran de gestion des invités n'est pas proposé

**CA 8.1 — Chargement**
- Étant donné que Camille a touché « Renvoyer un nouveau lien »
- Quand l'envoi est en cours
- Alors un indicateur de chargement s'affiche et le bouton est désactivé

**CA 9.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand Camille touche « Renvoyer un nouveau lien »
- Alors le message d'erreur standard s'affiche
- Et l'ancien lien reste inchangé

**CA 10.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand l'envoi dépasse 15 secondes
- Alors le message de connexion lente s'affiche avec un bouton « Réessayer »

**CA 11.1 — Renvoi et délai de suppression**
- Étant donné que le premier lien d'Élodie a été envoyé il y a 40 jours
- Quand Camille lui a renvoyé un lien il y a 5 jours
- Alors Élodie n'est pas supprimée automatiquement

---

## US-6 — Se reconnecter rapidement via un schéma tactile

**En tant qu'** utilisateur ou invité,
**je souhaite** déverrouiller l'application via un schéma tactile mémorisé plutôt qu'un mot de passe classique,
**afin de** retrouver mes agents le plus rapidement possible en mobilité.

**Écran(s) maquette :** Connexion (onglet « Schéma tactile »). **Dépendances :** US-3, US-51, US-7, US-8, US-52.

### Règles fonctionnelles

RF1 — Après la première connexion sur un appareil (US-3) ou l'activation d'un invité (US-4), la création d'un schéma tactile est obligatoire pour les utilisateurs et les invités.

RF2 — Le schéma se trace sur une grille de 3 × 3 points et doit relier au moins 4 points. Il doit être tracé deux fois de façon identique pour être enregistré.

RF3 — Si les deux tracés diffèrent, le message « Les deux schémas ne correspondent pas. Recommencez. » s'affiche et la création reprend au premier tracé.

RF4 — Un schéma de moins de 4 points affiche le message « Reliez au moins 4 points » et n'est pas pris en compte.

RF5 — Lors des ouvertures suivantes sur cet appareil, l'écran de déverrouillage affiche le prénom du profil et son email partiellement masqué. Le schéma suffit : aucun mot de passe n'est demandé.

RF6 — Un schéma correct donne accès au dashboard. Après un verrouillage pour inactivité (US-52), il ramène à l'écran où se trouvait le profil.

RF7 — Un schéma incorrect affiche « Schéma incorrect. Il vous reste [N] tentative(s). ».

RF8 — Après 3 échecs consécutifs, l'accès par schéma est verrouillé (US-7). Le compteur d'échecs est remis à zéro après un schéma correct.

RF9 — Un lien « Schéma oublié ? » mène au parcours de récupération (US-8).

RF10 — Un lien « Utiliser mon mot de passe » permet de se connecter par email et mot de passe à la place du schéma.

RF11 — Le schéma est propre au profil et à l'appareil : un profil qui utilise deux téléphones a un schéma sur chacun.

RF12 — L'administrateur, qui travaille sur ordinateur, n'utilise pas de schéma tactile. Il se connecte par email et mot de passe.

RF13 — Pendant la vérification du schéma, un indicateur de chargement s'affiche et la grille est inactive (CC-1).

RF14 — En cas d'erreur serveur, le message d'erreur standard s'affiche, et la tentative n'est pas comptée comme un échec (CC-2).

RF15 — En cas de délai dépassé, le message de connexion lente s'affiche, et la tentative n'est pas comptée comme un échec (CC-3).

### Règles techniques

RT1 — [backend] Le schéma est vérifié côté serveur. Il n'est jamais conservé en clair, ni sur l'appareil ni sur le serveur.

RT2 — [backend] Le compteur d'échecs est tenu côté serveur, par profil et par appareil.

RT3 — [frontend] La session mémorisée sur l'appareil dure 3 mois au maximum. Au-delà, une connexion par email et mot de passe est redemandée (décision du 30/09/2026).

### UX / Design

D'après la maquette : une grille de 9 points centrée, le prénom et l'email masqué au-dessus, les liens « Schéma oublié ? » et « Utiliser mon mot de passe » en dessous. Le tracé s'affiche en couleur pendant la saisie, en rouge en cas d'échec.

**Impact maquette :** Nouvel écran — Écran de création du schéma (deux tracés, messages d'erreur) ; Compteur de tentatives restantes ; Lien « Utiliser mon mot de passe ».

### Critères d'acceptance

**CA 1.1 — Création obligatoire**
- Étant donné que je viens de me connecter pour la première fois sur ce téléphone
- Quand la vérification d'identité est réussie
- Alors l'écran de création du schéma s'affiche et je ne peux pas accéder au dashboard sans créer de schéma

**CA 2.1 — Création réussie**
- Étant donné que je suis sur l'écran de création du schéma
- Quand je trace deux fois le même schéma reliant 5 points
- Alors mon schéma est enregistré et mon dashboard s'affiche

**CA 3.1 — Tracés différents**
- Étant donné que j'ai tracé un premier schéma
- Quand je trace un second schéma différent
- Alors le message « Les deux schémas ne correspondent pas. Recommencez. » s'affiche

**CA 4.1 — Schéma trop court**
- Étant donné que je suis sur l'écran de création du schéma
- Quand je trace un schéma de 3 points
- Alors le message « Reliez au moins 4 points » s'affiche

**CA 5.1 — Déverrouillage sans mot de passe**
- Étant donné que j'ai créé un schéma sur ce téléphone
- Quand je relance MAAQ
- Alors l'écran de déverrouillage affiche mon prénom et mon email partiellement masqué, sans champ mot de passe

**CA 6.1 — Schéma correct**
- Étant donné que l'écran de déverrouillage est affiché
- Quand je trace mon schéma correct
- Alors mon dashboard s'affiche

**CA 6.2 — Retour après verrouillage pour inactivité**
- Étant donné que MAAQ s'est verrouillée pendant que j'étais dans le tchat d'Admin_lib
- Quand je trace mon schéma correct
- Alors le tchat d'Admin_lib s'affiche de nouveau

**CA 7.1 — Schéma incorrect**
- Étant donné que l'écran de déverrouillage est affiché
- Quand je trace un schéma incorrect pour la première fois
- Alors le message « Schéma incorrect. Il vous reste 2 tentative(s). » s'affiche

**CA 8.1 — Verrouillage au troisième échec**
- Étant donné que j'ai échoué 2 fois de suite
- Quand j'échoue une troisième fois
- Alors l'écran de schéma verrouillé s'affiche

**CA 8.2 — Remise à zéro du compteur**
- Étant donné que j'ai échoué 2 fois puis réussi
- Quand je me trompe lors d'un déverrouillage ultérieur
- Alors le message indique qu'il me reste 2 tentatives

**CA 9.1 — Schéma oublié**
- Étant donné que l'écran de déverrouillage est affiché
- Quand je touche « Schéma oublié ? »
- Alors l'écran de récupération d'accès s'affiche

**CA 10.1 — Connexion par mot de passe**
- Étant donné que l'écran de déverrouillage est affiché
- Quand je touche « Utiliser mon mot de passe »
- Alors l'écran de connexion par email et mot de passe s'affiche

**CA 11.1 — Deuxième téléphone**
- Étant donné que j'ai un schéma sur mon premier téléphone
- Quand je me connecte pour la première fois sur un second téléphone
- Alors la création d'un schéma m'est demandée sur ce second téléphone

**CA 12.1 — Administrateur**
- Étant donné que je suis administrateur
- Quand je me connecte
- Alors aucun schéma tactile ne m'est demandé ni proposé

**CA 13.1 — Chargement**
- Étant donné que je viens de tracer mon schéma
- Quand la vérification est en cours
- Alors un indicateur de chargement s'affiche et la grille est inactive

**CA 14.1 — Erreur serveur non comptée**
- Étant donné que le serveur est indisponible
- Quand je trace mon schéma
- Alors le message d'erreur standard s'affiche
- Et mon nombre de tentatives restantes est inchangé

**CA 15.1 — Délai dépassé non compté**
- Étant donné que le réseau est lent
- Quand la vérification dépasse 15 secondes
- Alors le message de connexion lente s'affiche
- Et mon nombre de tentatives restantes est inchangé

---

## US-7 — Être verrouillé après plusieurs échecs du schéma tactile

**En tant qu'** utilisateur ou invité,
**je souhaite** que l'accès par schéma tactile soit verrouillé après plusieurs tentatives erronées,
**afin de** protéger mon compte en cas de tentative non autorisée.

**Écran(s) maquette :** Schéma verrouillé. **Dépendances :** US-6, US-8.

### Règles fonctionnelles

RF1 — Après 3 échecs consécutifs de schéma sur un appareil, l'écran « Accès verrouillé » s'affiche. La grille de schéma n'est plus proposée sur cet appareil.

RF2 — L'écran explique que l'accès a été verrouillé après 3 tentatives erronées, et propose un bouton « Récupérer mon accès » qui mène au parcours de récupération (US-8).

RF3 — Le verrouillage persiste après la fermeture et la réouverture de l'application. Seule la récupération (US-8) le lève.

RF4 — Pendant le verrouillage, la connexion par email et mot de passe reste possible sur cet appareil. Une connexion réussie oblige à créer un nouveau schéma.

RF5 — Le verrouillage ne concerne que l'appareil sur lequel les échecs ont eu lieu. Les autres appareils du profil ne sont pas affectés.

RF6 — Un email d'alerte est envoyé au profil concerné. Il indique qu'un verrouillage a eu lieu, avec la date, l'heure et le type d'appareil. L'heure est exprimée dans le fuseau de l'appareil concerné (décision D21 du 01/10/2026).

RF7 — Si l'écran verrouillé ne peut pas confirmer l'état du compte auprès du serveur, le message d'erreur standard s'affiche (CC-2). L'accès reste verrouillé.

RF8 — En cas de délai dépassé, le message de connexion lente s'affiche (CC-3). L'accès reste verrouillé.

RF9 — Pendant le chargement de l'écran verrouillé, un indicateur de chargement s'affiche (CC-1).

### Règles techniques

RT1 — [backend] L'état de verrouillage est enregistré côté serveur, pour ne pas pouvoir être contourné en effaçant les données de l'application.

RT2 — [backend] Chaque verrouillage est enregistré dans le journal des événements de sécurité.

### UX / Design

D'après la maquette : un écran avec une icône de cadenas, un message explicatif et un bouton principal « Récupérer mon accès ».

**Impact maquette :** Ajustement — État d'erreur serveur sur l'écran verrouillé.

### Critères d'acceptance

**CA 1.1 — Verrouillage après 3 échecs**
- Étant donné que j'ai tracé 2 schémas incorrects de suite
- Quand je trace un troisième schéma incorrect
- Alors l'écran « Accès verrouillé » s'affiche
- Et la grille de schéma n'est plus proposée

**CA 2.1 — Accès à la récupération**
- Étant donné que l'écran « Accès verrouillé » est affiché
- Quand je touche « Récupérer mon accès »
- Alors l'écran de récupération d'accès s'affiche

**CA 3.1 — Persistance du verrouillage**
- Étant donné que mon accès par schéma est verrouillé
- Quand je ferme puis relance MAAQ
- Alors l'écran « Accès verrouillé » s'affiche de nouveau

**CA 4.1 — Connexion par mot de passe pendant le verrouillage**
- Étant donné que mon accès par schéma est verrouillé
- Quand je me connecte avec mon email et mon mot de passe corrects
- Alors la création d'un nouveau schéma m'est demandée

**CA 5.1 — Autre appareil non affecté**
- Étant donné que mon schéma est verrouillé sur mon téléphone
- Quand j'ouvre MAAQ sur ma tablette
- Alors l'écran de déverrouillage par schéma s'affiche normalement

**CA 6.1 — Email d'alerte**
- Étant donné que mon accès vient d'être verrouillé
- Quand je consulte ma boîte mail
- Alors j'ai reçu un email m'informant du verrouillage, avec la date, l'heure (dans le fuseau de l'appareil) et le type d'appareil

**CA 7.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand j'ouvre MAAQ sur un appareil verrouillé
- Alors le message d'erreur standard s'affiche
- Et la grille de schéma n'est pas proposée

**CA 8.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand le chargement dépasse 15 secondes
- Alors le message de connexion lente s'affiche
- Et la grille de schéma n'est pas proposée

**CA 9.1 — Chargement**
- Étant donné que j'ouvre MAAQ sur un appareil verrouillé
- Quand l'état du compte est en cours de vérification
- Alors un indicateur de chargement s'affiche

---

## US-8 — Récupérer l'accès après un oubli du schéma tactile

**En tant qu'** utilisateur ou invité,
**je souhaite** pouvoir récupérer l'accès à mon compte si j'ai oublié mon schéma tactile ou si mon accès a été verrouillé,
**afin de** continuer à utiliser MAAQ.

**Écran(s) maquette :** Récupération d'accès. **Dépendances :** US-6, US-7, US-66.

### Règles fonctionnelles

*Cette US ne traite que le schéma tactile oublié ou verrouillé. L'oubli du mot de passe est traité par US-66 (décision D12 du 01/10/2026).*

RF1 — La récupération est accessible depuis le lien « Schéma oublié ? » de l'écran de déverrouillage, et depuis le bouton « Récupérer mon accès » de l'écran verrouillé.

RF2 — Le profil saisit son email de connexion, pré-rempli s'il est mémorisé sur l'appareil.

RF3 — Après validation, le message suivant s'affiche toujours, que l'email corresponde à un compte ou non : « Si un compte existe pour cette adresse, un code vient de vous être envoyé par email. »

RF4 — L'email contient un code de 6 chiffres, valable 30 minutes et utilisable une seule fois. Le profil saisit ce code dans MAAQ.

RF5 — Un code correct permet de créer un nouveau schéma (deux tracés identiques, règles de US-6). La création lève le verrouillage de l'appareil et remet le compteur d'échecs à zéro.

RF6 — Un code incorrect affiche « Code incorrect ». Après 5 codes incorrects, le code est invalidé et un nouveau code doit être demandé.

RF7 — Un code expiré affiche « Ce code a expiré » avec un bouton « Recevoir un nouveau code ».

RF8 — Le bouton « Recevoir un nouveau code » n'est actif que 60 secondes après l'envoi précédent. Au-delà de 5 envois en une heure, il est désactivé pendant une heure.

RF9 — Après une récupération réussie, un email confirme au profil que son schéma a été modifié.

RF10 — Pendant l'envoi du code et pendant sa vérification, un indicateur de chargement s'affiche et le bouton est désactivé (CC-1).

RF11 — En cas d'erreur serveur, le message d'erreur standard s'affiche et l'email ou le code saisi est conservé (CC-2).

RF12 — En cas de délai dépassé, le message de connexion lente s'affiche et l'email ou le code saisi est conservé (CC-3).

### Règles techniques

RT1 — [frontend] Sur iPhone, un lien reçu par email s'ouvre dans le navigateur et non dans l'application installée, qui ne partage pas les mêmes données. La récupération se fait donc par un code à saisir dans l'application, et non par un lien (décision du 30/09/2026).

RT2 — [backend] Le message affiché ne permet pas de savoir si un email correspond à un compte existant, pour empêcher la découverte des comptes [À CONFIRMER avec backend].

RT3 — [backend] Les codes sont à usage unique et ne sont jamais conservés en clair.

### UX / Design

D'après la maquette : un écran en deux temps, d'abord la saisie de l'email puis la saisie du code, suivi de la création du nouveau schéma. La maquette doit être ajustée pour la saisie du code, qui remplace le lien.

**Impact maquette :** Ajustement — Préciser que l'écran concerne le schéma tactile, et non le mot de passe ; Remplacer le lien par un écran de saisie de code à 6 chiffres (si validé) ; Création du nouveau schéma ; Code incorrect, code expiré, « Recevoir un nouveau code » avec délai de 60 secondes.

### Critères d'acceptance

**CA 1.1 — Accès depuis l'écran de déverrouillage**
- Étant donné que l'écran de déverrouillage est affiché
- Quand je touche « Schéma oublié ? »
- Alors l'écran de récupération s'affiche

**CA 1.2 — Accès depuis l'écran verrouillé**
- Étant donné que l'écran « Accès verrouillé » est affiché
- Quand je touche « Récupérer mon accès »
- Alors l'écran de récupération s'affiche

**CA 2.1 — Email pré-rempli**
- Étant donné que mon email est mémorisé sur cet appareil
- Quand l'écran de récupération s'affiche
- Alors mon email est pré-rempli

**CA 3.1 — Message neutre pour un email inconnu**
- Étant donné que je saisis un email qui ne correspond à aucun compte
- Quand je valide
- Alors le message « Si un compte existe pour cette adresse, un code vient de vous être envoyé par email. » s'affiche

**CA 4.1 — Réception du code**
- Étant donné que je saisis mon email de connexion
- Quand je valide
- Alors je reçois un email contenant un code de 6 chiffres valable 30 minutes

**CA 5.1 — Récupération réussie**
- Étant donné que j'ai reçu un code valide
- Quand je saisis ce code puis trace deux fois un nouveau schéma identique
- Alors mon nouveau schéma est enregistré
- Et mon appareil n'est plus verrouillé

**CA 6.1 — Code incorrect**
- Étant donné que j'ai reçu un code
- Quand je saisis un code erroné
- Alors le message « Code incorrect » s'affiche

**CA 6.2 — Cinq codes incorrects**
- Étant donné que j'ai saisi 4 codes incorrects
- Quand je saisis un cinquième code incorrect
- Alors le code est invalidé
- Et je dois demander un nouveau code

**CA 7.1 — Code expiré**
- Étant donné que mon code a été envoyé il y a 31 minutes
- Quand je le saisis
- Alors le message « Ce code a expiré » s'affiche avec un bouton « Recevoir un nouveau code »

**CA 8.1 — Délai avant renvoi**
- Étant donné que je viens de recevoir un code
- Quand moins de 60 secondes se sont écoulées
- Alors le bouton « Recevoir un nouveau code » est inactif

**CA 9.1 — Email de confirmation**
- Étant donné que j'ai récupéré mon accès
- Quand je consulte ma boîte mail
- Alors j'ai reçu un email m'informant que mon schéma a été modifié

**CA 10.1 — Chargement**
- Étant donné que j'ai validé mon email
- Quand l'envoi du code est en cours
- Alors un indicateur de chargement s'affiche et le bouton est désactivé

**CA 11.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand je valide mon code
- Alors le message d'erreur standard s'affiche
- Et le code saisi est conservé

**CA 12.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand la vérification du code dépasse 15 secondes
- Alors le message de connexion lente s'affiche
- Et le code saisi est conservé

---

## US-9 — Se déconnecter de l'application

**En tant qu'** utilisateur, invité ou administrateur,
**je souhaite** me déconnecter de MAAQ,
**afin de** sécuriser mon compte quand je n'utilise plus l'application.

**Écran(s) maquette :** Réglages utilisateur / Réglages invité (bouton « Se déconnecter »). **Dépendances :** US-43, US-49.

### Règles fonctionnelles

RF1 — Un bouton « Se déconnecter » est présent dans les Réglages de tous les profils.

RF2 — Pour un utilisateur ou un invité, le bouton ouvre une confirmation : « Vous déconnecter ? L'historique de vos conversations avec les agents sera effacé. Votre carnet de bord est conservé. », avec les boutons « Se déconnecter » et « Annuler ».

RF3 — Pour l'administrateur, qui n'a pas de tchat, la confirmation indique simplement « Vous déconnecter ? ».

RF4 — À la confirmation, la session est fermée, l'historique des tchats du profil est effacé (US-43) et l'écran de connexion s'affiche.

RF5 — Si l'utilisateur touche « Annuler », la confirmation se ferme et rien n'est modifié.

RF6 — Après une déconnexion, la reconnexion demande l'email et le mot de passe. L'appareil reste reconnu : aucun code de vérification n'est redemandé (US-51). Le schéma est de nouveau utilisable après cette connexion.

RF7 — Pendant la déconnexion, un indicateur de chargement s'affiche sur le bouton de confirmation (CC-1).

RF8 — En cas d'erreur serveur, la session est tout de même fermée sur l'appareil et l'écran de connexion s'affiche. La fermeture côté serveur et l'effacement de l'historique sont réessayés automatiquement (CC-2).

RF9 — En cas de délai dépassé, le comportement est identique à celui de l'erreur serveur (CC-3).

### Règles techniques

RT1 — [backend] La déconnexion invalide la session côté serveur. Une session invalidée ne peut plus être réutilisée, même si elle a été copiée.

RT2 — [backend] La déconnexion déclenche l'effacement de l'historique des tchats du profil chez Digitorn (voir US-43).

### UX / Design

D'après la maquette : le bouton « Se déconnecter » est placé en bas des Réglages, avec une note sous le bouton rappelant que l'historique des conversations sera effacé.

**Impact maquette :** Ajustement — Fenêtre de confirmation avec avertissement sur l'historique (voir MT-5).

### Critères d'acceptance

**CA 1.1 — Présence du bouton**
- Étant donné que je suis connecté
- Quand j'ouvre les Réglages
- Alors le bouton « Se déconnecter » est affiché

**CA 2.1 — Confirmation pour un utilisateur**
- Étant donné que je suis utilisateur principal
- Quand je touche « Se déconnecter »
- Alors une confirmation m'indique que l'historique de mes conversations sera effacé et que mon carnet de bord est conservé

**CA 3.1 — Confirmation pour l'administrateur**
- Étant donné que je suis administrateur
- Quand je clique sur « Se déconnecter »
- Alors une confirmation « Vous déconnecter ? » s'affiche sans mention de conversation

**CA 4.1 — Déconnexion confirmée**
- Étant donné que la confirmation est affichée
- Quand je touche « Se déconnecter »
- Alors l'écran de connexion s'affiche
- Et l'historique de mes tchats est vide lors de ma prochaine connexion

**CA 5.1 — Annulation**
- Étant donné que la confirmation est affichée
- Quand je touche « Annuler »
- Alors je reste sur les Réglages, toujours connecté

**CA 6.1 — Reconnexion après déconnexion**
- Étant donné que je me suis déconnecté
- Quand je relance MAAQ
- Alors l'écran de connexion par email et mot de passe s'affiche
- Et aucun code de vérification ne m'est demandé après la saisie de mes identifiants

**CA 7.1 — Chargement**
- Étant donné que j'ai confirmé la déconnexion
- Quand elle est en cours
- Alors un indicateur de chargement s'affiche sur le bouton

**CA 8.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand je confirme la déconnexion
- Alors l'écran de connexion s'affiche quand même

**CA 9.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand la déconnexion dépasse 15 secondes
- Alors l'écran de connexion s'affiche quand même

---

## US-66 — Réinitialiser mon mot de passe oublié


*US créée suite à la décision D12.*

**En tant qu'** utilisateur, invité ou administrateur,
**je souhaite** réinitialiser mon mot de passe grâce à un code reçu par email,
**afin de** retrouver l'accès à mon compte sans solliciter le support.

**Écran(s) maquette :** Connexion (lien « Mot de passe oublié ? ») ; Récupération d'accès (à adapter) ; Nouveau mot de passe (à créer). **Dépendances :** US-3, US-6, US-8, US-51.

### Règles fonctionnelles

RF1 — Le lien « Mot de passe oublié ? » de l'écran de connexion (US-3 RF9) ouvre le parcours de réinitialisation du mot de passe. Il est distinct du parcours « Schéma oublié ? » (US-8).

RF2 — Le profil saisit son email de connexion, pré-rempli s'il est mémorisé sur l'appareil.

RF3 — Après validation, le message suivant s'affiche toujours, que l'email corresponde à un compte ou non : « Si un compte existe pour cette adresse, un code vient de vous être envoyé par email. »

RF4 — L'email contient un code de 6 chiffres. Aucun lien n'est envoyé. Le profil saisit le code dans MAAQ. Le code est valable 30 minutes et utilisable une seule fois [Proposition du BA : mêmes règles que le code de récupération du schéma, US-8 RF4].

RF5 — Un code incorrect affiche « Code incorrect ». Après 5 codes incorrects, le code est invalidé et un nouveau code doit être demandé. Un code expiré affiche « Ce code a expiré » avec un bouton « Recevoir un nouveau code ». Le bouton n'est actif que 60 secondes après l'envoi précédent ; au-delà de 5 envois en une heure, il est désactivé pendant une heure [Proposition du BA : mêmes règles que US-8 RF6 à RF8].

RF6 — Un code correct ouvre l'écran « Nouveau mot de passe ». Le profil choisit un mot de passe qui respecte les règles de robustesse de US-3 RT4 (au moins 10 caractères, dont une lettre et un chiffre), et le saisit deux fois (décision du 01/10/2026).

RF7 — Après l'enregistrement, MAAQ propose au profil de créer un nouveau schéma tactile sur cet appareil (deux tracés identiques, règles de US-6). Le schéma est une possibilité et non une obligation. S'il est créé, il lève le verrouillage éventuel de l'appareil (US-7). S'il est ignoré, la connexion se fait par mot de passe (décision du 01/10/2026).

RF8 — Après la réinitialisation, le blocage de la connexion par mot de passe (US-3 RF4) est levé et le compteur d'échecs remis à zéro [Proposition du BA].

RF9 — Les sessions ouvertes du profil sur les autres appareils sont fermées après le changement de mot de passe (décision du 01/10/2026).

RF10 — Un email confirme au profil que son mot de passe a été modifié, avec la date et l'heure dans le fuseau de l'appareil [Proposition du BA, par analogie avec US-8 RF9].

RF11 — Un compte en délai de grâce de suppression, un compte supprimé définitivement ou un invité supprimé reçoit le même message neutre qu'au RF3 et aucun code n'est envoyé (cohérent avec US-3 RF10, RF11).

RF12 — Pour l'administrateur, qui se connecte par mot de passe sur ordinateur, le parcours est identique, sans proposition de schéma. La vérification d'identité sur un nouvel appareil (US-51) s'applique ensuite.

RF13 — Pendant l'envoi du code, sa vérification et l'enregistrement du mot de passe, un indicateur de chargement s'affiche et le bouton est désactivé (CC-1).

RF14 — En cas d'erreur serveur, le message d'erreur standard s'affiche et l'email ou le code saisi est conservé, mais jamais le mot de passe (CC-2).

RF15 — En cas de délai dépassé, le message de connexion lente s'affiche et l'email ou le code saisi est conservé (CC-3).

### Règles techniques

RT1 — [backend] Les codes sont à usage unique et ne sont jamais conservés en clair. Le message affiché ne permet pas de savoir si un email correspond à un compte existant.

RT2 — [backend] Le nombre d'envois est limité côté serveur, par profil, pour éviter les abus d'envoi d'emails.

RT3 — [backend] Chaque changement de mot de passe est enregistré dans le journal des événements de sécurité.

RT4 — [frontend] Sur iPhone, la réinitialisation se fait par un code à saisir dans l'application installée, et non par un lien, pour la même raison que US-8 RT1.

### UX / Design

Un parcours en trois temps : saisie de l'email, saisie du code, choix du nouveau mot de passe, suivi de la proposition de créer un schéma. La maquette « Récupération d'accès » de US-8 peut servir de base pour les deux premiers écrans ; l'écran « Nouveau mot de passe » est à créer.

**Impact maquette :** Nouvel écran — Écran « Nouveau mot de passe » (double saisie) ; Proposition de créer un nouveau schéma après la réinitialisation ; Écran de saisie de l'email et du code (sur la base de l'écran Récupération d'accès).

### Critères d'acceptance

**CA 1.1 — Accès au parcours**
- Étant donné que je suis sur l'écran de connexion
- Quand je touche « Mot de passe oublié ? »
- Alors l'écran de réinitialisation du mot de passe s'affiche

**CA 2.1 — Email pré-rempli**
- Étant donné que mon email est mémorisé sur l'appareil
- Quand l'écran de réinitialisation s'affiche
- Alors le champ email est pré-rempli

**CA 3.1 — Message neutre**
- Étant donné que je saisis une adresse qui n'est associée à aucun compte
- Quand je valide
- Alors le message « Si un compte existe pour cette adresse, un code vient de vous être envoyé par email. » s'affiche

**CA 4.1 — Code envoyé par email, sans lien**
- Étant donné que je saisis mon email de connexion
- Quand je valide
- Alors je reçois un email contenant un code de 6 chiffres et aucun lien de réinitialisation

**CA 5.1 — Code incorrect**
- Étant donné que j'ai demandé un code
- Quand je saisis un code erroné
- Alors le message « Code incorrect » s'affiche

**CA 5.2 — Code invalidé après 5 erreurs**
- Étant donné que j'ai saisi 5 codes incorrects
- Quand je saisis un sixième code, même correct
- Alors le code est refusé et je dois demander un nouveau code

**CA 5.3 — Code expiré**
- Étant donné que mon code a plus de 30 minutes
- Quand je le saisis
- Alors le message « Ce code a expiré » s'affiche avec un bouton « Recevoir un nouveau code »

**CA 5.4 — Renvoi limité**
- Étant donné que j'ai demandé 5 codes en une heure
- Quand je consulte l'écran
- Alors le bouton « Recevoir un nouveau code » est désactivé pendant une heure

**CA 6.1 — Nouveau mot de passe valide**
- Étant donné que j'ai saisi un code correct
- Quand je choisis un mot de passe de 12 caractères avec une lettre et un chiffre et que je le confirme
- Alors le mot de passe est enregistré

**CA 6.2 — Mot de passe trop faible**
- Étant donné que j'ai saisi un code correct
- Quand je choisis un mot de passe de 6 caractères
- Alors un message indique les règles de robustesse et le mot de passe n'est pas enregistré

**CA 7.1 — Proposition de schéma**
- Étant donné que mon mot de passe vient d'être réinitialisé
- Quand l'enregistrement se termine
- Alors MAAQ me propose de créer un nouveau schéma tactile

**CA 7.2 — Schéma créé après réinitialisation**
- Étant donné que l'accès par schéma était verrouillé sur cet appareil
- Quand je crée un nouveau schéma après la réinitialisation
- Alors le verrouillage de l'appareil est levé

**CA 8.1 — Blocage levé**
- Étant donné que ma connexion par mot de passe était bloquée après 5 échecs
- Quand je réinitialise mon mot de passe
- Alors je peux me connecter avec le nouveau mot de passe sans attendre

**CA 9.1 — Sessions des autres appareils fermées**
- Étant donné que je suis connecté sur mon téléphone et sur ma tablette
- Quand je réinitialise mon mot de passe depuis mon téléphone
- Alors ma session sur la tablette est fermée

**CA 10.1 — Email de confirmation**
- Étant donné que j'ai réinitialisé mon mot de passe
- Quand l'opération se termine
- Alors je reçois un email m'informant du changement, avec la date et l'heure

**CA 11.1 — Compte en délai de grâce**
- Étant donné que mon compte est en délai de grâce de suppression
- Quand je demande un code
- Alors le message neutre s'affiche et aucun code n'est envoyé

**CA 12.1 — Administrateur**
- Étant donné que je suis administrateur
- Quand je réinitialise mon mot de passe
- Alors aucune proposition de schéma ne m'est faite

**CA 13.1 — Chargement**
- Étant donné que je valide mon email ou mon code
- Quand l'opération est en cours
- Alors un indicateur de chargement s'affiche et le bouton est désactivé

**CA 14.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand je valide mon code
- Alors le message d'erreur standard s'affiche et mon code reste saisi

**CA 15.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand l'opération dépasse 15 secondes
- Alors le message de connexion lente s'affiche et mon code reste saisi

---

# Module B — Configuration (Utilisateur et invité)

## US-10 — Renseigner les informations nécessaires aux agents

**En tant qu'** utilisateur principal,
**je souhaite** renseigner, dès ma première connexion, les informations dont les agents ont besoin pour agir en mon nom,
**afin de** pouvoir ensuite solliciter les agents sans ressaisir ces informations à chaque demande.

**Écran(s) maquette :** Configuration initiale (étape 1) ; Réglages utilisateur (section « Mes informations »). **Dépendances :** US-3, US-12, US-38.

### Règles fonctionnelles

RF1 — À sa première connexion, l'utilisateur principal suit un parcours de configuration initiale en deux étapes : « Mes informations » (cette US), puis « Informations de mon invité » (US-11).

RF2 — Les informations demandées ne sont pas figées (décision du 30/09/2026). Lors de la publication d'un agent (US-45), l'administrateur définit librement les champs que l'utilisateur doit renseigner pour cet agent : libellé, type (texte, téléphone, code postal, date passée, email), obligatoire ou facultatif, valeur unique ou liste (avec un nombre maximum d'éléments) et, éventuellement, une clé commune. Ces champs sont propres à l'agent (décision D15 du 01/10/2026). À la première connexion, l'étape « Mes informations » ne présente que le prénom, le nom et l'email de connexion. Les autres informations sont demandées au moment où le profil ajoute un agent qui en a besoin (RF12).

RF3 — Les informations déjà connues à la souscription (prénom, nom, email de connexion) sont pré-remplies. L'email de connexion est affiché mais non modifiable.

RF4 — Les formats sont contrôlés à la sortie de chaque champ : téléphone au format français ou international, code postal à 5 chiffres pour la France, date de naissance passée. Un format invalide affiche un message sous le champ concerné.

RF5 — Le bouton « Continuer » reste inactif tant qu'un champ obligatoire est vide ou invalide.

RF6 — Tant que la configuration initiale n'est pas terminée, aucun tchat d'agent ne peut être ouvert. Le catalogue reste consultable.

RF7 — Si l'utilisateur quitte le parcours avant la fin, les informations déjà validées sont conservées. Le parcours reprend à l'étape non terminée lors de la connexion suivante.

RF8 — Les informations enregistrées sont transmises aux agents comme contexte de chaque demande de l'utilisateur principal (US-38).

RF9 — Pendant l'enregistrement, le bouton « Continuer » affiche un indicateur de chargement et est désactivé (CC-1).

RF10 — En cas d'erreur serveur, le message d'erreur standard s'affiche et les informations saisies sont conservées (CC-2).

RF11 — En cas de délai dépassé, le message de connexion lente s'affiche et les informations saisies sont conservées (CC-3).

RF12 — Quand le profil ajoute un agent qui demande des informations non encore fournies, un formulaire « Informations nécessaires à [agent] » s'ouvre juste après l'ajout. Les informations saisies sont enregistrées pour cet agent. Si un champ du formulaire porte la même clé commune et le même type qu'un champ déjà renseigné pour un autre agent, la valeur déjà saisie est proposée pré-remplie ; le profil la confirme ou la modifie. La valeur confirmée est une copie propre à cet agent : la modifier ne modifie pas la valeur de l'autre agent (décision D15 du 01/10/2026). Si le profil ferme le formulaire sans le remplir, l'agent reste « À configurer » (US-29) et les informations manquantes sont signalées dans Réglages > Mes informations.

RF13 — Dans Réglages > Mes informations, les informations sont présentées par agent. Pour un champ de type liste, le profil peut ajouter des éléments jusqu'au nombre maximum prévu (décision D15 du 01/10/2026).

### Règles techniques

RT1 — [backend] Les informations personnelles sont chiffrées dans la base de données et hébergées dans l'Union européenne.

RT2 — [backend] Les informations sont transmises à Digitorn sous forme chiffrée, puis déchiffrées côté Digitorn. Elles sont mises à jour à chaque ouverture de session (décision du 29/09/2026). Le format d'échange reste à formaliser avec Digitorn. Seules les informations de l'agent concerné sont transmises avec la demande adressée à cet agent [À CONFIRMER avec Digitorn : format d'échange par agent].

### UX / Design

D'après la maquette : un parcours en 2 étapes avec un indicateur « Étape 1 sur 2 ». Les champs obligatoires sont signalés par un astérisque, et le bouton « Continuer » est en bas d'écran.

**Impact maquette :** Ajustement — Valeurs pré-remplies dans le formulaire d'un agent, avec un libellé indiquant leur provenance ; Réglages > Mes informations regroupées par agent ; Champ de type liste avec « Ajouter un élément » et message de limite ; Étape « Mes informations » réduite au prénom, au nom et à l'email de connexion ; Nouveau formulaire « Informations nécessaires à [agent] » ouvert après l'ajout d'un agent ; Signalement d'une information manquante dans Réglages > Mes informations ; Message « Terminez votre configuration » à l'ouverture d'un tchat avant la fin du parcours ; Erreurs de format sous les champs.

### Critères d'acceptance

**CA 1.1 — Parcours à la première connexion**
- Étant donné que Camille se connecte pour la première fois
- Quand sa connexion réussit
- Alors l'étape « Mes informations » de la configuration initiale s'affiche avec l'indication « Étape 1 sur 2 »

**CA 2.1 — Champs proposés**
- Étant donné que l'étape « Mes informations » est affichée
- Quand Camille la consulte
- Alors elle voit uniquement son prénom, son nom et son email de connexion

**CA 3.1 — Pré-remplissage**
- Étant donné que Camille a souscrit avec son prénom, son nom et son email
- Quand l'étape « Mes informations » s'affiche
- Alors son prénom et son nom sont pré-remplis
- Et son email de connexion est affiché sans possibilité de le modifier

**CA 4.1 — Téléphone invalide**
- Étant donné que Camille saisit « 06 12 » dans le champ téléphone
- Quand elle quitte le champ
- Alors un message indique que le numéro de téléphone est invalide

**CA 5.1 — Bouton inactif**
- Étant donné que le champ ville est vide
- Quand Camille remplit tous les autres champs obligatoires
- Alors le bouton « Continuer » reste inactif

**CA 6.1 — Tchat inaccessible avant la fin**
- Étant donné que Camille n'a pas terminé la configuration initiale
- Quand elle tente d'ouvrir le tchat d'un agent
- Alors un message l'invite à terminer sa configuration, avec un lien pour la reprendre

**CA 7.1 — Reprise du parcours**
- Étant donné que Camille a validé l'étape 1 puis fermé l'application
- Quand elle se reconnecte
- Alors l'étape « Informations de mon invité » s'affiche
- Et ses informations de l'étape 1 sont conservées

**CA 8.1 — Transmission aux agents**
- Étant donné que Camille a renseigné son adresse postale
- Quand elle demande à un agent une action qui nécessite son adresse
- Alors l'agent utilise cette adresse sans la lui redemander

**CA 9.1 — Chargement**
- Étant donné que Camille a touché « Continuer »
- Quand l'enregistrement est en cours
- Alors un indicateur de chargement s'affiche et le bouton est désactivé

**CA 10.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand Camille touche « Continuer »
- Alors le message d'erreur standard s'affiche
- Et ses informations restent saisies

**CA 11.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand l'enregistrement dépasse 15 secondes
- Alors le message de connexion lente s'affiche
- Et ses informations restent saisies

**CA 12.1 — Information demandée par un nouvel agent**
- Étant donné qu'un agent demande le numéro de sécurité sociale, que Camille n'a pas encore fourni
- Quand Camille ajoute cet agent à son dashboard
- Alors le formulaire « Informations nécessaires à [agent] » s'ouvre et lui demande ce numéro

**CA 12.2 — Formulaire fermé sans saisie**
- Étant donné que le formulaire « Informations nécessaires à [agent] » est ouvert
- Quand Camille le ferme sans le remplir
- Alors l'agent est « À configurer »
- Et l'information manquante est signalée dans Réglages > Mes informations

**CA 12.3 — Valeur proposée pré-remplie**
- Étant donné que Camille a déjà saisi son téléphone pour Admin_lib et que le champ « Téléphone » de l'agent Admin_Ndf a la même clé commune
- Quand Camille ajoute Admin_Ndf à son dashboard
- Alors le formulaire « Informations nécessaires à Admin_Ndf » propose son téléphone pré-rempli

**CA 12.4 — Copie indépendante**
- Étant donné que Camille a confirmé le téléphone pré-rempli pour Admin_Ndf
- Quand elle modifie ensuite le téléphone d'Admin_lib
- Alors le téléphone d'Admin_Ndf reste inchangé

**CA 12.5 — Types différents**
- Étant donné que deux champs ont la même clé commune mais des types différents
- Quand Camille ouvre le formulaire du second agent
- Alors aucune valeur n'est pré-remplie

**CA 12.6 — Champ de type liste**
- Étant donné qu'un champ « Contacts » accepte 3 éléments au maximum
- Quand Camille tente d'ajouter un quatrième contact
- Alors un message indique que la limite de 3 éléments est atteinte

**CA 13.1 — Informations présentées par agent**
- Étant donné que Camille a renseigné des informations pour deux agents
- Quand elle ouvre Réglages > Mes informations
- Alors ses informations sont regroupées par agent

---

## US-11 — Renseigner les informations concernant son invité

**En tant qu'** utilisateur principal,
**je souhaite** renseigner les informations nécessaires concernant mon invité,
**afin que** les agents puissent également réaliser des actions pour le compte de mon invité.

**Écran(s) maquette :** Configuration initiale (étape 2) ; Réglages utilisateur (section « Informations de mon invité »). **Dépendances :** US-10, US-18, US-12.

### Règles fonctionnelles

RF1 — L'étape 2 de la configuration initiale, « Informations de mon invité », est facultative. Un bouton « Passer cette étape » termine la configuration sans renseigner d'invité.

RF2 — Les champs proposés pour un invité sont ceux des agents que cet invité a ajoutés à son dashboard (US-10), avec en plus l'email de l'invité (décision D15 du 01/10/2026). Comme pour l'utilisateur principal, quand l'invité ajoute un agent, le formulaire « Informations nécessaires à [agent] » s'ouvre pour lui, avec ses propres valeurs. L'utilisateur principal peut aussi renseigner ou corriger ces informations depuis Réglages > Informations de mes invités, regroupées par agent (décision du 01/10/2026).

RF3 — Les informations renseignées à l'étape 2 concernent l'invité 1. Renseigner cette étape ne déclenche pas l'envoi de l'invitation, qui est faite depuis l'écran de gestion des invités (US-18).

RF4 — Les informations des invités secondaires sont renseignées depuis les Réglages, dans la section « Informations de mes invités », une fiche par invité.

RF5 — Les contrôles de format sont les mêmes qu'en US-10.

RF6 — Les informations d'un invité sont transmises aux agents comme contexte de chaque demande faite par cet invité.

RF7 — L'invité peut consulter et modifier ses propres informations depuis ses Réglages (US-12). La dernière modification enregistrée, par l'utilisateur principal ou par l'invité, est celle qui s'applique.

RF8 — Une fois l'étape 2 validée ou passée, la configuration initiale est terminée et le dashboard s'affiche, avec la proposition d'ajouter un invité si aucun n'a encore été invité.

RF9 — Pendant l'enregistrement, un indicateur de chargement s'affiche sur le bouton (CC-1).

RF10 — En cas d'erreur serveur, le message d'erreur standard s'affiche et les informations saisies sont conservées (CC-2).

RF11 — En cas de délai dépassé, le message de connexion lente s'affiche et les informations saisies sont conservées (CC-3).

RF12 — Les informations saisies par l'invité ou par l'utilisateur principal pour un même agent sont les mêmes valeurs : la dernière modification enregistrée s'applique (voir RF7) (décision du 01/10/2026).

### Règles techniques

RT1 — [backend] Les informations d'un invité sont rattachées à sa fiche d'invité. Elles sont supprimées avec son compte (US-20, US-56).

RT2 — [backend] Mêmes règles de chiffrement et de transmission à Digitorn que pour US-10.

### UX / Design

D'après la maquette : l'étape 2 affiche « Étape 2 sur 2 », avec un lien « Passer cette étape » en plus du bouton « Terminer ».

**Impact maquette :** Ajustement — Lien « Passer cette étape » ; Fiches « Informations de mes invités » pour les invités secondaires dans les Réglages.

### Critères d'acceptance

**CA 1.1 — Étape facultative**
- Étant donné que Camille est à l'étape 2 de la configuration initiale
- Quand elle touche « Passer cette étape »
- Alors la configuration initiale est terminée et son dashboard s'affiche

**CA 2.1 — Champs de l'invité**
- Étant donné que l'étape 2 est affichée
- Quand Camille la consulte
- Alors elle voit le prénom, le nom et l'email de l'invité, les autres informations étant demandées agent par agent

**CA 3.1 — Pas d'invitation automatique**
- Étant donné que Camille a renseigné les informations de Thomas à l'étape 2
- Quand elle termine la configuration initiale
- Alors aucune invitation n'est envoyée à Thomas

**CA 4.1 — Informations d'un invité secondaire**
- Étant donné qu'Élodie est l'invitée secondaire de Camille
- Quand Camille ouvre la section « Informations de mes invités » de ses Réglages
- Alors une fiche Élodie est proposée pour renseigner ses informations

**CA 5.1 — Contrôle de format**
- Étant donné que Camille saisit un code postal de 4 chiffres pour Thomas
- Quand elle quitte le champ
- Alors un message indique que le code postal est invalide

**CA 6.1 — Contexte de l'invité**
- Étant donné que l'adresse de Thomas est renseignée
- Quand Thomas demande à un agent une action nécessitant son adresse
- Alors l'agent utilise l'adresse de Thomas et non celle de Camille

**CA 7.1 — Dernière modification retenue**
- Étant donné que Camille a renseigné le téléphone de Thomas
- Quand Thomas modifie ensuite son téléphone dans ses Réglages
- Alors c'est le téléphone saisi par Thomas qui est affiché aux deux profils

**CA 8.1 — Fin de configuration**
- Étant donné que Camille valide l'étape 2
- Quand l'enregistrement réussit
- Alors son dashboard s'affiche

**CA 9.1 — Chargement**
- Étant donné que Camille a touché « Terminer »
- Quand l'enregistrement est en cours
- Alors un indicateur de chargement s'affiche et le bouton est désactivé

**CA 10.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand Camille touche « Terminer »
- Alors le message d'erreur standard s'affiche
- Et les informations de Thomas restent saisies

**CA 11.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand l'enregistrement dépasse 15 secondes
- Alors le message de connexion lente s'affiche
- Et les informations restent saisies

**CA 12.1 — Formulaire à l'ajout d'un agent par l'invité**
- Étant donné que Thomas ajoute Admin_lib, qui demande son téléphone
- Quand l'ajout est terminé
- Alors le formulaire « Informations nécessaires à Admin_lib » s'ouvre pour Thomas

**CA 12.2 — Correction par l'utilisateur principal**
- Étant donné que Thomas a renseigné son téléphone pour Admin_lib
- Quand Camille le corrige dans Réglages > Informations de mes invités, rubrique Admin_lib
- Alors Admin_lib utilise le téléphone corrigé pour les demandes de Thomas

---

## US-12 — Modifier mes informations de configuration

**En tant qu'** utilisateur principal,
**je souhaite** modifier à tout moment les informations que j'ai renseignées (les miennes ou celles de mon invité),
**afin de** garder ces informations à jour dans le temps.

**Écran(s) maquette :** Réglages utilisateur ; Réglages invité (ses propres informations). **Dépendances :** US-10, US-11, US-49.

### Règles fonctionnelles

RF1 — L'utilisateur principal retrouve dans ses Réglages la section « Mes informations » et la section « Informations de mes invités ». L'invité retrouve uniquement la section « Mes informations ». Dans chaque section, les informations sont présentées par agent (décision D15 du 01/10/2026).

RF2 — Chaque section s'affiche en mode consultation. Le bouton « Modifier » fait passer la section en mode édition. On sort du mode édition par « Enregistrer » ou « Annuler ».

RF3 — En mode édition, les contrôles de format et les champs obligatoires sont ceux de US-10. Un champ obligatoire ne peut pas être vidé.

RF4 — Si l'utilisateur touche « Annuler » alors qu'il a des modifications non enregistrées, la confirmation « Abandonner vos modifications ? » s'affiche.

RF5 — Après l'enregistrement, le message « Informations mises à jour » s'affiche et la section repasse en mode consultation. Les nouvelles informations sont transmises immédiatement à Digitorn et prises en compte dès la demande suivante (décision du 30/09/2026).

RF6 — L'invité peut modifier ses propres informations. Il ne voit ni ne modifie celles de l'utilisateur principal ou des autres invités.

RF7 — L'email de connexion n'est pas modifiable depuis cet écran.

RF8 — Si deux profils modifient les mêmes informations en même temps, la dernière modification enregistrée est retenue.

RF9 — Pendant l'enregistrement, le bouton « Enregistrer » affiche un indicateur de chargement et est désactivé (CC-1).

RF10 — En cas d'erreur serveur, le message d'erreur standard s'affiche, la section reste en mode édition et les modifications sont conservées (CC-2).

RF11 — En cas de délai dépassé, le message de connexion lente s'affiche, la section reste en mode édition et les modifications sont conservées (CC-3).

### Règles techniques

RT1 — [backend] Chaque modification est horodatée et rattachée au profil qui l'a faite.

RT2 — [backend] La modification déclenche la mise à jour des informations transmises à Digitorn (voir US-10).

### UX / Design

D'après la maquette : chaque section est une carte avec un bouton « Modifier ». Le mode édition est défini par la RF2 : on y entre par « Modifier » et on en sort par « Enregistrer » ou « Annuler ».

**Impact maquette :** Ajustement — Sections « Mes informations » et « Informations de mes invités » présentées par agent ; Mode édition des sections avec « Enregistrer » et « Annuler » ; Confirmation « Abandonner vos modifications ? ».

### Critères d'acceptance

**CA 1.1 — Sections de l'utilisateur principal**
- Étant donné que je suis utilisateur principal
- Quand j'ouvre mes Réglages
- Alors je vois les sections « Mes informations » et « Informations de mes invités »

**CA 1.2 — Section de l'invité**
- Étant donné que je suis invité
- Quand j'ouvre mes Réglages
- Alors je vois uniquement la section « Mes informations »

**CA 2.1 — Entrée en mode édition**
- Étant donné que la section « Mes informations » est en mode consultation
- Quand je touche « Modifier »
- Alors les champs deviennent modifiables et les boutons « Enregistrer » et « Annuler » s'affichent

**CA 3.1 — Champ obligatoire vidé**
- Étant donné que je suis en mode édition
- Quand je vide le champ nom
- Alors le bouton « Enregistrer » est inactif et un message indique que le champ est obligatoire

**CA 4.1 — Abandon des modifications**
- Étant donné que j'ai modifié mon téléphone sans enregistrer
- Quand je touche « Annuler »
- Alors la confirmation « Abandonner vos modifications ? » s'affiche

**CA 5.1 — Enregistrement réussi**
- Étant donné que j'ai modifié mon adresse
- Quand je touche « Enregistrer »
- Alors le message « Informations mises à jour » s'affiche
- Et la section repasse en mode consultation avec la nouvelle adresse

**CA 6.1 — Périmètre de l'invité**
- Étant donné que je suis Thomas, invité de Camille
- Quand j'ouvre mes Réglages
- Alors je ne vois pas les informations de Camille ni celles d'Élodie

**CA 7.1 — Email de connexion non modifiable**
- Étant donné que je suis en mode édition
- Quand je consulte mon email de connexion
- Alors il est affiché sans possibilité de le modifier

**CA 8.1 — Modifications concurrentes**
- Étant donné que Camille et Thomas modifient le téléphone de Thomas presque en même temps
- Quand Thomas enregistre après Camille
- Alors c'est le téléphone saisi par Thomas qui est conservé

**CA 9.1 — Chargement**
- Étant donné que j'ai touché « Enregistrer »
- Quand l'enregistrement est en cours
- Alors un indicateur de chargement s'affiche et le bouton est désactivé

**CA 10.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand je touche « Enregistrer »
- Alors le message d'erreur standard s'affiche
- Et je reste en mode édition avec mes modifications

**CA 11.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand l'enregistrement dépasse 15 secondes
- Alors le message de connexion lente s'affiche
- Et je reste en mode édition avec mes modifications

---

## US-13 — Renseigner l'adresse email de connexion d'un agent

**En tant qu'** utilisateur principal ou invité,
**je souhaite** renseigner, pour un agent donné, l'adresse email que celui-ci doit utiliser pour se connecter à mon Google Drive et/ou mon Google Agenda,
**afin qu'** il puisse configurer ses connecteurs et réaliser les actions qui en dépendent.

**Écran(s) maquette :** Connecteurs (utilisateur) ; Connecteurs invité. **Dépendances :** US-14, US-26, US-29, US-67.

### Règles fonctionnelles

RF1 — L'écran Connecteurs affiche un onglet par agent du profil qui a besoin d'au moins un connecteur. Il est accessible depuis les Réglages et depuis le message « À configurer » d'un agent (US-29).

RF2 — Pour chaque connecteur requis par l'agent (Google Drive, Google Agenda), un champ permet de saisir l'adresse du compte Google à utiliser.

RF3 — Chaque profil connecte ses propres comptes Google. Un invité ne voit pas les comptes connectés par l'utilisateur principal, et inversement. Exception : le Google Drive du compte est une connexion unique du compte, établie par l'utilisateur principal (US-67). Les invités en voient l'état, sans pouvoir le modifier (décision D14 du 01/10/2026).

RF4 — L'adresse doit être au format email valide. Sinon, le message « Adresse email invalide » s'affiche sous le champ.

RF5 — Après la saisie, le bouton « Connecter » ouvre le panneau des permissions (US-14).

RF6 — Chaque connecteur affiche un statut : « Non configuré », « Autorisation en attente », « Connecté » ou « À reconnecter ».

RF7 — Si le profil a déjà connecté un compte Google pour un autre agent, cette adresse lui est proposée pour éviter de la ressaisir.

RF8 — Modifier l'adresse d'un connecteur déjà connecté demande une nouvelle autorisation (US-14). L'autorisation de l'ancien compte est retirée.

RF9 — Un bouton « Déconnecter » retire le connecteur après confirmation. Les actions de l'agent qui en dépendent deviennent indisponibles (US-29).

RF10 — La configuration des connecteurs d'un agent est conservée si l'agent est retiré du dashboard (US-28), et retrouvée s'il est rajouté.

RF11 — Pendant l'enregistrement, un indicateur de chargement s'affiche sur le bouton « Connecter » (CC-1).

RF12 — En cas d'erreur serveur, le message d'erreur standard s'affiche et l'adresse saisie est conservée (CC-2).

RF13 — En cas de délai dépassé, le message de connexion lente s'affiche et l'adresse saisie est conservée (CC-3).

### Règles techniques

RT1 — [backend] La connexion aux comptes Google passe par Digitorn. MAAQ ne stocke jamais les mots de passe Google.

RT2 — [backend] La liste des connecteurs requis par un agent est définie lors de sa mise à disposition (US-45). Pour chaque connecteur, l'administrateur précise si la connexion est propre à chaque profil, propre à l'utilisateur principal, ou unique pour le compte (décision D14 du 01/10/2026).

RT3 — [backend] Le statut « À reconnecter » est positionné lorsque Digitorn signale une autorisation expirée ou révoquée.

### UX / Design

D'après la maquette : un onglet par agent (par exemple Admin_Classify, Admin_lib), une carte par connecteur avec le champ adresse, le statut et le bouton « Connecter ». L'écran Connecteurs invité présente la même structure avec les comptes propres de l'invité.

**Impact maquette :** Ajustement — Ligne « Google Drive du compte » en lecture seule pour les invités ; Statuts des connecteurs (Non configuré, Autorisation en attente, Connecté, À reconnecter) ; Bouton « Déconnecter » ; Proposition d'une adresse déjà connectée.

### Critères d'acceptance

**CA 1.1 — Onglets par agent**
- Étant donné que Camille a ajouté Admin_Classify et Admin_lib à son dashboard
- Quand elle ouvre l'écran Connecteurs
- Alors elle voit un onglet Admin_Classify et un onglet Admin_lib

**CA 2.1 — Connecteur Agenda d'Admin_lib**
- Étant donné que l'onglet Admin_lib est affiché
- Quand Camille le consulte
- Alors elle voit un champ pour l'adresse de son compte Google Agenda

**CA 3.1 — Comptes propres à chaque profil**
- Étant donné que Camille a connecté son Agenda à Admin_lib
- Quand Thomas ouvre l'onglet Admin_lib de ses connecteurs
- Alors le connecteur Agenda de Thomas est « Non configuré »
- Et l'adresse de Camille n'est pas affichée

**CA 4.1 — Adresse invalide**
- Étant donné que Thomas saisit « thomas@ » dans le champ
- Quand il quitte le champ
- Alors le message « Adresse email invalide » s'affiche

**CA 5.1 — Ouverture du panneau de permissions**
- Étant donné que Thomas a saisi une adresse valide
- Quand il touche « Connecter »
- Alors le panneau des permissions s'ouvre

**CA 6.1 — Statut connecté**
- Étant donné que Thomas a accordé les permissions
- Quand il revient sur l'écran Connecteurs
- Alors le connecteur Agenda affiche le statut « Connecté »

**CA 7.1 — Proposition d'une adresse déjà utilisée**
- Étant donné que Camille a connecté son Drive à Admin_Classify
- Quand elle configure le connecteur Agenda d'Admin_lib
- Alors l'adresse déjà utilisée lui est proposée

**CA 8.1 — Changement d'adresse**
- Étant donné que le connecteur Agenda de Camille est « Connecté »
- Quand elle remplace l'adresse par une autre et touche « Connecter »
- Alors le panneau des permissions s'ouvre pour le nouveau compte

**CA 9.1 — Déconnexion d'un connecteur**
- Étant donné que le connecteur Agenda de Camille est « Connecté »
- Quand elle touche « Déconnecter » et confirme
- Alors le statut devient « Non configuré »
- Et Admin_lib indique qu'il ne peut plus créer de rendez-vous

**CA 10.1 — Conservation après retrait**
- Étant donné que Camille a retiré Admin_lib de son dashboard après l'avoir configuré
- Quand elle rajoute Admin_lib
- Alors son connecteur Agenda est toujours « Connecté »

**CA 11.1 — Chargement**
- Étant donné que Camille a touché « Connecter »
- Quand l'enregistrement est en cours
- Alors un indicateur de chargement s'affiche sur le bouton

**CA 12.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand Camille touche « Connecter »
- Alors le message d'erreur standard s'affiche
- Et l'adresse saisie est conservée

**CA 13.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand l'enregistrement dépasse 15 secondes
- Alors le message de connexion lente s'affiche
- Et l'adresse saisie est conservée

---

## US-14 — Autoriser les permissions nécessaires à un agent

**En tant qu'** utilisateur principal ou invité,
**je souhaite** accorder, via un panneau dédié, les permissions nécessaires à un agent sur mon Google Drive ou mon Google Agenda,
**afin qu'** il obtienne l'accès requis à ces connecteurs pour fonctionner correctement.

**Écran(s) maquette :** Connecteurs / Connecteurs invité (panneau « demande l'accès à votre Google Drive/Agenda »). **Dépendances :** US-13.

### Règles fonctionnelles

RF1 — Le panneau ne s'ouvre que si l'agent n'a pas encore les permissions nécessaires sur le compte saisi.

RF2 — Le panneau affiche le nom de l'agent, le service concerné (Drive ou Agenda), le compte Google visé et la liste des permissions demandées en langage courant (par exemple « Consulter et créer des événements dans votre agenda »).

RF3 — Le bouton « Autoriser » ouvre la page de consentement Google. Une fois le consentement donné, l'utilisateur revient dans MAAQ et le connecteur passe au statut « Connecté ».

RF4 — Si l'utilisateur refuse sur la page Google ou ferme le panneau, le connecteur passe au statut « Autorisation refusée ». Le message « Sans cette autorisation, [agent] ne pourra pas [action]. » s'affiche avec un bouton « Réessayer ».

RF5 — Si l'utilisateur n'accorde qu'une partie des permissions, le connecteur reste incomplet et un message liste les permissions manquantes.

RF6 — Si le compte choisi sur la page Google diffère de l'adresse saisie, l'adresse enregistrée est remplacée par le compte réellement autorisé, et un message en informe l'utilisateur.

RF7 — Si l'autorisation est retirée plus tard depuis le compte Google, le connecteur passe au statut « À reconnecter ». Le message s'affiche à la prochaine demande dans le tchat de l'agent.

RF8 — Pendant le retour de la page Google vers MAAQ, un indicateur de chargement s'affiche avec le message « Finalisation de la connexion… » (CC-1).

RF9 — En cas d'erreur serveur au retour, le message d'erreur standard s'affiche et le connecteur reste au statut « Autorisation en attente » (CC-2).

RF10 — En cas de délai dépassé, le message de connexion lente s'affiche avec un bouton « Réessayer » (CC-3).

RF11 — Si le profil quitte la page Google, ou si la connexion est perdue avant le retour dans MAAQ, le connecteur reste au statut « Autorisation en attente ». Un bouton « Reprendre la connexion » relance le parcours sans ressaisir l'adresse.

### Règles techniques

RT1 — [backend] Le parcours d'autorisation Google est opéré par Digitorn. MAAQ reçoit uniquement le résultat : autorisé, refusé ou partiel.

RT2 — [frontend] Sur iPhone, le retour depuis la page Google doit ramener dans l'application installée et non dans le navigateur. Ce point est à tester spécifiquement.

RT3 — [backend] Seules les permissions strictement nécessaires à chaque agent sont demandées [À CONFIRMER avec Digitorn].

### UX / Design

D'après la maquette : un panneau qui glisse depuis le bas de l'écran, avec le logo du service Google, la liste des permissions et les boutons « Autoriser » et « Annuler ».

**Impact maquette :** Ajustement — États « Autorisation refusée », « Autorisation partielle », « À reconnecter » ; Écran « Finalisation de la connexion… » ; Bouton « Reprendre la connexion ».

### Critères d'acceptance

**CA 1.1 — Panneau non affiché si déjà autorisé**
- Étant donné que le compte Google de Camille a déjà autorisé Admin_lib
- Quand elle touche « Connecter » avec la même adresse
- Alors le connecteur passe directement au statut « Connecté » sans panneau

**CA 2.1 — Contenu du panneau**
- Étant donné que Thomas touche « Connecter » pour l'Agenda d'Admin_lib
- Quand le panneau s'ouvre
- Alors il voit le nom Admin_lib, le service Google Agenda, son adresse et la liste des permissions en langage courant

**CA 3.1 — Autorisation accordée**
- Étant donné que le panneau est ouvert
- Quand Thomas touche « Autoriser » et accepte sur la page Google
- Alors il revient dans MAAQ et le connecteur est « Connecté »

**CA 4.1 — Autorisation refusée**
- Étant donné que la page Google est affichée
- Quand Thomas refuse
- Alors le connecteur est au statut « Autorisation refusée »
- Et le message « Sans cette autorisation, Admin_lib ne pourra pas créer de rendez-vous. » s'affiche avec un bouton « Réessayer »

**CA 5.1 — Autorisation partielle**
- Étant donné que la page Google propose deux permissions
- Quand Thomas n'en accepte qu'une
- Alors un message liste la permission manquante et le connecteur n'est pas « Connecté »

**CA 6.1 — Compte différent**
- Étant donné que Thomas a saisi thomas.pro@gmail.com
- Quand il choisit thomas.perso@gmail.com sur la page Google et accepte
- Alors l'adresse enregistrée devient thomas.perso@gmail.com
- Et un message l'en informe

**CA 7.1 — Autorisation retirée depuis Google**
- Étant donné que Camille a retiré l'accès d'Admin_lib depuis son compte Google
- Quand elle fait une demande à Admin_lib
- Alors un message lui indique que son agenda doit être reconnecté, avec un lien vers l'écran Connecteurs

**CA 8.1 — Chargement au retour**
- Étant donné que Thomas vient d'accepter sur la page Google
- Quand il revient dans MAAQ
- Alors le message « Finalisation de la connexion… » s'affiche avec un indicateur de chargement

**CA 9.1 — Erreur serveur au retour**
- Étant donné que le serveur est indisponible au retour de la page Google
- Quand MAAQ tente de finaliser la connexion
- Alors le message d'erreur standard s'affiche et le connecteur reste « Autorisation en attente »

**CA 10.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand la finalisation dépasse 15 secondes
- Alors le message de connexion lente s'affiche avec un bouton « Réessayer »

**CA 11.1 — Parcours Google interrompu**
- Étant donné que j'ai quitté la page Google sans répondre
- Quand je reviens sur l'écran Connecteurs
- Alors le connecteur est « Autorisation en attente » avec un bouton « Reprendre la connexion »

---

## US-15 — Configurer la boîte mail de validation d'un agent

**En tant qu'** utilisateur principal ou invité,
**je souhaite** renseigner une adresse email dédiée à la validation, distincte de celle utilisée pour les connecteurs Drive/Agenda,
**afin que** certains agents m'y transmettent un brouillon de mail pour relecture avant l'envoi réel au destinataire.

**Écran(s) maquette :** Connecteurs / Connecteurs invité (section « Boîte mail de validation »). **Dépendances :** US-13, US-39, US-29.

### Règles fonctionnelles

RF1 — La section « Boîte mail de validation » n'apparaît que dans l'onglet des agents qui envoient des emails au nom du profil. La liste de ces agents est définie à leur mise à disposition (US-45).

RF2 — Chaque profil renseigne sa propre boîte de validation, agent par agent.

RF3 — L'adresse doit être au format email valide. Elle peut être identique à celle d'un connecteur : « distincte » est une précision, pas une obligation (décision du 30/09/2026).

RF4 — Avant d'être active, l'adresse est vérifiée par un code envoyé à cette boîte et saisi dans MAAQ.

RF5 — Lorsque l'agent doit envoyer un email au nom du profil, il envoie d'abord un brouillon à la boîte de validation, pour relecture. La validation se fait dans le tchat de l'agent, par une carte de validation (US-39). L'envoi réel n'a lieu qu'après cette validation (décision du 30/09/2026).

RF6 — Tant que la boîte de validation n'est pas configurée, les actions d'envoi d'email de l'agent sont indisponibles, et l'agent est signalé « À configurer » (US-29).

RF7 — L'adresse peut être modifiée, ce qui relance la vérification, ou supprimée après confirmation.

RF8 — Pendant l'enregistrement et la vérification, un indicateur de chargement s'affiche (CC-1).

RF9 — En cas d'erreur serveur, le message d'erreur standard s'affiche et l'adresse saisie est conservée (CC-2).

RF10 — En cas de délai dépassé, le message de connexion lente s'affiche et l'adresse saisie est conservée (CC-3).

### Règles techniques

RT1 — [backend] L'adresse de validation est transmise à Digitorn avec les éléments de configuration de l'agent, au moment de sa configuration, et non à chaque demande (décision du 30/09/2026).

RT2 — [backend] Un brouillon non validé n'est jamais envoyé au destinataire final, quel que soit le délai écoulé.

### UX / Design

D'après la maquette : une carte « Boîte mail de validation » sous les connecteurs Google, avec un champ adresse, un statut (« Non configurée », « À vérifier », « Active ») et une phrase d'explication de son rôle.

**Impact maquette :** Ajustement — Mention indiquant que la validation se fait dans le tchat ; Vérification de l'adresse par code ; Statuts « Non configurée », « À vérifier », « Active ».

### Critères d'acceptance

**CA 1.1 — Section réservée aux agents qui envoient des emails**
- Étant donné qu'Admin_Classify n'envoie pas d'email
- Quand Camille ouvre l'onglet Admin_Classify de ses connecteurs
- Alors la section « Boîte mail de validation » n'est pas affichée

**CA 2.1 — Boîte propre à chaque profil**
- Étant donné que Camille a configuré sa boîte de validation pour un agent
- Quand Thomas ouvre l'onglet de ce même agent
- Alors sa boîte de validation est « Non configurée »

**CA 3.1 — Format invalide**
- Étant donné que Thomas saisit une adresse sans arobase
- Quand il quitte le champ
- Alors le message « Adresse email invalide » s'affiche

**CA 4.1 — Vérification de l'adresse**
- Étant donné que Thomas a saisi une adresse valide
- Quand il saisit le code reçu dans cette boîte
- Alors la boîte de validation passe au statut « Active »

**CA 5.1 — Brouillon avant envoi**
- Étant donné que la boîte de validation de Camille est active
- Quand elle demande à l'agent d'envoyer un email à son assureur
- Alors un brouillon arrive dans sa boîte de validation
- Et une carte de validation s'affiche dans le tchat de l'agent
- Et l'email n'est pas envoyé à l'assureur tant qu'elle ne l'a pas validé dans le tchat

**CA 6.1 — Boîte non configurée**
- Étant donné que la boîte de validation de Thomas n'est pas configurée
- Quand il demande à l'agent d'envoyer un email
- Alors l'agent lui indique que la boîte de validation doit être configurée, avec un lien vers l'écran Connecteurs

**CA 7.1 — Suppression**
- Étant donné que la boîte de validation de Camille est active
- Quand elle la supprime et confirme
- Alors son statut devient « Non configurée »

**CA 8.1 — Chargement**
- Étant donné que Thomas a validé son code
- Quand la vérification est en cours
- Alors un indicateur de chargement s'affiche

**CA 9.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand Thomas enregistre son adresse
- Alors le message d'erreur standard s'affiche et l'adresse reste saisie

**CA 10.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand l'enregistrement dépasse 15 secondes
- Alors le message de connexion lente s'affiche et l'adresse reste saisie

---

## US-16 — Définir les adresses en copie systématique d'un agent

**En tant qu'** utilisateur principal,
**je souhaite** ajouter, dans la configuration d'un agent (ex. Admin_lib), des adresses email à mettre systématiquement en copie des événements Google Agenda créés,
**afin que** les personnes concernées soient toujours informées des événements.

**Écran(s) maquette :** Connecteurs (section « Adresses en copie systématique », onglet Admin_lib). **Dépendances :** US-13, US-17, US-18, US-38. **Décisions appliquées :** D1, D2.

### Règles fonctionnelles

RF1 — La section « Adresses en copie systématique » apparaît dans l'onglet des agents pour lesquels l'administrateur a prévu des adresses en copie lors de la publication (US-45), par exemple Admin_lib (décision D16 du 01/10/2026).

RF2 — La section affiche d'abord, en lecture seule, le participant automatique de l'utilisateur principal : l'invité 1, avec la mention « Ajouté automatiquement à vos rendez-vous » (décision D2).

RF3 — L'utilisateur principal peut ajouter des adresses à la liste. Chaque adresse doit être au format email valide et ne pas figurer déjà dans la liste. Elle ne peut être ni son propre email, ni celui de l'invité 1, qui est déjà participant automatique.

RF4 — La liste est limitée au nombre d'adresses fixé par l'administrateur pour cet agent lors de la publication (10 recommandé) (décision D16 du 01/10/2026).

RF5 — Les adresses de la liste sont ajoutées comme participants uniquement aux événements demandés par l'utilisateur principal. Elles ne s'appliquent pas aux événements demandés par ses invités (décision du 30/09/2026).

RF6 — Les invités secondaires ne sont pas des participants automatiques des événements demandés par l'utilisateur principal. Ils ne sont ajoutés que si l'utilisateur principal le précise dans sa demande, ou valide la proposition de l'agent (décision D2, US-39).

RF7 — Une même personne n'apparaît qu'une seule fois parmi les participants d'un événement, même si elle est concernée à la fois par une règle automatique et par une liste.

RF8 — L'utilisateur principal peut modifier ou supprimer une adresse à tout moment. La modification s'applique aux événements créés ensuite, jamais aux événements déjà créés.

RF9 — Les invités ne voient pas cette liste, qui ne s'applique pas à leurs rendez-vous (décision du 30/09/2026).

RF10 — La liste et les règles de participants automatiques sont transmises à l'agent comme contexte de chaque demande.

RF11 — Pendant l'enregistrement d'une adresse, un indicateur de chargement s'affiche (CC-1).

RF12 — En cas d'erreur serveur, le message d'erreur standard s'affiche et l'adresse saisie est conservée (CC-2).

RF13 — En cas de délai dépassé, le message de connexion lente s'affiche et l'adresse saisie est conservée (CC-3).

### Règles techniques

RT1 — [backend] L'adresse utilisée pour un participant automatique est l'email de connexion du profil.

RT2 — [backend] Les adresses en copie et les règles de participants sont transmises à Digitorn sous forme chiffrée, et mises à jour à chaque session (décision du 29/09/2026).

RT3 — [backend] L'application des participants automatiques est garantie par les règles de l'agent chez Digitorn, à partir du rang du demandeur transmis en contexte (utilisateur principal, invité 1 ou invité secondaire).

### UX / Design

D'après la maquette : une liste d'adresses avec un bouton de suppression sur chaque ligne, et un champ « Ajouter une adresse » en bas. La ligne du participant automatique, avec un style grisé et sans bouton de suppression, est un ajout à la maquette.

**Impact maquette :** Ajustement — Section affichée seulement si l'administrateur l'a prévue pour l'agent ; message de limite avec le nombre propre à l'agent ; Ligne « Participant automatique » en lecture seule (invité 1) ; Message de limite de 10 adresses.

### Critères d'acceptance

**CA 1.1 — Section dans Admin_lib**
- Étant donné que Camille ouvre l'onglet Admin_lib de ses connecteurs
- Quand elle fait défiler l'écran
- Alors la section « Adresses en copie systématique » est affichée

**CA 1.2 — Section absente pour un agent sans adresses en copie**
- Étant donné que l'administrateur a fixé à 0 le nombre d'adresses en copie d'Admin_Classify
- Quand Camille ouvre l'onglet Admin_Classify de ses connecteurs
- Alors la section « Adresses en copie systématique » n'est pas affichée

**CA 2.1 — Participant automatique affiché**
- Étant donné que Thomas est l'invité 1 de Camille
- Quand Camille consulte la section
- Alors Thomas est affiché en lecture seule avec la mention « Ajouté automatiquement à vos rendez-vous »

**CA 3.1 — Ajout d'une adresse**
- Étant donné que la liste de Camille est vide
- Quand elle ajoute l'adresse de sa comptable
- Alors l'adresse apparaît dans la liste

**CA 3.2 — Adresse en double**
- Étant donné que l'adresse de sa comptable est déjà dans la liste
- Quand Camille l'ajoute de nouveau
- Alors le message « Cette adresse est déjà en copie » s'affiche

**CA 3.3 — Adresse de l'invité 1 refusée**
- Étant donné que Thomas est l'invité 1
- Quand Camille ajoute l'adresse de Thomas à la liste
- Alors un message indique que Thomas est déjà ajouté automatiquement

**CA 4.1 — Limite de 10 adresses**
- Étant donné que l'administrateur a fixé à 10 le nombre d'adresses en copie d'Admin_lib et que la liste en contient 10
- Quand Camille tente d'en ajouter une onzième
- Alors un message indique que la limite de 10 adresses est atteinte

**CA 5.1 — Pas d'application aux rendez-vous d'un invité**
- Étant donné que l'adresse de la comptable est dans la liste de Camille
- Quand Thomas demande à Admin_lib de créer un rendez-vous
- Alors la comptable ne figure pas parmi les participants du rendez-vous

**CA 5.2 — Application aux rendez-vous de l'utilisateur principal**
- Étant donné que l'adresse de la comptable est dans la liste de Camille
- Quand Camille demande à Admin_lib de créer un rendez-vous
- Alors la comptable figure parmi les participants du rendez-vous

**CA 6.1 — Invité secondaire non ajouté par défaut**
- Étant donné qu'Élodie est invitée secondaire de Camille
- Quand Camille demande à Admin_lib un rendez-vous sans mentionner Élodie
- Alors Élodie ne figure pas parmi les participants

**CA 6.2 — Invité secondaire mentionné**
- Étant donné qu'Élodie est invitée secondaire de Camille
- Quand Camille demande « Crée un RDV avec le notaire jeudi à 10 h et ajoute Élodie »
- Alors Élodie figure parmi les participants

**CA 7.1 — Pas de doublon de participant**
- Étant donné que l'adresse de Camille figure dans la liste de Thomas
- Quand Thomas demande à Admin_lib un rendez-vous
- Alors Camille n'apparaît qu'une seule fois parmi les participants

**CA 8.1 — Suppression non rétroactive**
- Étant donné qu'un rendez-vous a été créé avec la comptable en copie
- Quand Camille supprime l'adresse de la comptable de la liste
- Alors le rendez-vous existant n'est pas modifié
- Et les rendez-vous suivants ne l'incluent plus

**CA 9.1 — Liste invisible pour l'invité**
- Étant donné que Camille a des adresses dans sa liste
- Quand Thomas ouvre l'onglet Admin_lib de ses connecteurs
- Alors il ne voit pas ces adresses

**CA 10.1 — Transmission à l'agent**
- Étant donné que Camille vient d'ajouter une adresse
- Quand elle fait une nouvelle demande de rendez-vous
- Alors l'agent inclut cette adresse parmi les participants

**CA 11.1 — Chargement**
- Étant donné que Camille ajoute une adresse
- Quand l'enregistrement est en cours
- Alors un indicateur de chargement s'affiche

**CA 12.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand Camille ajoute une adresse
- Alors le message d'erreur standard s'affiche et l'adresse reste saisie

**CA 13.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand l'enregistrement dépasse 15 secondes
- Alors le message de connexion lente s'affiche et l'adresse reste saisie

---

## US-17 — Ajouter mes propres adresses en copie d'un agent

**En tant qu'** invité,
**je souhaite** consulter mes participants automatiques et ajouter mes propres adresses en copie si nécessaire (formulation ajustée après la décision du 30/09/2026),
**afin que** les personnes concernées par les événements que je demande soient aussi informées.

**Écran(s) maquette :** Connecteurs invité (sections « Adresses en copie de Camille » et « Mes adresses en copie », onglet Admin_lib). **Dépendances :** US-16, US-13. **Décisions appliquées :** D1, D2.

### Règles fonctionnelles

RF1 — L'écran Connecteurs de l'invité n'affiche pas la liste d'adresses en copie de l'utilisateur principal, qui ne s'applique qu'aux rendez-vous de celui-ci (décision du 30/09/2026).

RF2 — La section « Participants automatiques » affiche, en lecture seule, les personnes ajoutées d'office aux rendez-vous de l'invité selon son rang (décision D2) :
- pour l'invité 1 : l'utilisateur principal ;
- pour un invité secondaire : l'utilisateur principal et l'invité 1.

RF3 — La section « Mes adresses en copie » est modifiable. Les règles de format, de doublon et de limite sont celles de US-16.

RF4 — Une adresse déjà présente parmi les participants automatiques est refusée, avec le message « Cette personne est déjà en copie ». Une adresse de la liste de l'utilisateur principal peut être ajoutée, puisque cette liste ne s'applique pas aux événements de l'invité.

RF5 — Les adresses ajoutées par l'invité s'appliquent uniquement aux événements qu'il demande.

RF6 — L'invité peut modifier ou supprimer ses propres adresses à tout moment, sans effet sur les événements déjà créés.

RF7 — L'utilisateur principal ne voit pas les adresses en copie ajoutées par ses invités.

RF8 — Les adresses ajoutées par l'invité sont supprimées avec son compte (US-56) et incluses dans l'export de ses données (US-55).

RF9 — Pendant l'enregistrement, un indicateur de chargement s'affiche (CC-1).

RF10 — En cas d'erreur serveur, le message d'erreur standard s'affiche et l'adresse saisie est conservée (CC-2).

RF11 — En cas de délai dépassé, le message de connexion lente s'affiche et l'adresse saisie est conservée (CC-3).

### Règles techniques

RT1 — [backend] Les adresses de l'invité sont stockées séparément de celles de l'utilisateur principal et rattachées au profil de l'invité.

RT2 — [backend] Mêmes règles de transmission chiffrée à Digitorn que pour US-16.

### UX / Design

D'après la maquette : la section « Mes adresses en copie » a le même aspect que celle de l'utilisateur principal. La section « Adresses en copie de Camille » de la maquette est à supprimer. La section « Participants automatiques » est un ajout à la maquette.

**Impact maquette :** Ajustement — Nouvelle section « Participants automatiques » selon le rang de l'invité ; Suppression de la section « Adresses en copie de Camille ».

### Critères d'acceptance

**CA 1.1 — Liste de l'utilisateur principal non affichée**
- Étant donné que Camille a ajouté l'adresse de sa comptable
- Quand Thomas ouvre l'onglet Admin_lib de ses connecteurs
- Alors l'adresse de la comptable n'apparaît pas

**CA 2.1 — Participants automatiques de l'invité 1**
- Étant donné que Thomas est l'invité 1
- Quand il consulte la section « Participants automatiques »
- Alors il voit Camille

**CA 2.2 — Participants automatiques d'un invité secondaire**
- Étant donné qu'Élodie est invitée secondaire
- Quand elle consulte la section « Participants automatiques »
- Alors elle voit Camille et Thomas

**CA 3.1 — Ajout d'une adresse**
- Étant donné que Thomas a une liste vide
- Quand il ajoute l'adresse de son expert-comptable
- Alors l'adresse apparaît dans « Mes adresses en copie »

**CA 4.1 — Participant automatique refusé**
- Étant donné que Camille est participante automatique des rendez-vous de Thomas
- Quand Thomas ajoute l'adresse de Camille à sa liste
- Alors le message « Cette personne est déjà en copie » s'affiche

**CA 4.2 — Adresse de la liste de l'utilisateur principal acceptée**
- Étant donné que l'adresse de la comptable figure dans la liste de Camille
- Quand Thomas l'ajoute à sa liste
- Alors l'adresse apparaît dans « Mes adresses en copie »

**CA 5.1 — Application limitée aux demandes de l'invité**
- Étant donné que l'expert-comptable figure dans la liste de Thomas
- Quand Camille demande un rendez-vous à Admin_lib
- Alors l'expert-comptable ne figure pas parmi les participants

**CA 5.2 — Application aux demandes de l'invité**
- Étant donné que l'expert-comptable figure dans la liste de Thomas
- Quand Thomas demande un rendez-vous à Admin_lib
- Alors l'expert-comptable et Camille figurent parmi les participants
- Et la comptable de Camille n'y figure pas

**CA 6.1 — Suppression d'une adresse**
- Étant donné que Thomas a une adresse dans sa liste
- Quand il la supprime
- Alors elle disparaît de sa liste et ses rendez-vous suivants ne l'incluent plus

**CA 7.1 — Invisibles pour l'utilisateur principal**
- Étant donné que Thomas a ajouté l'adresse de son expert-comptable
- Quand Camille ouvre l'onglet Admin_lib de ses connecteurs
- Alors elle ne voit pas l'adresse de l'expert-comptable

**CA 8.1 — Suppression avec le compte**
- Étant donné que Thomas a ajouté des adresses en copie
- Quand la suppression de son compte devient définitive
- Alors ses adresses en copie sont supprimées

**CA 9.1 — Chargement**
- Étant donné que Thomas ajoute une adresse
- Quand l'enregistrement est en cours
- Alors un indicateur de chargement s'affiche

**CA 10.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand Thomas ajoute une adresse
- Alors le message d'erreur standard s'affiche et l'adresse reste saisie

**CA 11.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand l'enregistrement dépasse 15 secondes
- Alors le message de connexion lente s'affiche et l'adresse reste saisie

---

## US-67 — Connecter le Google Drive du compte


*US créée suite à la décision D14.*

**En tant qu'** utilisateur principal,
**je souhaite** connecter une seule fois le Google Drive de mon compte,
**afin que** les agents qui en ont besoin (par exemple Admin_Classify pour les contrats) puissent y classer et lire les documents, sans que chaque profil ait à le configurer.

**Écran(s) maquette :** Contrats (bandeau « Google Drive non connecté ») ; Connecteurs (onglet d'un agent qui utilise le Drive du compte). **Dépendances :** US-13, US-14, US-29, US-32, US-34, US-45.

### Règles fonctionnelles

RF1 — Le Google Drive du compte est une connexion unique par compte, rattachée à l'utilisateur principal. Elle est indépendante des agents : elle n'est pas configurée agent par agent.

RF2 — Les agents qui utilisent cette connexion sont ceux pour lesquels l'administrateur a indiqué, à la publication (US-45), que le connecteur Drive est une « connexion du compte ». Les agents de la rubrique Contrats l'utilisent. Un autre agent peut l'utiliser aussi.

RF3 — Seul l'utilisateur principal peut connecter, reconnecter ou déconnecter le Drive du compte. Les invités ne peuvent ni le connecter ni le déconnecter.

RF4 — L'utilisateur principal accède à la connexion depuis : le bouton « Connecter mon Google Drive » du bandeau de l'onglet « Mes contrats » (US-32 RF11) ; l'onglet Connecteurs de n'importe quel agent qui utilise le Drive du compte ; le message « À configurer » d'un tel agent (US-29).

RF5 — La connexion se fait de deux façons possibles : depuis l'agent dans MAAQ, avec le même parcours que US-13 et US-14 (saisie de l'adresse du compte Google, panneau des permissions, page de consentement Google) ; ou directement par un widget Digitorn. Dans les deux cas, MAAQ reçoit le résultat (autorisé, refusé ou partiel) et affiche le même statut [À CONFIRMER avec Digitorn : mode de remontée du résultat du widget vers MAAQ].

RF6 — Le statut de la connexion est : « Non configuré », « Autorisation en attente », « Connecté », « Autorisation refusée » ou « À reconnecter ».

RF7 — Tant que le Drive du compte n'est pas connecté, les agents qui l'utilisent sont « À configurer » (US-29) et l'onglet « Mes contrats » affiche le bandeau de US-32 RF11.

RF8 — Un invité voit l'état du Drive du compte en lecture seule : par exemple « [Prénom de l'utilisateur principal] doit connecter son Google Drive ». Aucune action n'est possible pour l'invité. Un invité secondaire n'a pas accès aux contrats (US-30 RF3).

RF9 — Modifier l'adresse du compte Google demande une nouvelle autorisation ; l'autorisation de l'ancien compte est retirée (même règle que US-13 RF8).

RF10 — Le bouton « Déconnecter » retire la connexion après confirmation. Les agents qui l'utilisent redeviennent « À configurer ». Les documents déjà classés restent dans le Google Drive.

RF11 — Les autres connexions Google (Google Agenda, boîte de validation, Drive propre à un agent lorsque l'administrateur a indiqué « chaque profil ») restent configurées par chaque profil, agent par agent (US-13).

RF12 — Pendant l'enregistrement et le retour de la page Google, un indicateur de chargement s'affiche (CC-1). En cas d'erreur serveur, le message d'erreur standard s'affiche et l'adresse saisie est conservée (CC-2). En cas de délai dépassé, le message de connexion lente s'affiche (CC-3).

### Règles techniques

RT1 — [backend] La connexion passe par Digitorn. MAAQ ne stocke jamais les mots de passe Google.

RT2 — [backend] Il existe au plus une connexion par compte et par type de connecteur.

RT3 — [backend] Le statut « À reconnecter » est positionné lorsque Digitorn signale une autorisation expirée ou révoquée.

RT4 — [frontend] Sur iPhone, le retour depuis la page Google ramène dans l'application installée (même point de test que US-14 RT2).

### UX / Design

Réutiliser l'écran Connecteurs (US-13) pour la saisie et le panneau de permissions (US-14). L'onglet d'un agent qui utilise le Drive du compte affiche une ligne « Google Drive du compte » plutôt qu'un champ propre à l'agent.

**Impact maquette :** Ajustement — Ligne « Google Drive du compte » dans l'écran Connecteurs, partagée entre agents, avec ses statuts ; Bandeau de la page Contrats ouvrant ce parcours.

### Critères d'acceptance

**CA 1.1 — Une seule connexion pour le compte**
- Étant donné que Camille a connecté le Google Drive du compte depuis Admin_Classify
- Quand elle ouvre l'onglet Connecteurs d'un autre agent qui utilise le Drive du compte
- Alors le Drive est déjà affiché « Connecté » sans nouvelle saisie

**CA 2.1 — Agent utilisant le Drive du compte**
- Étant donné que l'administrateur a indiqué que le Drive d'Admin_Classify est une connexion du compte
- Quand Camille ouvre l'onglet Connecteurs d'Admin_Classify
- Alors elle voit la ligne « Google Drive du compte » et non un champ propre à l'agent

**CA 3.1 — Réservé à l'utilisateur principal**
- Étant donné que Thomas est l'invité 1 de Camille
- Quand il ouvre l'onglet « Mes contrats » alors que le Drive n'est pas connecté
- Alors il voit « Camille doit connecter son Google Drive pour classer les documents » et aucun bouton de connexion

**CA 4.1 — Depuis le bandeau des contrats**
- Étant donné que Camille n'a pas connecté le Drive du compte
- Quand elle touche « Connecter mon Google Drive »
- Alors le parcours de connexion s'ouvre

**CA 5.1 — Connexion depuis l'agent**
- Étant donné que Camille saisit l'adresse du compte Google et touche « Connecter »
- Quand elle accepte les permissions sur la page de consentement Google
- Alors le Drive du compte passe à « Connecté »

**CA 5.2 — Connexion par le widget Digitorn**
- Étant donné que Camille connecte le Drive directement par le widget Digitorn
- Quand l'autorisation est accordée
- Alors le Drive du compte est affiché « Connecté » dans MAAQ

**CA 6.1 — Statuts de la connexion**
- Étant donné que Camille a refusé les permissions sur la page Google
- Quand elle revient dans MAAQ
- Alors le Drive du compte affiche le statut « Autorisation refusée »

**CA 7.1 — Agents à configurer**
- Étant donné que le Drive du compte n'est pas connecté
- Quand Camille ouvre Admin_Classify
- Alors l'agent est « À configurer » et la zone de saisie est remplacée par l'écran informatif

**CA 8.1 — Invité secondaire**
- Étant donné qu'Élodie est invitée secondaire de Camille
- Quand elle navigue dans MAAQ
- Alors elle ne voit ni la page Contrats ni la connexion du Drive du compte

**CA 9.1 — Changement d'adresse**
- Étant donné que le Drive du compte est connecté
- Quand Camille modifie l'adresse du compte Google
- Alors une nouvelle autorisation est demandée et l'ancienne est retirée

**CA 10.1 — Déconnexion**
- Étant donné que le Drive du compte est connecté
- Quand Camille le déconnecte après confirmation
- Alors les agents qui l'utilisent redeviennent « À configurer »
- Et les documents déjà classés restent dans le Google Drive

**CA 11.1 — Agenda toujours par profil**
- Étant donné que Camille a connecté le Drive du compte
- Quand Thomas ouvre l'onglet Connecteurs d'Admin_lib
- Alors il doit toujours connecter son propre Google Agenda

**CA 12.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand Camille touche « Connecter »
- Alors le message d'erreur standard s'affiche et l'adresse saisie est conservée

**CA 12.2 — Chargement**
- Étant donné que Camille touche « Connecter »
- Quand l'enregistrement est en cours
- Alors un indicateur de chargement s'affiche

**CA 12.3 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand l'enregistrement dépasse 15 secondes
- Alors le message de connexion lente s'affiche

---

# Module C — Gestion des invités (Utilisateur)

## US-18 — Ajouter un invité

**En tant qu'** utilisateur principal,
**je souhaite** ajouter un invité en renseignant son nom, son email et son numéro de téléphone,
**afin qu'** il puisse accéder aux agents IA mis à disposition.

**Écran(s) maquette :** Gestion des invités (bouton « Ajouter un invité »). **Dépendances :** US-4, US-21. **Décisions appliquées :** D1.

### Règles fonctionnelles

RF1 — L'écran de gestion des invités, accessible depuis les Réglages de l'utilisateur principal uniquement, affiche un bouton « Ajouter un invité » tant que le quota du plan n'est pas atteint (US-21).

RF2 — Le formulaire d'ajout demande le prénom, le nom, l'email et le téléphone mobile. Prénom, nom et email sont obligatoires. Le téléphone est facultatif : sans lui, l'invitation n'est envoyée que par email.

RF3 — L'email de l'invité doit être au format valide. Il doit être différent de celui de l'utilisateur principal, et ne pas être déjà associé à un compte MAAQ. Sinon, le message « Cette adresse est déjà associée à un compte MAAQ » s'affiche, car un invité ne peut être rattaché qu'à un seul utilisateur principal.

RF4 — À la validation, la fiche de l'invité est créée avec le statut « Invitation envoyée » et l'invitation est envoyée (US-4).

RF5 — Le premier invité ajouté devient l'invité 1 et forme le noyau du compte avec l'utilisateur principal. Les invités suivants sont des invités secondaires (décision D1). Si l'invité 1 a été supprimé, l'utilisateur principal désigne lui-même le nouvel invité 1 (US-20).

RF6 — Le rang de l'invité (« Invité 1 » ou « Invité secondaire ») est affiché sur sa fiche.

RF7 — Si l'envoi de l'email ou du SMS échoue, la fiche est tout de même créée avec le statut « Échec d'envoi », et le bouton « Renvoyer un nouveau lien » (US-5) est proposé.

RF8 — L'invité n'a aucun accès à MAAQ tant qu'il n'a pas activé son compte (US-4).

RF9 — Pendant l'ajout, le bouton « Inviter » affiche un indicateur de chargement et est désactivé (CC-1).

RF10 — En cas d'erreur serveur, le message d'erreur standard s'affiche, les informations saisies sont conservées et aucune fiche n'est créée (CC-2).

RF11 — En cas de délai dépassé, le message de connexion lente s'affiche et les informations saisies sont conservées (CC-3).

RF12 — L'envoi de l'invitation par email et SMS est asynchrone (CC-10). La fiche est créée immédiatement avec le statut « Envoi en cours », qui passe à « Invitation envoyée » une fois l'envoi confirmé. En cas d'échec, l'envoi est réessayé automatiquement jusqu'à 3 fois avant de passer au statut « Échec d'envoi » (RF7).

RF13 — Un invité qui n'a jamais activé son accès est supprimé automatiquement 30 jours après le dernier lien envoyé (US-68). Sa place est libérée dans le quota (décision D19 du 01/10/2026).

### Règles techniques

RT1 — [backend] Le quota est vérifié côté serveur au moment de l'ajout, même si l'écran affichait une place disponible.

RT2 — [backend] Le rang de chaque invité est enregistré et transmis à Digitorn comme contexte, pour l'application des participants automatiques (décision D2).

### UX / Design

D'après la maquette : le bouton « Ajouter un invité » ouvre un formulaire en plein écran. L'affichage du rang de l'invité sur sa fiche est un ajout à la maquette.

**Impact maquette :** Ajustement — Rang de l'invité sur sa fiche (Invité 1 / Invité secondaire) ; Statuts « Envoi en cours » et « Échec d'envoi ».

### Critères d'acceptance

**CA 1.1 — Bouton disponible**
- Étant donné que Camille a une place d'invité disponible
- Quand elle ouvre l'écran de gestion des invités
- Alors le bouton « Ajouter un invité » est actif

**CA 2.1 — Champs obligatoires**
- Étant donné que le formulaire d'ajout est ouvert
- Quand Camille laisse l'email vide
- Alors le bouton « Inviter » reste inactif

**CA 2.2 — Téléphone facultatif**
- Étant donné que Camille renseigne le prénom, le nom et l'email de Thomas sans téléphone
- Quand elle touche « Inviter »
- Alors la fiche de Thomas est créée et l'invitation est envoyée par email uniquement

**CA 3.1 — Email déjà utilisé**
- Étant donné que l'adresse de Julien est déjà l'adresse d'un compte MAAQ
- Quand Camille tente d'ajouter Julien avec cette adresse
- Alors le message « Cette adresse est déjà associée à un compte MAAQ » s'affiche

**CA 3.2 — Email de l'utilisateur principal**
- Étant donné que le formulaire d'ajout est ouvert
- Quand Camille saisit son propre email
- Alors un message indique qu'elle ne peut pas s'inviter elle-même

**CA 4.1 — Ajout réussi**
- Étant donné que Camille a renseigné les informations de Thomas
- Quand elle touche « Inviter »
- Alors la fiche de Thomas apparaît avec le statut « Invitation envoyée »

**CA 5.1 — Premier invité**
- Étant donné que Camille n'a aucun invité
- Quand elle ajoute Thomas
- Alors Thomas devient l'invité 1

**CA 5.2 — Deuxième invité**
- Étant donné que Thomas est l'invité 1
- Quand Camille ajoute Élodie
- Alors Élodie est invitée secondaire

**CA 6.1 — Rang affiché**
- Étant donné que Camille a deux invités
- Quand elle ouvre l'écran de gestion des invités
- Alors la fiche de Thomas indique « Invité 1 » et celle d'Élodie « Invité secondaire »

**CA 7.1 — Échec d'envoi**
- Étant donné que l'envoi de l'email d'invitation échoue
- Quand Camille ajoute Thomas
- Alors la fiche de Thomas affiche le statut « Échec d'envoi » avec le bouton « Renvoyer un nouveau lien »

**CA 8.1 — Pas d'accès avant activation**
- Étant donné que Thomas n'a pas activé son accès
- Quand il tente de se connecter
- Alors il ne peut pas se connecter

**CA 9.1 — Chargement**
- Étant donné que Camille a touché « Inviter »
- Quand l'ajout est en cours
- Alors un indicateur de chargement s'affiche et le bouton est désactivé

**CA 10.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand Camille touche « Inviter »
- Alors le message d'erreur standard s'affiche
- Et aucune fiche n'est créée

**CA 11.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand l'ajout dépasse 15 secondes
- Alors le message de connexion lente s'affiche et les informations restent saisies

**CA 12.1 — Envoi asynchrone de l'invitation**
- Étant donné que Camille vient d'ajouter Thomas
- Quand l'envoi de l'invitation est en cours
- Alors la fiche de Thomas affiche « Envoi en cours », puis « Invitation envoyée » une fois l'envoi confirmé

**CA 12.2 — Nouvelles tentatives d'envoi**
- Étant donné que le service d'envoi de SMS est indisponible
- Quand 3 nouvelles tentatives automatiques ont échoué
- Alors la fiche de Thomas affiche « Échec d'envoi »

**CA 13.1 — Suppression d'un invité jamais activé**
- Étant donné qu'Élodie n'a jamais activé son accès
- Quand 30 jours se sont écoulés depuis le dernier lien envoyé
- Alors Élodie disparaît de l'écran de gestion des invités

---

## US-19 — Modifier les informations d'un invité

**En tant qu'** utilisateur principal,
**je souhaite** modifier les informations d'un invité (nom, email, numéro de téléphone),
**afin de** corriger ou mettre à jour ses coordonnées.

**Écran(s) maquette :** Gestion des invités (mode « Modifier » sur la fiche d'un invité). **Dépendances :** US-18, US-5.

### Règles fonctionnelles

RF1 — La fiche d'un invité propose un bouton « Modifier » qui fait passer la fiche en mode édition. On sort du mode édition par « Enregistrer » ou « Annuler ».

RF2 — Les champs modifiables sont le prénom, le nom, l'email et le téléphone. Les contrôles sont ceux de US-18.

RF3 — Pour un invité non activé, modifier l'email ou le téléphone invalide le lien en cours et propose immédiatement « Renvoyer un nouveau lien » aux nouvelles coordonnées.

RF4 — Pour un invité actif, modifier l'email modifie aussi son email de connexion. Un email d'information est envoyé à l'ancienne et à la nouvelle adresse.

RF5 — Ces coordonnées sont distinctes des informations utiles aux agents (US-11). Les deux ne sont pas synchronisées automatiquement.

RF6 — Annuler avec des modifications non enregistrées demande la confirmation « Abandonner vos modifications ? ».

RF7 — Pendant l'enregistrement, un indicateur de chargement s'affiche sur le bouton « Enregistrer » (CC-1).

RF8 — En cas d'erreur serveur, le message d'erreur standard s'affiche et la fiche reste en mode édition avec les modifications (CC-2).

RF9 — En cas de délai dépassé, le message de connexion lente s'affiche et la fiche reste en mode édition (CC-3).

### Règles techniques

RT1 — [backend] Un changement d'email de connexion est enregistré dans le journal des événements de sécurité.

### UX / Design

D'après la maquette : le mode « Modifier » transforme la fiche en formulaire. L'entrée et la sortie de ce mode sont définies par la RF1.

**Impact maquette :** aucun ajustement nécessaire.

### Critères d'acceptance

**CA 1.1 — Entrée en mode édition**
- Étant donné que la fiche de Thomas est affichée
- Quand Camille touche « Modifier »
- Alors les champs deviennent modifiables avec les boutons « Enregistrer » et « Annuler »

**CA 2.1 — Email invalide**
- Étant donné que la fiche de Thomas est en mode édition
- Quand Camille saisit un email invalide
- Alors le message « Adresse email invalide » s'affiche

**CA 3.1 — Invité non activé**
- Étant donné qu'Élodie n'a pas activé son accès
- Quand Camille corrige l'email d'Élodie et enregistre
- Alors l'ancien lien est invalidé
- Et le bouton « Renvoyer un nouveau lien » est proposé

**CA 4.1 — Invité actif**
- Étant donné que Thomas est actif
- Quand Camille modifie son email et enregistre
- Alors Thomas doit utiliser le nouvel email pour se connecter
- Et un email d'information est envoyé à l'ancienne et à la nouvelle adresse

**CA 5.1 — Informations pour les agents inchangées**
- Étant donné que Camille modifie le téléphone de Thomas sur sa fiche d'invité
- Quand elle consulte ensuite les informations de Thomas pour les agents
- Alors le téléphone y est inchangé

**CA 6.1 — Abandon des modifications**
- Étant donné que Camille a modifié le nom de Thomas sans enregistrer
- Quand elle touche « Annuler »
- Alors la confirmation « Abandonner vos modifications ? » s'affiche

**CA 7.1 — Chargement**
- Étant donné que Camille a touché « Enregistrer »
- Quand l'enregistrement est en cours
- Alors un indicateur de chargement s'affiche

**CA 8.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand Camille enregistre
- Alors le message d'erreur standard s'affiche et la fiche reste en mode édition

**CA 9.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand l'enregistrement dépasse 15 secondes
- Alors le message de connexion lente s'affiche et la fiche reste en mode édition

---

## US-20 — Supprimer un invité

**En tant qu'** utilisateur principal,
**je souhaite** supprimer un invité de mon compte,
**afin de** lui retirer l'accès aux agents IA mis à disposition.

**Écran(s) maquette :** Gestion des invités (mode « Supprimer » sur la fiche d'un invité, avec confirmation). **Dépendances :** US-18, US-21, US-57. **Décisions appliquées :** D1.

### Règles fonctionnelles

RF1 — La fiche d'un invité propose un bouton « Supprimer ». Il ouvre une confirmation qui liste les conséquences :
- l'accès de l'invité est retiré immédiatement ;
- ses adresses en copie sont supprimées ;
- ses demandes restent visibles dans le carnet de bord, sans son nom.

La confirmation propose « Supprimer » et « Annuler ».

RF2 — À la confirmation, l'invité perd immédiatement l'accès à MAAQ sur tous ses appareils, et sa place dans le quota est libérée (US-21).

RF3 — Un invité en cours d'utilisation est renvoyé à l'écran de connexion avec le message « Votre accès à MAAQ a été retiré ».

RF4 — L'invité supprimé est informé par email.

RF5 — Les demandes de l'invité supprimé restent dans le carnet de bord et sont anonymisées selon les règles de US-57.

RF6 — Si l'invité 1 est supprimé, aucun invité secondaire n'est promu automatiquement. Le noyau se réduit à l'utilisateur principal jusqu'à ce qu'il désigne lui-même un nouvel invité 1 (RF11) (décision du 30/09/2026).

RF7 — Pour un invité non activé, la suppression invalide son lien d'invitation.

RF8 — Pendant la suppression, un indicateur de chargement s'affiche sur le bouton de confirmation (CC-1).

RF9 — En cas d'erreur serveur, le message d'erreur standard s'affiche et l'invité n'est pas supprimé (CC-2).

RF10 — En cas de délai dépassé, le message de connexion lente s'affiche et l'invité n'est pas supprimé (CC-3).

RF11 — Tant que le compte n'a pas d'invité 1, la fiche de chaque invité propose le bouton « Désigner comme invité 1 », après confirmation. Le formulaire d'ajout d'un invité (US-18) propose aussi la case « Désigner comme invité 1 ». L'invité désigné rejoint le noyau : participants automatiques (D2), carnet complet (D3) et accès aux contrats (D7) (décision du 30/09/2026).

### Règles techniques

RT1 — [backend] La suppression ferme toutes les sessions de l'invité côté serveur.

RT2 — [backend] Le profil de l'invité et ses données sont supprimés, chez MAAQ et chez Digitorn (par l'interface de suppression dédiée), X jours après sa suppression. X est paramétré par l'administrateur dans la console d'administration (US-65) (décision du 30/09/2026).

### UX / Design

D'après la maquette : le bouton « Supprimer » est de couleur rouge, et la confirmation s'affiche dans une fenêtre superposée. Le mode « Supprimer » de la maquette correspond à cette confirmation (RF1).

**Impact maquette :** Ajustement — Bouton « Désigner comme invité 1 » sur la fiche d'un invité quand le compte n'a pas d'invité 1 ; Case « Désigner comme invité 1 » dans le formulaire d'ajout ; Liste des conséquences dans la confirmation de suppression.

### Critères d'acceptance

**CA 1.1 — Confirmation**
- Étant donné que la fiche de Julien est affichée
- Quand Camille touche « Supprimer »
- Alors une confirmation liste les conséquences de la suppression

**CA 1.2 — Annulation**
- Étant donné que la confirmation est affichée
- Quand Camille touche « Annuler »
- Alors Julien reste dans la liste des invités

**CA 2.1 — Suppression effective**
- Étant donné que la confirmation est affichée
- Quand Camille touche « Supprimer »
- Alors Julien disparaît de la liste
- Et le compteur de places disponibles augmente de 1

**CA 3.1 — Invité en cours d'utilisation**
- Étant donné que Julien utilise MAAQ
- Quand Camille le supprime
- Alors Julien est renvoyé à l'écran de connexion avec le message « Votre accès à MAAQ a été retiré »

**CA 4.1 — Email d'information**
- Étant donné que Camille a supprimé Julien
- Quand Julien consulte sa boîte mail
- Alors il a reçu un email l'informant de la fin de son accès

**CA 5.1 — Carnet anonymisé**
- Étant donné que Julien avait fait des demandes à Admin_lib
- Quand Camille consulte le carnet d'Admin_lib après la suppression
- Alors les demandes de Julien apparaissent sans son nom

**CA 6.1 — Suppression de l'invité 1**
- Étant donné que Thomas est l'invité 1 et Élodie invitée secondaire
- Quand Camille supprime Thomas
- Alors Élodie reste invitée secondaire

**CA 7.1 — Invité non activé**
- Étant donné qu'Élodie n'a pas activé son accès
- Quand Camille la supprime
- Alors le lien d'invitation d'Élodie n'est plus utilisable

**CA 8.1 — Chargement**
- Étant donné que Camille a confirmé la suppression
- Quand elle est en cours
- Alors un indicateur de chargement s'affiche sur le bouton

**CA 9.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand Camille confirme la suppression
- Alors le message d'erreur standard s'affiche et l'invité est toujours dans la liste

**CA 10.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand la suppression dépasse 15 secondes
- Alors le message de connexion lente s'affiche et l'invité est toujours dans la liste

**CA 11.1 — Désignation d'un invité existant**
- Étant donné que Camille a supprimé Thomas et qu'Élodie est invitée secondaire
- Quand Camille touche « Désigner comme invité 1 » sur la fiche d'Élodie et confirme
- Alors Élodie devient l'invité 1 et accède à la page Contrats

**CA 11.2 — Désignation à l'ajout**
- Étant donné que le compte de Camille n'a pas d'invité 1
- Quand Camille ajoute Julien en cochant « Désigner comme invité 1 »
- Alors Julien devient l'invité 1

**CA 11.3 — Bouton absent si un invité 1 existe**
- Étant donné que Thomas est l'invité 1
- Quand Camille ouvre la fiche d'Élodie
- Alors le bouton « Désigner comme invité 1 » n'est pas proposé

---

## US-21 — Consulter le nombre d'invités disponibles

**En tant qu'** utilisateur principal,
**je souhaite** voir combien d'invités je peux encore ajouter selon mon plan,
**afin de** savoir si je peux inviter une nouvelle personne.

**Écran(s) maquette :** Gestion des invités (bandeau de quota en haut d'écran). **Dépendances :** US-18, US-20.

### Règles fonctionnelles

RF1 — Un bandeau en haut de l'écran de gestion des invités affiche « [N] invité(s) sur [M] — [M − N] place(s) disponible(s) », où M est le nombre d'invités autorisé par le plan.

RF2 — Les invités en attente d'activation, en invitation expirée ou en échec d'envoi comptent dans le quota. Un invité qui a demandé la suppression de son compte (délai de grâce) ou qui a été supprimé par l'utilisateur principal ne compte plus dans le quota (décision D18 du 01/10/2026).

RF3 — Quand le quota est atteint, le bandeau affiche « Vous avez atteint le nombre maximum d'invités de votre plan » et le bouton « Ajouter un invité » est désactivé.

RF4 — Le bandeau se met à jour immédiatement après un ajout (US-18) ou une suppression (US-20).

RF5 — Le changement de plan n'est pas possible dans l'application en V1, et aucun lien vers un changement de plan n'est affiché.

RF6 — Si le plan est réduit en dessous du nombre d'invités existants, les invités existants sont conservés, mais aucun ajout n'est possible.

RF7 — Pendant le chargement du quota, un indicateur remplace le bandeau (CC-1).

RF8 — En cas d'erreur serveur, le bandeau affiche le message d'erreur standard avec un bouton « Réessayer », et le bouton « Ajouter un invité » est désactivé (CC-2).

RF9 — En cas de délai dépassé, le bandeau affiche le message de connexion lente avec un bouton « Réessayer » (CC-3).

### Règles techniques

RT1 — [backend] Le nombre d'invités autorisé est rattaché au plan souscrit, géré hors de l'application.

### UX / Design

D'après la maquette : un bandeau en haut de l'écran avec une jauge de remplissage et le texte du quota.

**Impact maquette :** Ajustement — États de chargement et d'erreur du bandeau de quota.

### Critères d'acceptance

**CA 1.1 — Affichage du quota**
- Étant donné que le plan de Camille autorise 3 invités et qu'elle en a 2
- Quand elle ouvre l'écran de gestion des invités
- Alors le bandeau affiche « 2 invité(s) sur 3 — 1 place(s) disponible(s) »

**CA 2.1 — Invité non activé compté**
- Étant donné qu'Élodie n'a pas activé son accès
- Quand Camille consulte le bandeau
- Alors Élodie est comptée dans les invités

**CA 2.2 — Invité en délai de grâce**
- Étant donné qu'Élodie a demandé la suppression de son compte
- Quand Camille consulte le bandeau
- Alors Élodie n'est plus comptée dans les invités

**CA 3.1 — Quota atteint**
- Étant donné que Camille a atteint le nombre d'invités de son plan
- Quand elle ouvre l'écran de gestion des invités
- Alors le bandeau affiche « Vous avez atteint le nombre maximum d'invités de votre plan »
- Et le bouton « Ajouter un invité » est désactivé

**CA 4.1 — Mise à jour après suppression**
- Étant donné que le quota de Camille est atteint
- Quand elle supprime un invité
- Alors le bandeau affiche une place disponible et le bouton « Ajouter un invité » redevient actif

**CA 5.1 — Pas de changement de plan**
- Étant donné que le quota de Camille est atteint
- Quand elle consulte le bandeau
- Alors aucun lien de changement de plan n'est affiché

**CA 6.1 — Plan réduit**
- Étant donné que Camille a 3 invités et que son plan passe à 2
- Quand elle ouvre l'écran de gestion des invités
- Alors ses 3 invités sont conservés et le bouton « Ajouter un invité » est désactivé

**CA 7.1 — Chargement**
- Étant donné que Camille ouvre l'écran de gestion des invités
- Quand le quota est en cours de chargement
- Alors un indicateur de chargement s'affiche à la place du bandeau

**CA 8.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand Camille ouvre l'écran de gestion des invités
- Alors le bandeau affiche le message d'erreur standard
- Et le bouton « Ajouter un invité » est désactivé

**CA 9.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand le chargement dépasse 15 secondes
- Alors le bandeau affiche le message de connexion lente avec un bouton « Réessayer »

---

# Module D — Catalogue d'agents & Dashboard

## US-22 — Consulter mon dashboard par onglet (Pro / Perso)

**En tant qu'** utilisateur ou invité,
**je souhaite** accéder à mon dashboard divisé en 2 onglets (Pro et Perso),
**afin de** retrouver rapidement les agents d'administratif professionnel ou personnel que j'ai choisis.

**Écran(s) maquette :** Dashboard utilisateur ; Dashboard invité. **Dépendances :** US-26, US-28, US-37, US-29, US-42.

### Règles fonctionnelles

RF1 — Le dashboard est l'écran d'accueil de l'utilisateur et de l'invité, après la connexion ou le déverrouillage.

RF2 — Le dashboard comporte deux onglets, « Pro » et « Perso ». À l'ouverture, le dernier onglet consulté est affiché, ou l'onglet « Pro » à la première ouverture.

RF3 — Chaque onglet liste uniquement les agents que le profil a lui-même ajoutés dans cette rubrique, dans l'ordre d'ajout. Le dashboard de l'utilisateur principal et celui de chaque invité sont indépendants.

RF4 — Chaque onglet affiche un compteur « [N]/10 agents ».

RF5 — Chaque agent est présenté par une carte : nom, description courte, statut et lien « Ouvrir le tchat ». Le statut est « Prêt », « À configurer » (US-29) ou « Bloqué » (US-42).

RF6 — Un onglet sans agent affiche le message « Vous n'avez pas encore d'agent dans cette rubrique » avec un bouton « Parcourir le catalogue ».

RF7 — Les agents de la rubrique « Agents des Contrats » n'apparaissent pas sur le dashboard, mais sur la page Contrats (US-31).

RF8 — Pendant le chargement, des cartes d'attente s'affichent à la place des agents (CC-1).

RF9 — En cas d'erreur serveur, le message d'erreur standard s'affiche avec un bouton « Réessayer » (CC-2).

RF10 — En cas de délai dépassé, le message de connexion lente s'affiche avec un bouton « Réessayer » (CC-3).

### Règles techniques

RT1 — [backend] Le statut de chaque agent (prêt, à configurer, bloqué) est calculé par le serveur au chargement du dashboard.

RT2 — [frontend] Le dashboard s'affiche en moins de 2 secondes sur un réseau mobile standard.

### UX / Design

D'après la maquette : deux onglets en haut de l'écran, une carte par agent avec un badge de statut, et une barre de navigation principale en bas de l'écran.

**Impact maquette :** Ajustement — Retrait du badge « Nouvelle réponse » ; Cartes d'attente et état vide avec « Parcourir le catalogue » ; Compteur « N/10 agents ».

### Critères d'acceptance

**CA 1.1 — Écran d'accueil**
- Étant donné que je suis invité
- Quand je déverrouille MAAQ
- Alors mon dashboard s'affiche

**CA 2.1 — Onglet par défaut**
- Étant donné que j'ai consulté l'onglet « Perso » lors de ma dernière visite
- Quand j'ouvre mon dashboard
- Alors l'onglet « Perso » est affiché

**CA 3.1 — Dashboards indépendants**
- Étant donné que Camille a ajouté Admin_Classify dans « Pro » et pas Thomas
- Quand Thomas ouvre son onglet « Pro »
- Alors Admin_Classify n'y figure pas

**CA 4.1 — Compteur**
- Étant donné que j'ai 3 agents dans l'onglet « Pro »
- Quand j'affiche cet onglet
- Alors le compteur indique « 3/10 agents »

**CA 5.1 — Carte d'agent**
- Étant donné qu'Admin_lib est dans mon onglet « Perso » et configuré
- Quand j'affiche cet onglet
- Alors la carte d'Admin_lib affiche son nom, sa description, le statut « Prêt » et le lien « Ouvrir le tchat »

**CA 6.1 — Onglet vide**
- Étant donné que je n'ai aucun agent dans l'onglet « Perso »
- Quand j'affiche cet onglet
- Alors le message « Vous n'avez pas encore d'agent dans cette rubrique » s'affiche avec un bouton « Parcourir le catalogue »

**CA 7.1 — Agents des Contrats exclus**
- Étant donné que j'ai ajouté Contrat_Mutuelle
- Quand j'affiche mon dashboard
- Alors Contrat_Mutuelle n'apparaît dans aucun onglet

**CA 8.1 — Chargement**
- Étant donné que j'ouvre mon dashboard
- Quand les agents sont en cours de chargement
- Alors des cartes d'attente s'affichent

**CA 9.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand j'ouvre mon dashboard
- Alors le message d'erreur standard s'affiche avec un bouton « Réessayer »

**CA 10.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand le chargement dépasse 15 secondes
- Alors le message de connexion lente s'affiche avec un bouton « Réessayer »

---

## US-23 — Parcourir le catalogue d'agents par rubrique

**En tant qu'** utilisateur ou invité,
**je souhaite** parcourir le catalogue des agents disponibles, organisé en 3 rubriques (Pro, Perso, Agents des Contrats),
**afin de** découvrir les agents qui peuvent m'être utiles.

**Écran(s) maquette :** Catalogue. **Dépendances :** US-45, US-24, US-25.

### Règles fonctionnelles

RF1 — Le catalogue est accessible depuis la navigation principale et depuis le bouton « Parcourir le catalogue » d'un onglet vide.

RF2 — Le catalogue comporte trois onglets : « Pro », « Perso » et « Agents des Contrats ». Chaque agent n'apparaît que dans sa rubrique.

RF3 — Seuls les agents mis à disposition par l'administrateur (US-45) apparaissent, classés par ordre alphabétique.

RF4 — Chaque agent est présenté par une carte : nom, description courte, et le badge « Ajouté » s'il est déjà dans le dashboard ou la page Contrats du profil.

RF5 — Un agent bloqué par l'administrateur (US-46) reste visible avec le badge « En maintenance ».

RF6 — Toucher une carte ouvre la fiche de l'agent (US-24).

RF7 — Une rubrique sans agent affiche « Aucun agent disponible dans cette rubrique pour le moment ».

RF8 — Pendant le chargement, des cartes d'attente s'affichent (CC-1).

RF9 — En cas d'erreur serveur, le message d'erreur standard s'affiche avec un bouton « Réessayer » (CC-2).

RF10 — En cas de délai dépassé, le message de connexion lente s'affiche avec un bouton « Réessayer » (CC-3).

RF11 — Pour un invité secondaire, la rubrique « Agents des Contrats » n'est pas proposée dans le catalogue, ni dans les résultats de recherche (US-25) (décision du 30/09/2026).

### Règles techniques

RT1 — [backend] Le catalogue peut contenir une cinquantaine d'agents. Il est chargé rubrique par rubrique pour limiter le volume échangé sur réseau mobile.

### UX / Design

D'après la maquette : trois onglets, le champ de recherche en haut (US-25) et une liste de cartes.

**Impact maquette :** Ajustement — Catalogue d'un invité secondaire sans la rubrique « Agents des Contrats » ; Badge « En maintenance » ; Rubrique vide.

### Critères d'acceptance

**CA 1.1 — Accès depuis la navigation**
- Étant donné que je suis sur mon dashboard
- Quand je touche « Catalogue » dans la navigation principale
- Alors le catalogue s'affiche

**CA 2.1 — Une rubrique par agent**
- Étant donné qu'Admin_lib appartient à la rubrique « Perso »
- Quand je parcours les trois onglets
- Alors Admin_lib n'apparaît que dans l'onglet « Perso »

**CA 3.1 — Agents mis à disposition uniquement**
- Étant donné qu'un agent n'a pas encore été mis à disposition
- Quand je parcours le catalogue
- Alors cet agent n'apparaît pas

**CA 4.1 — Badge « Ajouté »**
- Étant donné que j'ai ajouté Admin_Classify à mon dashboard
- Quand j'affiche l'onglet « Pro » du catalogue
- Alors la carte d'Admin_Classify porte le badge « Ajouté »

**CA 5.1 — Agent en maintenance**
- Étant donné qu'Admin_lib est bloqué par l'administrateur
- Quand j'affiche l'onglet « Perso » du catalogue
- Alors Admin_lib porte le badge « En maintenance »

**CA 6.1 — Ouverture de la fiche**
- Étant donné que le catalogue est affiché
- Quand je touche la carte d'Admin_lib
- Alors la fiche d'Admin_lib s'affiche

**CA 7.1 — Rubrique vide**
- Étant donné qu'aucun agent n'est disponible dans une rubrique
- Quand j'affiche cette rubrique
- Alors le message « Aucun agent disponible dans cette rubrique pour le moment » s'affiche

**CA 8.1 — Chargement**
- Étant donné que j'ouvre le catalogue
- Quand les agents sont en cours de chargement
- Alors des cartes d'attente s'affichent

**CA 9.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand j'ouvre le catalogue
- Alors le message d'erreur standard s'affiche avec un bouton « Réessayer »

**CA 10.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand le chargement dépasse 15 secondes
- Alors le message de connexion lente s'affiche avec un bouton « Réessayer »

**CA 11.1 — Rubrique masquée pour un invité secondaire**
- Étant donné que je suis Élodie, invitée secondaire
- Quand j'ouvre le catalogue
- Alors seuls les onglets « Pro » et « Perso » sont proposés

---

## US-24 — Consulter la fiche descriptive d'un agent

**En tant qu'** utilisateur ou invité,
**je souhaite** consulter la fiche d'un agent (à quoi il sert, ce qu'il faut configurer),
**afin de** décider s'il répond à mon besoin avant de l'ajouter.

**Écran(s) maquette :** Fiche agent. **Dépendances :** US-23, US-26, US-45.

### Règles fonctionnelles

RF1 — La fiche affiche :
- le nom de l'agent et sa rubrique ;
- une description de ce qu'il fait et des exemples de demandes ;
- les éléments de configuration nécessaires (compte Google Drive, compte Google Agenda, boîte mail de validation) ;
- les types d'actions qui demandent une validation avant exécution.

RF2 — La fiche informe sur la configuration nécessaire, mais ne la demande pas.

RF3 — Si l'agent n'est pas dans le dashboard ou la page Contrats du profil, la fiche propose le bouton « Ajouter à mon dashboard » (US-26). S'il y est déjà, elle affiche « Déjà ajouté » et un bouton « Ouvrir le tchat ».

RF4 — Un agent en maintenance affiche un bandeau « Cet agent est temporairement en maintenance ». L'ajout reste possible.

RF5 — Le bouton retour ramène au catalogue, dans la rubrique et avec la recherche en cours.

RF6 — Pendant le chargement, un indicateur de chargement s'affiche (CC-1).

RF7 — En cas d'erreur serveur, le message d'erreur standard s'affiche avec un bouton « Réessayer » (CC-2).

RF8 — En cas de délai dépassé, le message de connexion lente s'affiche avec un bouton « Réessayer » (CC-3).

### Règles techniques

RT1 — [backend] Le contenu de la fiche est saisi par l'administrateur lors de la mise à disposition de l'agent (US-45).

### UX / Design

D'après la maquette : un en-tête avec le nom et la rubrique, puis des sections « À quoi il sert », « Exemples de demandes » et « Ce qu'il faut configurer ». Le bouton principal est en bas d'écran. Le bouton de démonstration « Limite atteinte » ne fait pas partie de l'interface réelle.

**Impact maquette :** Ajustement — Bandeau « Cet agent est temporairement en maintenance » ; Retirer le bouton de démonstration « Limite atteinte ».

### Critères d'acceptance

**CA 1.1 — Contenu de la fiche**
- Étant donné que j'ouvre la fiche d'Admin_lib
- Quand elle s'affiche
- Alors je vois son nom, sa rubrique, sa description, des exemples de demandes, la configuration nécessaire et les actions soumises à validation

**CA 2.1 — Aucune saisie demandée**
- Étant donné que la fiche d'Admin_lib indique qu'un compte Google Agenda est nécessaire
- Quand je la consulte
- Alors aucun champ de saisie ne m'est proposé

**CA 3.1 — Agent non ajouté**
- Étant donné qu'Admin_lib n'est pas dans mon dashboard
- Quand j'ouvre sa fiche
- Alors le bouton « Ajouter à mon dashboard » est affiché

**CA 3.2 — Agent déjà ajouté**
- Étant donné qu'Admin_lib est dans mon dashboard
- Quand j'ouvre sa fiche
- Alors la mention « Déjà ajouté » et le bouton « Ouvrir le tchat » sont affichés

**CA 4.1 — Agent en maintenance**
- Étant donné qu'Admin_lib est bloqué
- Quand j'ouvre sa fiche
- Alors le bandeau « Cet agent est temporairement en maintenance » s'affiche

**CA 5.1 — Retour au catalogue**
- Étant donné que j'ai ouvert la fiche depuis une recherche « agenda »
- Quand je touche le bouton retour
- Alors le catalogue s'affiche avec la recherche « agenda » et ses résultats

**CA 6.1 — Chargement**
- Étant donné que j'ouvre une fiche
- Quand elle est en cours de chargement
- Alors un indicateur de chargement s'affiche

**CA 7.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand j'ouvre une fiche
- Alors le message d'erreur standard s'affiche avec un bouton « Réessayer »

**CA 8.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand le chargement dépasse 15 secondes
- Alors le message de connexion lente s'affiche avec un bouton « Réessayer »

---

## US-25 — Rechercher un agent par mot-clé

**En tant qu'** utilisateur ou invité,
**je souhaite** rechercher un agent dans le catalogue à l'aide d'un mot-clé,
**afin de** le trouver rapidement sans parcourir toute la liste.

**Écran(s) maquette :** Catalogue (champ de recherche, résultats toutes rubriques confondues). **Dépendances :** US-23.

### Règles fonctionnelles

RF1 — Un champ de recherche est affiché en haut du catalogue.

RF2 — La recherche démarre à partir de 2 caractères saisis. Elle porte sur le nom, la description et les exemples de demandes des agents. Elle ne tient compte ni des majuscules ni des accents.

RF3 — Les résultats regroupent toutes les rubriques. Chaque résultat indique la rubrique de l'agent.

RF4 — Sans résultat, le message « Aucun agent ne correspond à « [mot-clé] » » s'affiche avec un lien « Parcourir les rubriques ».

RF5 — Effacer le champ ramène à la navigation par rubrique.

RF6 — Pendant la recherche, un indicateur de chargement s'affiche sous le champ (CC-1).

RF7 — En cas d'erreur serveur, le message d'erreur standard s'affiche sous le champ avec un bouton « Réessayer » (CC-2).

RF8 — En cas de délai dépassé, le message de connexion lente s'affiche avec un bouton « Réessayer » (CC-3).

RF9 — Pour un invité secondaire, les agents de la rubrique « Agents des Contrats » n'apparaissent pas dans les résultats (décision du 30/09/2026).

### Règles techniques

RT1 — [frontend] La recherche est lancée après une courte pause dans la saisie, pour ne pas multiplier les échanges avec le serveur. Elle peut aussi s'appliquer sur le catalogue déjà chargé.

### UX / Design

D'après la maquette : le champ de recherche avec une icône de loupe et un bouton d'effacement. Les résultats s'affichent sous forme de liste, avec le nom de la rubrique en étiquette.

**Impact maquette :** Ajustement — État « Aucun résultat » avec lien « Parcourir les rubriques ».

### Critères d'acceptance

**CA 1.1 — Champ affiché**
- Étant donné que j'ouvre le catalogue
- Quand l'écran s'affiche
- Alors le champ de recherche est visible en haut

**CA 2.1 — Recherche insensible aux accents**
- Étant donné que le catalogue contient un agent dont la description mentionne « impôts »
- Quand je saisis « impots »
- Alors cet agent apparaît dans les résultats

**CA 2.2 — Moins de 2 caractères**
- Étant donné que le champ est vide
- Quand je saisis une seule lettre
- Alors aucune recherche n'est lancée

**CA 3.1 — Résultats toutes rubriques**
- Étant donné que des agents Pro et Perso concernent les rendez-vous
- Quand je saisis « rendez-vous »
- Alors les résultats contiennent des agents des deux rubriques, chacun avec sa rubrique indiquée

**CA 4.1 — Aucun résultat**
- Étant donné qu'aucun agent ne correspond à « piscine »
- Quand je saisis « piscine »
- Alors le message « Aucun agent ne correspond à « piscine » » s'affiche avec un lien « Parcourir les rubriques »

**CA 5.1 — Effacement**
- Étant donné qu'une recherche est affichée
- Quand j'efface le champ
- Alors la navigation par rubrique s'affiche de nouveau

**CA 6.1 — Chargement**
- Étant donné que je saisis un mot-clé
- Quand la recherche est en cours
- Alors un indicateur de chargement s'affiche sous le champ

**CA 7.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand je lance une recherche
- Alors le message d'erreur standard s'affiche avec un bouton « Réessayer »

**CA 8.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand la recherche dépasse 15 secondes
- Alors le message de connexion lente s'affiche avec un bouton « Réessayer »

**CA 9.1 — Résultats filtrés pour un invité secondaire**
- Étant donné que je suis Élodie, invitée secondaire
- Quand je recherche « mutuelle »
- Alors Contrat_Mutuelle n'apparaît pas dans les résultats

---

## US-26 — Ajouter un agent à mon dashboard

**En tant qu'** utilisateur ou invité,
**je souhaite** ajouter un agent du catalogue à mon dashboard,
**afin de** pouvoir l'utiliser au quotidien.

**Écran(s) maquette :** Fiche agent (bouton « Ajouter à mon dashboard »). **Dépendances :** US-24, US-27, US-22, US-31, US-29.

### Règles fonctionnelles

RF1 — Le bouton « Ajouter à mon dashboard » de la fiche ajoute l'agent dans l'emplacement correspondant à sa rubrique :
- onglet « Pro » ou « Perso » du dashboard ;
- onglet « Agents des Contrats » de la page Contrats.

RF2 — Après l'ajout, le message « [Agent] a été ajouté à votre onglet [rubrique] » s'affiche avec un lien vers cet onglet. Le bouton devient « Déjà ajouté ».

RF3 — Si la rubrique contient déjà 10 agents, l'ajout est bloqué (US-27).

RF4 — Si l'agent a déjà été ajouté puis retiré, sa configuration et son carnet de bord sont retrouvés (US-28).

RF5 — Si l'agent nécessite une configuration que le profil n'a pas encore faite, il apparaît avec le statut « À configurer ». Le message de confirmation propose alors un lien « Configurer maintenant » vers l'écran Connecteurs.

RF6 — Chaque profil ajoute ses agents indépendamment. L'ajout par un profil n'ajoute pas l'agent aux autres profils.

RF7 — Pendant l'ajout, le bouton affiche un indicateur de chargement et est désactivé, pour éviter un double ajout (CC-1).

RF8 — En cas d'erreur serveur, le message d'erreur standard s'affiche et l'agent n'est pas ajouté (CC-2).

RF9 — En cas de délai dépassé, le message de connexion lente s'affiche et l'agent n'est pas ajouté (CC-3).

### Règles techniques

RT1 — [backend] Un même agent ne peut figurer qu'une fois dans le dashboard d'un profil, même en cas de double envoi.

RT2 — [backend] La limite de 10 agents par rubrique est vérifiée côté serveur (voir US-27).

### UX / Design

D'après la maquette : le bouton principal en bas de la fiche. La confirmation s'affiche sous forme de message temporaire en bas d'écran.

**Impact maquette :** Ajustement — Message de confirmation avec lien « Configurer maintenant ».

### Critères d'acceptance

**CA 1.1 — Ajout dans l'onglet Perso**
- Étant donné qu'Admin_lib appartient à la rubrique « Perso »
- Quand je touche « Ajouter à mon dashboard » sur sa fiche
- Alors Admin_lib apparaît dans l'onglet « Perso » de mon dashboard

**CA 1.2 — Ajout d'un agent des Contrats**
- Étant donné que Contrat_Mutuelle appartient à la rubrique « Agents des Contrats »
- Quand je l'ajoute
- Alors il apparaît dans l'onglet « Agents des Contrats » de la page Contrats

**CA 2.1 — Confirmation**
- Étant donné que j'ajoute Admin_lib
- Quand l'ajout réussit
- Alors le message « Admin_lib a été ajouté à votre onglet Perso » s'affiche
- Et le bouton devient « Déjà ajouté »

**CA 3.1 — Limite atteinte**
- Étant donné que j'ai 10 agents dans l'onglet « Pro »
- Quand j'ajoute un agent Pro
- Alors l'ajout est bloqué et le message de limite s'affiche

**CA 4.1 — Réajout après retrait**
- Étant donné que j'ai configuré puis retiré Admin_lib
- Quand je l'ajoute de nouveau
- Alors il apparaît avec sa configuration précédente et le statut « Prêt »

**CA 5.1 — Agent à configurer**
- Étant donné que je n'ai pas connecté mon agenda
- Quand j'ajoute Admin_lib
- Alors Admin_lib apparaît avec le statut « À configurer »
- Et le message de confirmation propose « Configurer maintenant »

**CA 6.1 — Ajout indépendant**
- Étant donné que Camille ajoute Admin_lib
- Quand Thomas consulte son dashboard
- Alors Admin_lib n'y figure pas

**CA 7.1 — Chargement**
- Étant donné que je touche « Ajouter à mon dashboard »
- Quand l'ajout est en cours
- Alors un indicateur de chargement s'affiche et le bouton est désactivé

**CA 8.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand je touche « Ajouter à mon dashboard »
- Alors le message d'erreur standard s'affiche et l'agent n'est pas ajouté

**CA 9.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand l'ajout dépasse 15 secondes
- Alors le message de connexion lente s'affiche et l'agent n'est pas ajouté

---

## US-27 — Être informé de la limite de 10 agents par rubrique

**En tant qu'** utilisateur ou invité,
**je souhaite** être averti clairement lorsque j'ai atteint le maximum de 10 agents dans une rubrique (Pro, Perso ou Agents des Contrats),
**afin de** comprendre pourquoi je ne peux pas en ajouter un de plus et savoir quoi faire.

**Écran(s) maquette :** Fiche agent (bouton de démonstration « Limite atteinte »). **Dépendances :** US-26, US-28.

### Règles fonctionnelles

RF1 — Chaque profil peut avoir au maximum 10 agents par rubrique (Pro, Perso, Agents des Contrats).

RF2 — Lorsque la rubrique de l'agent compte déjà 10 agents, le bouton « Ajouter à mon dashboard » reste visible. À l'appui, l'ajout est bloqué et le message suivant s'affiche : « Vous avez atteint le maximum de 10 agents dans la rubrique [rubrique]. Retirez un agent de cette rubrique pour en ajouter un nouveau. », avec un lien « Gérer mes agents [rubrique] ».

RF3 — Le lien « Gérer mes agents » ouvre l'onglet correspondant du dashboard ou de la page Contrats.

RF4 — La limite est vérifiée au moment de l'ajout, y compris si le profil a ajouté des agents depuis un autre appareil entre-temps.

RF5 — Pendant la vérification, l'indicateur de chargement de l'ajout s'affiche (CC-1, voir US-26).

RF6 — En cas d'erreur serveur pendant la vérification, le message d'erreur standard s'affiche et l'agent n'est pas ajouté (CC-2).

RF7 — En cas de délai dépassé, le message de connexion lente s'affiche et l'agent n'est pas ajouté (CC-3).

### Règles techniques

RT1 — [backend] La limite de 10 est un paramètre modifiable sans nouvelle version de l'application, depuis l'écran « Paramètres » de la console (US-65).

### UX / Design

D'après la maquette : le message de limite s'affiche dans un encadré d'alerte au-dessus du bouton, avec le lien d'action.

**Impact maquette :** aucun ajustement nécessaire.

### Critères d'acceptance

**CA 1.1 — Onze agents impossibles**
- Étant donné que j'ai 10 agents dans l'onglet « Perso »
- Quand je tente d'ajouter un onzième agent Perso
- Alors l'agent n'est pas ajouté

**CA 1.2 — Limite propre à chaque rubrique**
- Étant donné que j'ai 10 agents dans l'onglet « Pro » et 2 dans l'onglet « Perso »
- Quand j'ajoute un agent Perso
- Alors l'ajout réussit

**CA 2.1 — Message de limite**
- Étant donné que j'ai 10 agents « Pro »
- Quand je touche « Ajouter à mon dashboard » sur un agent Pro
- Alors le message « Vous avez atteint le maximum de 10 agents dans la rubrique Pro. Retirez un agent de cette rubrique pour en ajouter un nouveau. » s'affiche

**CA 3.1 — Lien vers la rubrique**
- Étant donné que le message de limite est affiché pour la rubrique « Pro »
- Quand je touche « Gérer mes agents Pro »
- Alors l'onglet « Pro » de mon dashboard s'affiche

**CA 4.1 — Ajout depuis un autre appareil**
- Étant donné que j'ai 9 agents Pro et que j'en ajoute un dixième depuis ma tablette
- Quand je tente d'ajouter un agent Pro depuis mon téléphone
- Alors le message de limite s'affiche

**CA 5.1 — Chargement**
- Étant donné que je touche « Ajouter à mon dashboard »
- Quand la vérification est en cours
- Alors un indicateur de chargement s'affiche

**CA 6.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand je tente un ajout
- Alors le message d'erreur standard s'affiche et l'agent n'est pas ajouté

**CA 7.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand la vérification dépasse 15 secondes
- Alors le message de connexion lente s'affiche et l'agent n'est pas ajouté

---

## US-28 — Retirer un agent de mon dashboard

**En tant qu'** utilisateur ou invité,
**je souhaite** retirer un agent de mon dashboard,
**afin de** libérer de la place et ne garder que les agents utiles.

**Écran(s) maquette :** Dashboard utilisateur / Dashboard invité (bouton « Retirer », avec confirmation). **Dépendances :** US-22, US-31, US-40.

### Règles fonctionnelles

RF1 — Chaque carte d'agent du dashboard et de l'onglet « Agents des Contrats » propose un bouton « Retirer ».

RF2 — Le bouton ouvre la confirmation « Retirer [agent] ? Sa configuration et son carnet de bord sont conservés. », avec les boutons « Retirer » et « Annuler ».

RF3 — À la confirmation, l'agent disparaît de l'onglet et le compteur de la rubrique diminue de 1.

RF4 — La configuration de l'agent et son carnet de bord sont conservés. Le carnet reste consultable depuis Réglages > Carnet (US-50), dans la limite de la durée de conservation du carnet (US-40).

RF5 — Le retrait par un profil n'a aucun effet sur les dashboards des autres profils, ni sur le carnet partagé.

RF6 — L'historique du tchat de cet agent est effacé au retrait.

RF7 — Pendant le retrait, un indicateur de chargement s'affiche sur le bouton de confirmation (CC-1).

RF8 — En cas d'erreur serveur, le message d'erreur standard s'affiche et l'agent reste dans l'onglet (CC-2).

RF9 — En cas de délai dépassé, le message de connexion lente s'affiche et l'agent reste dans l'onglet (CC-3).

### Règles techniques

RT1 — [backend] Le retrait ne supprime aucune donnée : il masque seulement l'agent du dashboard du profil.

### UX / Design

D'après la maquette : le bouton « Retirer » est un lien discret sur la carte, et la confirmation s'affiche dans une fenêtre superposée.

**Impact maquette :** aucun ajustement nécessaire.

### Critères d'acceptance

**CA 1.1 — Bouton présent**
- Étant donné qu'Admin_lib est dans mon dashboard
- Quand j'affiche sa carte
- Alors le bouton « Retirer » est disponible

**CA 2.1 — Confirmation**
- Étant donné que je touche « Retirer » sur Admin_lib
- Quand la confirmation s'affiche
- Alors elle indique « Retirer Admin_lib ? Sa configuration et son carnet de bord sont conservés. »

**CA 2.2 — Annulation**
- Étant donné que la confirmation est affichée
- Quand je touche « Annuler »
- Alors Admin_lib reste dans mon dashboard

**CA 3.1 — Retrait effectif**
- Étant donné que j'ai 4 agents « Perso » dont Admin_lib
- Quand je confirme le retrait d'Admin_lib
- Alors Admin_lib disparaît et le compteur indique « 3/10 agents »

**CA 4.1 — Carnet conservé**
- Étant donné que j'ai retiré Admin_lib
- Quand j'ouvre Réglages > Carnet
- Alors le carnet d'Admin_lib est toujours consultable

**CA 5.1 — Aucun effet sur les autres profils**
- Étant donné que Camille et Thomas ont tous deux Admin_lib
- Quand Thomas retire Admin_lib
- Alors Admin_lib reste dans le dashboard de Camille

**CA 6.1 — Historique du tchat effacé**
- Étant donné que j'avais une conversation avec Admin_lib
- Quand je le retire puis le rajoute
- Alors le tchat d'Admin_lib affiche l'état d'accueil sans historique

**CA 7.1 — Chargement**
- Étant donné que j'ai confirmé le retrait
- Quand il est en cours
- Alors un indicateur de chargement s'affiche sur le bouton

**CA 8.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand je confirme le retrait
- Alors le message d'erreur standard s'affiche et l'agent reste dans mon dashboard

**CA 9.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand le retrait dépasse 15 secondes
- Alors le message de connexion lente s'affiche et l'agent reste dans mon dashboard

---

## US-29 — Être informé qu'un agent n'est pas encore configuré

**En tant qu'** invité,
**je souhaite** être averti explicitement lorsque j'ouvre un agent qui n'est pas encore utilisable,
**afin de** comprendre ce qui manque pour l'utiliser.

**Écran(s) maquette :** Contrats invité (agent « Contrat_Mutuelle », avec lien vers Connecteurs invité). Même principe sur le dashboard invité. **Dépendances :** US-13, US-14, US-15, US-16.

### Règles fonctionnelles

RF1 — Un agent est inutilisable par l'invité dans deux cas :
- la configuration commune de l'agent, qui relève de l'utilisateur principal, n'est pas faite ;
- l'invité n'a pas connecté ses propres comptes requis par l'agent (US-13, US-14), ou n'a pas configuré sa boîte de validation (US-15).

RF2 — Un agent inutilisable porte le statut « À configurer » sur sa carte, dans le dashboard ou la page Contrats.

RF3 — À l'ouverture de son tchat, un écran informatif remplace la zone de saisie et liste chaque élément manquant :
- pour un élément relevant de l'invité : le texte « Connectez votre compte Google Agenda » et un bouton « Configurer mes connecteurs » vers l'écran Connecteurs ;
- pour un élément relevant de l'utilisateur principal : le texte « Cet agent doit d'abord être configuré par [prénom de l'utilisateur principal] », sans action possible pour l'invité.

RF4 — Aucune demande ne peut être envoyée à l'agent tant qu'un élément manque.

RF5 — Dès que tous les éléments sont configurés, l'agent devient utilisable à la prochaine ouverture de son tchat, sans action supplémentaire. Son statut passe à « Prêt ».

RF6 — La même règle s'applique à l'utilisateur principal pour ses propres connecteurs manquants.

RF7 — Pendant la vérification de la configuration, un indicateur de chargement s'affiche (CC-1).

RF8 — En cas d'erreur serveur, le message d'erreur standard s'affiche avec un bouton « Réessayer » (CC-2).

RF9 — En cas de délai dépassé, le message de connexion lente s'affiche avec un bouton « Réessayer » (CC-3).

### Règles techniques

RT1 — [backend] Le serveur détermine, pour chaque agent et chaque profil, la liste des éléments de configuration manquants et leur responsable. Il s'appuie sur les éléments requis que l'administrateur précise lors de l'ajout et de la publication de l'agent dans la console d'administration (US-45) (décision du 30/09/2026). Les éléments requis comprennent, le cas échéant, la connexion du compte (Google Drive du compte, US-67), dont le responsable est l'utilisateur principal (décision D14 du 01/10/2026).

### UX / Design

D'après la maquette : un encadré d'information dans le tchat liste les deux causes possibles, avec un lien vers les connecteurs de l'invité. La maquette ne montre que les agents des Contrats, mais le principe s'applique aussi aux agents Pro et Perso.

**Impact maquette :** Ajustement — Variante « Google Drive du compte à connecter par [prénom] » ; Variante sur un agent Pro ou Perso du dashboard ; Variante « élément relevant de l'utilisateur principal », sans action possible.

### Critères d'acceptance

**CA 1.1 — Comptes de l'invité manquants**
- Étant donné que Thomas n'a pas connecté son agenda
- Quand il consulte son dashboard
- Alors Admin_lib n'est pas utilisable

**CA 2.1 — Statut « À configurer »**
- Étant donné qu'Admin_lib n'est pas utilisable par Thomas
- Quand Thomas affiche son dashboard
- Alors la carte d'Admin_lib porte le statut « À configurer »

**CA 3.1 — Élément relevant de l'invité**
- Étant donné que Thomas n'a pas connecté son agenda
- Quand il ouvre le tchat d'Admin_lib
- Alors il voit « Connectez votre compte Google Agenda » et le bouton « Configurer mes connecteurs »

**CA 3.2 — Élément relevant de l'utilisateur principal**
- Étant donné que Camille n'a pas fait la configuration commune de Contrat_Mutuelle
- Quand Thomas ouvre le tchat de Contrat_Mutuelle
- Alors il voit « Cet agent doit d'abord être configuré par Camille », sans bouton d'action

**CA 4.1 — Saisie impossible**
- Étant donné qu'un élément de configuration manque
- Quand Thomas ouvre le tchat de l'agent
- Alors la zone de saisie n'est pas disponible

**CA 5.1 — Agent devenu utilisable**
- Étant donné que Thomas vient de connecter son agenda
- Quand il rouvre le tchat d'Admin_lib
- Alors la zone de saisie est disponible et le statut est « Prêt »

**CA 6.1 — Utilisateur principal**
- Étant donné que Camille n'a pas connecté son Drive
- Quand elle ouvre le tchat d'Admin_Classify
- Alors elle voit « Connectez votre compte Google Drive » et le bouton « Configurer mes connecteurs »

**CA 7.1 — Chargement**
- Étant donné que Thomas ouvre le tchat d'un agent
- Quand la configuration est en cours de vérification
- Alors un indicateur de chargement s'affiche

**CA 8.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand Thomas ouvre le tchat d'un agent
- Alors le message d'erreur standard s'affiche avec un bouton « Réessayer »

**CA 9.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand la vérification dépasse 15 secondes
- Alors le message de connexion lente s'affiche avec un bouton « Réessayer »

---

# Module E — Page Contrats

## US-30 — Accéder à la page Contrats

**En tant qu'** utilisateur ou invité,
**je souhaite** accéder à une page Contrats organisée en 2 onglets (« Agents des Contrats » et « Mes contrats »),
**afin de** piloter mes contrats et retrouver leurs informations au même endroit.

**Écran(s) maquette :** Contrats utilisateur ; Contrats invité. **Dépendances :** US-31, US-32.

### Règles fonctionnelles

RF1 — La navigation principale de l'utilisateur et de l'invité propose quatre entrées : « Agents » (dashboard), « Catalogue », « Contrats » et « Réglages ». Aucune entrée « Carnet » n'y figure.

RF2 — La page Contrats comporte deux onglets, « Agents des Contrats » et « Mes contrats ». À l'ouverture, l'onglet « Mes contrats » est affiché.

RF3 — La page Contrats est réservée à l'utilisateur principal et à l'invité 1. Pour un invité secondaire, elle est entièrement masquée : aucune entrée « Contrats » dans sa navigation, et donc aucun agent des Contrats (décision du 30/09/2026).

RF4 — Pendant le chargement, un indicateur de chargement s'affiche dans l'onglet ouvert (CC-1).

RF5 — En cas d'erreur serveur, le message d'erreur standard s'affiche avec un bouton « Réessayer » (CC-2).

RF6 — En cas de délai dépassé, le message de connexion lente s'affiche avec un bouton « Réessayer » (CC-3).

### Règles techniques

RT1 — [frontend] Chaque onglet charge ses données uniquement lorsqu'il est affiché.

### UX / Design

D'après la maquette : l'entrée « Contrats » de la barre de navigation remplace l'ancienne entrée « Carnet ». Les deux onglets sont en haut de page.

**Impact maquette :** Ajustement — Navigation d'un invité secondaire sans entrée « Contrats ».

### Critères d'acceptance

**CA 1.1 — Navigation principale**
- Étant donné que je suis connecté en tant qu'invité
- Quand je regarde la barre de navigation
- Alors je vois « Agents », « Catalogue », « Contrats » et « Réglages », sans entrée « Carnet »

**CA 2.1 — Onglets de la page**
- Étant donné que je touche « Contrats » dans la navigation
- Quand la page s'affiche
- Alors je vois les onglets « Agents des Contrats » et « Mes contrats », avec « Mes contrats » ouvert

**CA 3.1 — Même page pour le noyau**
- Étant donné que je suis Thomas, invité 1
- Quand j'ouvre la page Contrats
- Alors je vois les mêmes deux onglets que Camille

**CA 3.2 — Page masquée pour un invité secondaire**
- Étant donné que je suis Élodie, invitée secondaire
- Quand je regarde la barre de navigation
- Alors l'entrée « Contrats » n'y figure pas

**CA 4.1 — Chargement**
- Étant donné que j'ouvre la page Contrats
- Quand l'onglet est en cours de chargement
- Alors un indicateur de chargement s'affiche

**CA 5.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand j'ouvre la page Contrats
- Alors le message d'erreur standard s'affiche avec un bouton « Réessayer »

**CA 6.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand le chargement dépasse 15 secondes
- Alors le message de connexion lente s'affiche avec un bouton « Réessayer »

---

## US-31 — Consulter les agents des Contrats

**En tant qu'** utilisateur ou invité,
**je souhaite** retrouver dans l'onglet « Agents des Contrats » les agents que j'ai ajoutés pour piloter mes contrats,
**afin de** les solliciter facilement (ex. négocier une cotisation).

**Écran(s) maquette :** Contrats utilisateur / Contrats invité (onglet « Agents des Contrats »). **Dépendances :** US-26, US-27, US-28, US-37, US-29.

### Règles fonctionnelles

RF1 — L'onglet « Agents des Contrats » liste les agents de cette rubrique que le profil a ajoutés, avec un compteur « [N]/10 agents ».

RF2 — Les cartes d'agents, leurs statuts (« Prêt », « À configurer », « Bloqué ») et le lien « Ouvrir le tchat » fonctionnent comme sur le dashboard (US-22).

RF3 — L'ajout, le retrait et la limite de 10 agents suivent les règles de US-26, US-28 et US-27.

RF4 — Sans agent, l'onglet affiche « Vous n'avez pas encore d'agent des Contrats » avec un bouton « Parcourir le catalogue ». Ce bouton ouvre le catalogue sur la rubrique « Agents des Contrats ».

RF5 — Pendant le chargement, des cartes d'attente s'affichent (CC-1).

RF6 — En cas d'erreur serveur, le message d'erreur standard s'affiche avec un bouton « Réessayer » (CC-2).

RF7 — En cas de délai dépassé, le message de connexion lente s'affiche avec un bouton « Réessayer » (CC-3).

### Règles techniques

RT1 — [backend] Mêmes règles de calcul des statuts que pour le dashboard (US-22).

### UX / Design

D'après la maquette : même présentation en cartes que le dashboard.

**Impact maquette :** Ajustement — État vide de l'onglet « Agents des Contrats ».

### Critères d'acceptance

**CA 1.1 — Liste et compteur**
- Étant donné que j'ai ajouté Contrat_Mutuelle et Contrat_Auto
- Quand j'ouvre l'onglet « Agents des Contrats »
- Alors je vois les deux agents et le compteur « 2/10 agents »

**CA 2.1 — Ouverture du tchat**
- Étant donné que Contrat_Auto est « Prêt »
- Quand je touche « Ouvrir le tchat » sur sa carte
- Alors le tchat de Contrat_Auto s'affiche

**CA 3.1 — Retrait**
- Étant donné que Contrat_Auto est dans l'onglet
- Quand je le retire et confirme
- Alors il disparaît de l'onglet et le compteur diminue de 1

**CA 4.1 — Onglet vide**
- Étant donné que je n'ai aucun agent des Contrats
- Quand j'ouvre l'onglet
- Alors le message « Vous n'avez pas encore d'agent des Contrats » s'affiche avec un bouton « Parcourir le catalogue »

**CA 4.2 — Catalogue sur la bonne rubrique**
- Étant donné que l'onglet est vide
- Quand je touche « Parcourir le catalogue »
- Alors le catalogue s'ouvre sur la rubrique « Agents des Contrats »

**CA 5.1 — Chargement**
- Étant donné que j'ouvre l'onglet
- Quand les agents sont en cours de chargement
- Alors des cartes d'attente s'affichent

**CA 6.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand j'ouvre l'onglet
- Alors le message d'erreur standard s'affiche avec un bouton « Réessayer »

**CA 7.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand le chargement dépasse 15 secondes
- Alors le message de connexion lente s'affiche avec un bouton « Réessayer »

---

## US-32 — Consulter la liste de mes contrats

**En tant qu'** utilisateur ou invité,
**je souhaite** consulter dans l'onglet « Mes contrats » la liste des contrats obligatoires (ex. Assurance Auto, Assurance Habitation, Assurance Emprunteur, Mutuelle santé),
**afin de** savoir quels contrats sont suivis dans MAAQ.

**Écran(s) maquette :** Contrats utilisateur / Contrats invité (onglet « Mes contrats »). **Dépendances :** US-48, US-33, US-36, US-67.

### Règles fonctionnelles

RF1 — L'onglet « Mes contrats » affiche tous les contrats obligatoires définis par l'administrateur (US-48), dans l'ordre qu'il a défini.

RF2 — Chaque contrat est présenté par une carte comprenant :
- le nom du contrat ;
- son état : « Non renseigné » ou « Renseigné — [N] document(s) » ;
- l'interrupteur de consentement (US-36) ;
- le bouton « Détails et documents › ».

RF3 — Le client ne peut ni ajouter ni retirer de contrat dans la liste.

RF4 — Les contrats et leurs informations sont partagés entre l'utilisateur principal et l'invité 1 (le noyau), qui voient les mêmes données. Les invités secondaires n'y ont pas accès (décision du 30/09/2026).

RF5 — Chaque carte renseignée indique la dernière modification : « Modifié par [prénom] le [date] ».

RF6 — Un contrat ajouté par l'administrateur apparaît pour tous les clients à l'état « Non renseigné ».

RF7 — Si la liste est vide, le message « Aucun contrat n'est suivi pour le moment » s'affiche.

RF8 — Pendant le chargement, des cartes d'attente s'affichent (CC-1).

RF9 — En cas d'erreur serveur, le message d'erreur standard s'affiche avec un bouton « Réessayer » (CC-2).

RF10 — En cas de délai dépassé, le message de connexion lente s'affiche avec un bouton « Réessayer » (CC-3).

RF11 — Si le Google Drive du compte n'est pas connecté (US-67), l'onglet « Mes contrats » affiche le bandeau « [prénom de l'utilisateur principal] doit connecter son Google Drive pour classer les documents ». Pour l'utilisateur principal, le bandeau propose un bouton « Connecter mon Google Drive » (décision du 30/09/2026). Le bouton « Connecter mon Google Drive » ouvre le parcours de US-67 (décision D14 du 01/10/2026).

### Règles techniques

RT1 — [backend] Les informations de contrats sont rattachées au compte de l'utilisateur principal et accessibles uniquement à l'utilisateur principal et l'invité 1 (le noyau) (décision du 30/09/2026).

RT2 — [backend] Les détails saisis des contrats (assureur, échéance…) sont enregistrés dans MAAQ, hébergé dans l'Union européenne. Les documents sont classés par Admin_Classify dans le Google Drive de l'utilisateur principal (décision du 30/09/2026).

### UX / Design

D'après la maquette : une carte par contrat avec l'interrupteur à droite et le bouton « Détails et documents › » en bas de carte.

**Impact maquette :** Ajustement — Bandeau « Google Drive non connecté », avec le bouton « Connecter mon Google Drive » pour l'utilisateur principal ; Mention « Modifié par [prénom] le [date] » ; État « Non renseigné » / « Renseigné — N document(s) ».

### Critères d'acceptance

**CA 1.1 — Liste définie par l'administrateur**
- Étant donné que l'administrateur a défini Assurance Auto, Assurance Habitation, Assurance Emprunteur et Mutuelle santé
- Quand j'ouvre l'onglet « Mes contrats »
- Alors je vois ces quatre contrats dans cet ordre

**CA 2.1 — Carte d'un contrat renseigné**
- Étant donné que la Mutuelle santé a 2 documents
- Quand j'affiche l'onglet
- Alors sa carte affiche « Renseigné — 2 document(s) », l'interrupteur et le bouton « Détails et documents › »

**CA 3.1 — Pas d'ajout de contrat**
- Étant donné que l'onglet « Mes contrats » est affiché
- Quand je le parcours
- Alors aucun bouton ne permet d'ajouter ou de retirer un contrat

**CA 4.1 — Données partagées**
- Étant donné que Camille a renseigné l'assureur de l'Assurance Auto
- Quand Thomas, invité 1, ouvre l'onglet « Mes contrats »
- Alors il voit l'Assurance Auto à l'état « Renseigné »

**CA 4.2 — Pas d'accès pour un invité secondaire**
- Étant donné qu'Élodie est invitée secondaire
- Quand elle navigue dans MAAQ
- Alors elle n'a accès à aucune information de contrat

**CA 5.1 — Dernière modification**
- Étant donné que Thomas a modifié l'Assurance Habitation le 12/10/2026
- Quand Camille affiche l'onglet
- Alors la carte indique « Modifié par Thomas le 12/10/2026 »

**CA 6.1 — Nouveau contrat**
- Étant donné que l'administrateur ajoute « Assurance Scolaire »
- Quand j'ouvre l'onglet
- Alors « Assurance Scolaire » apparaît à l'état « Non renseigné »

**CA 7.1 — Liste vide**
- Étant donné qu'aucun contrat obligatoire n'est défini
- Quand j'ouvre l'onglet
- Alors le message « Aucun contrat n'est suivi pour le moment » s'affiche

**CA 8.1 — Chargement**
- Étant donné que j'ouvre l'onglet
- Quand les contrats sont en cours de chargement
- Alors des cartes d'attente s'affichent

**CA 9.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand j'ouvre l'onglet
- Alors le message d'erreur standard s'affiche avec un bouton « Réessayer »

**CA 10.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand le chargement dépasse 15 secondes
- Alors le message de connexion lente s'affiche avec un bouton « Réessayer »

**CA 11.1 — Drive non connecté, vu par l'invité 1**
- Étant donné que Camille n'a pas connecté son Google Drive
- Quand Thomas ouvre l'onglet « Mes contrats »
- Alors le bandeau « Camille doit connecter son Google Drive pour classer les documents » s'affiche

**CA 11.2 — Drive non connecté, vu par l'utilisateur principal**
- Étant donné que Camille n'a pas connecté son Google Drive
- Quand elle ouvre l'onglet « Mes contrats »
- Alors le bandeau propose le bouton « Connecter mon Google Drive »

---

## US-33 — Renseigner les détails d'un contrat

**En tant qu'** utilisateur ou invité,
**je souhaite** renseigner les détails d'un contrat (nom de l'assureur…),
**afin que** MAAQ et les agents disposent des informations utiles sur mes contrats.

**Écran(s) maquette :** Contrats utilisateur / Contrats invité (bouton « Détails et documents › »). **Dépendances :** US-32, US-34, US-35.

### Règles fonctionnelles

RF1 — Le bouton « Détails et documents › » ouvre l'écran de détail du contrat.

RF2 — Les champs de chaque contrat sont définis par l'administrateur dans la console d'administration (US-48), avec leur type et leur caractère obligatoire ou facultatif (décision du 30/09/2026). Par exemple : nom de l'assureur, numéro de contrat, date d'échéance, montant de la cotisation.

RF3 — Les formats sont contrôlés selon le type de champ défini par l'administrateur : date valide, montant numérique positif, etc.

RF4 — Seuls l'utilisateur principal et l'invité 1 (le noyau) peuvent renseigner et modifier ces détails (décision du 30/09/2026).

RF5 — Après l'enregistrement, le message « Contrat mis à jour » s'affiche. Les détails sont visibles par tous les profils, et la carte passe à l'état « Renseigné ».

RF6 — Si deux profils modifient le même contrat en même temps, la dernière modification enregistrée est retenue.

RF7 — Les agents peuvent utiliser ces détails lorsqu'un profil les sollicite, indépendamment de l'interrupteur de consentement (US-36).

RF8 — Pendant l'enregistrement, le bouton « Enregistrer » affiche un indicateur de chargement et est désactivé (CC-1).

RF9 — En cas d'erreur serveur, le message d'erreur standard s'affiche et les informations saisies sont conservées (CC-2).

RF10 — En cas de délai dépassé, le message de connexion lente s'affiche et les informations saisies sont conservées (CC-3).

### Règles techniques

RT1 — [backend] Chaque modification est horodatée et rattachée au profil qui l'a faite.

RT2 — [backend] Les agents des Contrats lisent les documents directement dans le Google Drive de l'utilisateur principal. Les détails saisis leur sont fournis par MAAQ (décision du 30/09/2026).

### UX / Design

D'après la maquette : l'écran de détail présente les champs en haut et la liste des documents en dessous (US-34).

**Impact maquette :** Ajustement — Champs dynamiques définis par l'administrateur pour chaque contrat ; Erreurs de format.

### Critères d'acceptance

**CA 1.1 — Ouverture du détail**
- Étant donné que l'onglet « Mes contrats » est affiché
- Quand je touche « Détails et documents › » sur l'Assurance Auto
- Alors l'écran de détail de l'Assurance Auto s'affiche

**CA 2.1 — Assureur obligatoire**
- Étant donné que le champ assureur est vide
- Quand je renseigne uniquement le numéro de contrat
- Alors le bouton « Enregistrer » est inactif

**CA 3.1 — Montant invalide**
- Étant donné que je saisis « -50 » comme montant de cotisation
- Quand je quitte le champ
- Alors un message indique que le montant est invalide

**CA 4.1 — Modification par l'invité 1**
- Étant donné que je suis Thomas, invité 1
- Quand je renseigne l'assureur de la Mutuelle santé et enregistre
- Alors l'enregistrement réussit

**CA 4.2 — Invité secondaire sans accès**
- Étant donné que je suis Élodie, invitée secondaire
- Quand je navigue dans MAAQ
- Alors aucun écran ne me permet de renseigner les détails d'un contrat

**CA 5.1 — Enregistrement visible par tous**
- Étant donné que Thomas enregistre l'assureur de l'Assurance Habitation
- Quand Camille ouvre l'onglet « Mes contrats »
- Alors l'Assurance Habitation est à l'état « Renseigné » avec l'assureur saisi par Thomas

**CA 6.1 — Modifications concurrentes**
- Étant donné que Camille et Thomas modifient l'assureur du même contrat presque en même temps
- Quand Thomas enregistre après Camille
- Alors c'est l'assureur saisi par Thomas qui est conservé

**CA 7.1 — Utilisation par un agent sans consentement**
- Étant donné que l'interrupteur de consentement de la Mutuelle santé est désactivé
- Quand je demande à Contrat_Mutuelle de négocier ma cotisation
- Alors l'agent utilise les détails renseignés de la Mutuelle santé

**CA 8.1 — Chargement**
- Étant donné que je touche « Enregistrer »
- Quand l'enregistrement est en cours
- Alors un indicateur de chargement s'affiche et le bouton est désactivé

**CA 9.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand j'enregistre
- Alors le message d'erreur standard s'affiche et mes informations restent saisies

**CA 10.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand l'enregistrement dépasse 15 secondes
- Alors le message de connexion lente s'affiche et mes informations restent saisies

---

## US-34 — Ajouter les documents scannés d'un contrat

**En tant qu'** utilisateur ou invité,
**je souhaite** ajouter une ou plusieurs copies scannées des documents d'un contrat,
**afin de** les rendre disponibles pour MAAQ et les agents concernés.

**Écran(s) maquette :** Contrats utilisateur / Contrats invité (bouton « + Ajouter une copie scannée », avec note de format et de taille). **Dépendances :** US-33, US-35.

### Règles fonctionnelles

RF1 — Le bouton « + Ajouter une copie scannée » propose deux choix : « Prendre une photo » ou « Choisir un fichier ».

RF2 — Les formats acceptés sont jpeg, jpg, gif et pdf, avec une taille maximale par document réglée par l'administrateur (15 Mo par défaut, US-65) (décision D17 du 01/10/2026). Cette règle est rappelée sous le bouton.

RF3 — Un fichier d'un autre format est refusé avec le message « Format non accepté. Formats possibles : jpeg, jpg, gif, pdf. ».

RF4 — Un fichier qui dépasse la taille maximale est refusé avec le message « Ce document dépasse [N] Mo. », N étant la taille maximale en vigueur.

RF5 — Plusieurs documents peuvent être associés à un même contrat, dans la limite du nombre de documents par contrat réglé par l'administrateur (20 par défaut, US-65) (décision D17 du 01/10/2026). Au-delà, le message « Ce contrat a atteint le nombre maximum de documents ([N]). » s'affiche.

RF6 — Chaque document ajouté apparaît dans la liste avec son nom, sa date d'ajout et le prénom du profil qui l'a ajouté. Il est consultable en aperçu par l'utilisateur principal et l'invité 1 (le noyau).

RF7 — Pendant l'envoi, une barre de progression s'affiche avec un bouton « Annuler » (CC-1).

RF8 — En cas d'erreur serveur, le message « L'envoi du document a échoué » s'affiche avec un bouton « Réessayer », et le document n'est pas ajouté (CC-2).

RF9 — Si l'envoi ne progresse plus pendant 30 secondes, le message de connexion lente s'affiche avec un bouton « Réessayer », et le document n'est pas ajouté (CC-3).

RF10 — L'envoi se poursuit en arrière-plan si le profil quitte l'écran de détail du contrat, tant que l'application reste ouverte (CC-10). À la fin, un message « Document ajouté à [contrat] » s'affiche, quel que soit l'écran en cours.

RF11 — Après une courte coupure réseau, l'envoi reprend automatiquement là où il s'était arrêté, jusqu'à 3 fois, avant d'afficher l'erreur de RF8.

RF12 — Le classement des documents dans le Google Drive est confié à l'agent Admin_Classify (décision du 30/09/2026). Pour chaque document ajouté, l'agent vérifie d'abord si le document a déjà été classé dans le Drive. S'il l'a déjà été, il ne le classe pas une seconde fois. Sinon, il le classe dans le Drive.

RF13 — Chaque document du contrat porte une pastille d'état : « Classement en cours » tant que l'agent n'a pas terminé, puis « Document disponible » une fois le document trouvé ou classé dans le Drive (décision du 30/09/2026). Le classement est asynchrone (CC-10) : le profil peut quitter l'écran.

RF14 — Si le classement échoue (Drive non connecté, erreur ou délai dépassé), le document porte la pastille « Classement impossible » avec un bouton « Réessayer ». Le classement est d'abord réessayé automatiquement 3 fois (CC-5, CC-2, CC-3).

### Règles techniques

RT1 — [backend] Les documents sont stockés dans le Google Drive du compte (US-67), établi par l'utilisateur principal, où ils sont classés par un agent (décision du 30/09/2026). Admin_Classify utilise la connexion Google Drive de l'utilisateur principal, y compris pour les documents ajoutés par l'invité 1 (décision du 30/09/2026). L'arborescence de classement est celle de l'agent [À CONFIRMER avec Digitorn].

RT2 — [backend] Chaque document est analysé contre les logiciels malveillants avant d'être rendu disponible.

RT3 — [backend] Le format et la taille sont vérifiés aussi côté serveur, pas seulement sur le téléphone. La taille maximale et le nombre maximal de documents lus sont ceux des réglages de la console.

### UX / Design

D'après la maquette : le bouton « + Ajouter une copie scannée », la mention des formats et de la taille, puis la liste des documents sous forme de vignettes.

**Impact maquette :** Ajustement — Messages de taille et de nombre maximum avec les valeurs en vigueur ; Pastilles d'état des documents : « Classement en cours », « Document disponible », « Classement impossible » avec « Réessayer » ; Choix « Prendre une photo » / « Choisir un fichier » ; Barre de progression avec « Annuler » ; Messages d'erreur de format, de taille et d'envoi ; Message de fin d'envoi en arrière-plan.

### Critères d'acceptance

**CA 1.1 — Choix de la source**
- Étant donné que je suis sur le détail de l'Assurance Auto
- Quand je touche « + Ajouter une copie scannée »
- Alors les choix « Prendre une photo » et « Choisir un fichier » s'affichent

**CA 2.1 — Document accepté**
- Étant donné que je choisis un pdf de 3 Mo
- Quand l'envoi se termine
- Alors le document apparaît dans la liste

**CA 2.2 — Taille maximale modifiée par l'administrateur**
- Étant donné que l'administrateur a réglé la taille maximale à 10 Mo
- Quand je choisis un pdf de 12 Mo
- Alors le message « Ce document dépasse 10 Mo. » s'affiche

**CA 3.1 — Format refusé**
- Étant donné que je choisis un fichier au format Word
- Quand je le valide
- Alors le message « Format non accepté. Formats possibles : jpeg, jpg, gif, pdf. » s'affiche

**CA 4.1 — Taille dépassée**
- Étant donné que je choisis un pdf de 18 Mo
- Quand je le valide
- Alors le message « Ce document dépasse 15 Mo. » s'affiche, 15 étant la taille maximale en vigueur

**CA 5.1 — Plusieurs documents**
- Étant donné que le contrat a déjà 2 documents
- Quand j'en ajoute un troisième
- Alors la carte du contrat affiche « Renseigné — 3 document(s) »

**CA 5.2 — Nombre maximum de documents atteint**
- Étant donné que l'Assurance Auto a 20 documents et que le maximum est de 20
- Quand j'ajoute un document
- Alors le message « Ce contrat a atteint le nombre maximum de documents (20). » s'affiche

**CA 6.1 — Informations du document**
- Étant donné que Thomas a ajouté un document le 05/10/2026
- Quand Camille consulte la liste
- Alors elle voit le document avec la date du 05/10/2026 et la mention « Thomas »

**CA 7.1 — Progression et annulation**
- Étant donné que l'envoi d'un document est en cours
- Quand je touche « Annuler »
- Alors l'envoi s'arrête et le document n'est pas ajouté

**CA 8.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand j'envoie un document
- Alors le message « L'envoi du document a échoué » s'affiche avec un bouton « Réessayer »

**CA 9.1 — Envoi bloqué**
- Étant donné que le réseau est coupé pendant l'envoi
- Quand l'envoi ne progresse plus pendant 30 secondes
- Alors le message de connexion lente s'affiche avec un bouton « Réessayer »

**CA 10.1 — Envoi en arrière-plan**
- Étant donné qu'un document est en cours d'envoi
- Quand je retourne sur mon dashboard
- Alors l'envoi se poursuit
- Et le message « Document ajouté à Assurance Auto » s'affiche à la fin

**CA 11.1 — Reprise après micro-coupure**
- Étant donné qu'un document est en cours d'envoi
- Quand le réseau est coupé 5 secondes puis revient
- Alors l'envoi reprend automatiquement sans message d'erreur

**CA 12.1 — Document non encore classé**
- Étant donné que Thomas ajoute l'attestation de l'Assurance Auto
- Quand l'agent de classement constate qu'elle n'est pas encore dans le Drive
- Alors il la classe dans le Google Drive de Camille

**CA 12.2 — Document déjà classé**
- Étant donné que l'attestation de l'Assurance Auto est déjà classée dans le Drive
- Quand Camille ajoute de nouveau ce document
- Alors l'agent ne crée pas de doublon dans le Drive

**CA 13.1 — Pastille pendant le classement**
- Étant donné que je viens d'ajouter un document
- Quand l'agent n'a pas encore terminé le classement
- Alors le document porte la pastille « Classement en cours »

**CA 13.2 — Pastille « Document disponible »**
- Étant donné que l'agent a classé le document ou l'a trouvé déjà classé
- Quand je consulte le contrat
- Alors le document porte la pastille « Document disponible »

**CA 14.1 — Échec du classement**
- Étant donné que le Google Drive de Camille n'est plus connecté
- Quand l'agent tente de classer un document
- Alors le document porte la pastille « Classement impossible » avec un bouton « Réessayer »

---

## US-35 — Modifier ou supprimer les détails et documents d'un contrat

**En tant qu'** utilisateur ou invité,
**je souhaite** modifier ou supprimer les détails et documents que j'ai renseignés pour un contrat,
**afin de** garder ces informations à jour.

**Écran(s) maquette :** Contrats utilisateur / Contrats invité (bouton « Supprimer les détails et documents »). **Dépendances :** US-33, US-34.

### Règles fonctionnelles

RF1 — Les détails d'un contrat se modifient depuis l'écran de détail, selon les règles de US-33.

RF2 — Chaque document peut être retiré individuellement du contrat, après la confirmation « Retirer ce document du contrat ? Il restera dans le Google Drive de [prénom de l'utilisateur principal]. ».

RF3 — Le bouton « Supprimer les détails et documents » ouvre la confirmation « Supprimer tous les détails et documents de ce contrat ? Les documents resteront dans le Google Drive de [prénom de l'utilisateur principal]. ». À la confirmation, tous les champs sont vidés, tous les documents sont supprimés, et le contrat reste dans la liste à l'état « Non renseigné ».

RF4 — L'utilisateur principal et l'invité 1 peuvent modifier ou supprimer les détails et documents, y compris ceux ajoutés par l'autre (décision du 30/09/2026).

RF5 — La suppression complète remet l'interrupteur de consentement (US-36) à « désactivé ».

RF6 — Pendant la suppression, un indicateur de chargement s'affiche sur le bouton de confirmation (CC-1).

RF7 — En cas d'erreur serveur, le message d'erreur standard s'affiche et rien n'est supprimé (CC-2).

RF8 — En cas de délai dépassé, le message de connexion lente s'affiche et rien n'est supprimé (CC-3).

### Règles techniques

RT1 — [backend] Les documents retirés d'un contrat ne sont pas effacés : ils restent stockés dans le Google Drive de l'utilisateur principal. Le retrait supprime seulement le lien entre le document et le contrat dans MAAQ (décision du 30/09/2026).

RT2 — [backend] La suppression complète est tout ou rien : soit tout est supprimé, soit rien.

### UX / Design

D'après la maquette : le bouton « Supprimer les détails et documents » est affiché en rouge en bas de l'écran de détail. Chaque vignette de document porte une icône de suppression.

**Impact maquette :** Ajustement — Action « Retirer » sur chaque document ; Mention « Le document restera dans le Google Drive de [prénom] » dans les confirmations.

### Critères d'acceptance

**CA 1.1 — Modification d'un détail**
- Étant donné que l'assureur de l'Assurance Auto est renseigné
- Quand je le modifie et enregistre
- Alors le nouvel assureur est affiché

**CA 2.1 — Suppression d'un document**
- Étant donné que la Mutuelle santé a 3 documents
- Quand je supprime l'un d'eux et confirme
- Alors il en reste 2

**CA 3.1 — Suppression complète**
- Étant donné que l'Assurance Auto a des détails et 2 documents
- Quand je touche « Supprimer les détails et documents » et confirme
- Alors l'Assurance Auto reste dans la liste à l'état « Non renseigné », sans aucun document

**CA 3.2 — Annulation**
- Étant donné que la confirmation de suppression complète est affichée
- Quand je touche « Annuler »
- Alors aucun détail ni document n'est supprimé

**CA 4.1 — Suppression d'un document ajouté par un autre profil**
- Étant donné que Thomas a ajouté un document à l'Assurance Habitation
- Quand Camille retire ce document
- Alors le document n'apparaît plus dans le contrat pour Camille et Thomas
- Et il est toujours présent dans le Google Drive de Camille

**CA 5.1 — Consentement remis à zéro**
- Étant donné que l'interrupteur de consentement de l'Assurance Auto est activé
- Quand je supprime tous ses détails et documents
- Alors l'interrupteur est désactivé

**CA 6.1 — Chargement**
- Étant donné que j'ai confirmé la suppression
- Quand elle est en cours
- Alors un indicateur de chargement s'affiche

**CA 7.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand je confirme la suppression complète
- Alors le message d'erreur standard s'affiche et les détails et documents sont toujours présents

**CA 8.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand la suppression dépasse 15 secondes
- Alors le message de connexion lente s'affiche et rien n'est supprimé

---

## US-36 — Donner ou retirer mon consentement au challenge d'un contrat

**En tant qu'** utilisateur ou invité,
**je souhaite** activer ou désactiver, via un bouton on/off devant chaque contrat, le consentement donné à MAAQ pour challenger les détails renseignés,
**afin de** garder la maîtrise de ce que MAAQ peut analyser.

**Écran(s) maquette :** Contrats utilisateur / Contrats invité (interrupteur on/off sur chaque carte de contrat). **Dépendances :** US-32, US-33.

### Règles fonctionnelles

RF1 — Chaque carte de contrat affiche un interrupteur de consentement, désactivé par défaut.

RF2 — L'activation ouvre une confirmation. Elle affiche le texte « L'entreprise [nom du partenaire], partenaire de MAAQ, pourra utiliser les informations de votre contrat pour le challenger. » et propose « J'accepte » et « Annuler ». La désactivation est immédiate, sans confirmation (décision du 30/09/2026) [À CONFIRMER avec PM : nom du partenaire, à venir].

RF3 — L'état de l'interrupteur est partagé : l'utilisateur principal et l'invité 1 (le noyau) voient le même état, et tous deux peuvent le modifier (décision du 30/09/2026). Sous l'interrupteur, la mention « Activé par [prénom] le [date] » ou « Désactivé par [prénom] le [date] » s'affiche.

RF4 — Le consentement ne conditionne que le challenge par MAAQ. Un agent sollicité par un profil peut utiliser le contrat, quel que soit l'état de l'interrupteur.

RF5 — Aucune restitution du résultat du challenge n'est prévue en V1.

RF6 — L'interrupteur est actif même si le contrat n'est pas renseigné.

RF7 — Pendant l'enregistrement, l'interrupteur affiche un indicateur de chargement et ne peut pas être touché de nouveau (CC-1).

RF8 — En cas d'erreur serveur, l'interrupteur revient à son état précédent et le message d'erreur standard s'affiche (CC-2).

RF9 — En cas de délai dépassé, l'interrupteur revient à son état précédent et le message de connexion lente s'affiche (CC-3).

RF10 — La preuve d'un consentement reste établie après la suppression du compte du consentant, sans que son email soit conservé en clair (décision D13 du 01/10/2026).

### Règles techniques

RT1 — [backend] Chaque activation et chaque désactivation est enregistrée comme preuve du consentement, avec le profil, la date, l'heure et la version du texte accepté. Le journal conserve aussi une empreinte de l'email du consentant, pour établir son identité après la suppression du compte, sans conserver l'email en clair (décision D13 du 01/10/2026) [À CONFIRMER avec DPO : valeur probante d'une preuve par empreinte]. Proposition du BA : l'enregistrement est fait dans un journal des consentements de la base MAAQ, hébergée dans l'Union européenne, distinct du Google Drive de l'utilisateur. Il est conservé pendant toute la durée du compte, puis 5 ans après la fin de l'abonnement, durée de prescription permettant de prouver le consentement (proposition validée par le PM le 30/09/2026).

RT2 — [backend] Le traitement de challenge ne s'applique qu'aux contrats dont le consentement est actif au moment du traitement.

### UX / Design

D'après la maquette : un interrupteur à droite du nom du contrat. Le texte de la confirmation reste à rédiger.

**Impact maquette :** Nouvel écran — Fenêtre de consentement avec le texte validé (« L'entreprise [nom du partenaire], partenaire de MAAQ, pourra utiliser les informations de votre contrat pour le challenger. ») ; Mention « Activé par [prénom] le [date] ».

### Critères d'acceptance

**CA 1.1 — Désactivé par défaut**
- Étant donné que personne n'a encore touché l'interrupteur de l'Assurance Auto
- Quand j'affiche l'onglet « Mes contrats »
- Alors l'interrupteur de l'Assurance Auto est désactivé

**CA 2.1 — Activation avec confirmation**
- Étant donné que l'interrupteur est désactivé
- Quand je l'active et touche « J'accepte »
- Alors l'interrupteur est activé

**CA 2.2 — Activation annulée**
- Étant donné que la confirmation d'activation est affichée
- Quand je touche « Annuler »
- Alors l'interrupteur reste désactivé

**CA 2.3 — Désactivation immédiate**
- Étant donné que l'interrupteur est activé
- Quand je le désactive
- Alors il est désactivé sans confirmation

**CA 3.1 — État partagé**
- Étant donné que Thomas a activé le consentement de la Mutuelle santé le 10/10/2026
- Quand Camille affiche l'onglet « Mes contrats »
- Alors l'interrupteur de la Mutuelle santé est activé avec la mention « Activé par Thomas le 10/10/2026 »

**CA 4.1 — Agent sollicité sans consentement**
- Étant donné que le consentement de l'Assurance Auto est désactivé
- Quand je sollicite Contrat_Auto au sujet de mon contrat
- Alors l'agent utilise les détails du contrat

**CA 5.1 — Pas de restitution**
- Étant donné que le consentement est activé
- Quand je consulte le contrat
- Alors aucun résultat de challenge n'est affiché

**CA 6.1 — Contrat non renseigné**
- Étant donné que l'Assurance Emprunteur n'est pas renseignée
- Quand j'active son interrupteur et accepte
- Alors l'interrupteur est activé

**CA 7.1 — Chargement**
- Étant donné que je viens de toucher l'interrupteur
- Quand l'enregistrement est en cours
- Alors un indicateur de chargement s'affiche sur l'interrupteur

**CA 8.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand j'active l'interrupteur
- Alors il revient à l'état désactivé et le message d'erreur standard s'affiche

**CA 9.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand l'enregistrement dépasse 15 secondes
- Alors l'interrupteur revient à son état précédent et le message de connexion lente s'affiche

**CA 10.1 — Preuve après suppression du compte**
- Étant donné que le compte de Camille a été supprimé
- Quand l'équipe MAAQ consulte la preuve de consentement de Camille
- Alors elle peut établir que l'email de Camille correspond au consentement enregistré, sans que l'email figure en clair

---

# Module F — Utilisation des agents IA

## US-37 — Accéder rapidement au tchat d'un agent

**En tant qu'** utilisateur ou invité,
**je souhaite** ouvrir le tchat d'un agent de mon dashboard ou de la page Contrats en un minimum d'étapes,
**afin de** solliciter l'agent le plus vite possible.

**Écran(s) maquette :** Dashboard utilisateur / invité (lien « Ouvrir le tchat ») → Tchat. **Dépendances :** US-22, US-31, US-29, US-42, US-41, US-60.

### Règles fonctionnelles

RF1 — Depuis le dashboard ou l'onglet « Agents des Contrats », toucher la carte d'un agent ou son lien « Ouvrir le tchat » ouvre directement le tchat. Après le déverrouillage, le tchat d'un agent est donc accessible en 1 toucher depuis le dashboard.

RF2 — Le tchat affiche :
- en en-tête : le nom de l'agent et un bouton retour ;
- le bandeau d'information IA (US-60) ;
- l'historique des échanges, ou l'état d'accueil s'il n'y en a pas (US-41) ;
- la zone de saisie.

RF3 — Si l'agent n'est pas configuré, le tchat affiche l'écran informatif de US-29. S'il est bloqué, il affiche la bannière de US-42.

RF4 — Le bouton retour ramène à l'onglet d'origine (Pro, Perso ou Agents des Contrats).

RF5 — Un raccourci dans l'en-tête du tchat donne accès aux connecteurs de l'agent.

RF6 — Pendant le chargement de l'historique, un indicateur s'affiche dans la zone des messages, et la zone de saisie est déjà utilisable (CC-1).

RF7 — En cas d'erreur serveur, le message d'erreur standard s'affiche dans la zone des messages avec un bouton « Réessayer » (CC-2).

RF8 — En cas de délai dépassé, le message de connexion lente s'affiche avec un bouton « Réessayer » (CC-3).

### Règles techniques

RT1 — [frontend] Le tchat s'affiche en moins de 2 secondes sur un réseau mobile standard.

RT2 — [backend] L'historique du tchat est fourni par Digitorn.

### UX / Design

D'après la maquette : l'en-tête contient le nom de l'agent, le bandeau IA est placé juste en dessous, et la zone de saisie est fixée en bas de l'écran.

**Impact maquette :** Ajustement — Raccourci vers les connecteurs dans l'en-tête du tchat.

### Critères d'acceptance

**CA 1.1 — Ouverture en un toucher**
- Étant donné que je suis sur mon dashboard
- Quand je touche la carte d'Admin_lib
- Alors le tchat d'Admin_lib s'affiche

**CA 2.1 — Contenu du tchat**
- Étant donné que j'ouvre le tchat d'Admin_lib
- Quand il s'affiche
- Alors je vois le nom Admin_lib, le bandeau d'information IA, l'historique ou l'état d'accueil, et la zone de saisie

**CA 3.1 — Agent non configuré**
- Étant donné qu'Admin_lib est « À configurer »
- Quand j'ouvre son tchat
- Alors l'écran informatif listant ce qui manque s'affiche

**CA 4.1 — Retour à l'onglet d'origine**
- Étant donné que j'ai ouvert Contrat_Auto depuis l'onglet « Agents des Contrats »
- Quand je touche le bouton retour
- Alors l'onglet « Agents des Contrats » s'affiche

**CA 5.1 — Accès aux connecteurs**
- Étant donné que le tchat d'Admin_lib est affiché
- Quand je touche le raccourci des connecteurs
- Alors l'onglet Admin_lib de l'écran Connecteurs s'affiche

**CA 6.1 — Chargement de l'historique**
- Étant donné que j'ouvre un tchat
- Quand l'historique est en cours de chargement
- Alors un indicateur s'affiche et je peux déjà saisir un message

**CA 7.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand j'ouvre un tchat
- Alors le message d'erreur standard s'affiche avec un bouton « Réessayer »

**CA 8.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand le chargement dépasse 15 secondes
- Alors le message de connexion lente s'affiche avec un bouton « Réessayer »

---

## US-38 — Demander à un agent de réaliser une action

**En tant qu'** utilisateur ou invité,
**je souhaite** formuler une demande à un agent dans son tchat dédié,
**afin qu'** il réalise la tâche correspondante (classement de document, prise de rendez-vous…).

**Écran(s) maquette :** Tchat. **Dépendances :** US-10, US-11, US-13, US-16, US-17, US-39, US-40. **Décisions appliquées :** D1, D2, D4.

### Règles fonctionnelles

RF1 — La zone de saisie accepte un texte de 2 000 caractères au maximum. Le bouton « Envoyer » est inactif tant que la zone est vide.

RF2 — Le message envoyé s'affiche immédiatement dans le fil avec l'état « Envoi… », puis « Envoyé ».

RF3 — Pendant le traitement, l'indicateur « [Agent] réfléchit… » s'affiche sous le message.

RF4 — L'agent reçoit, comme contexte de la demande :
- les informations du profil demandeur pour cet agent (US-10) ;
- ses connecteurs et sa boîte de validation ;
- son rang (utilisateur principal, invité 1 ou invité secondaire) ;
- les adresses en copie applicables (US-16, US-17).

RF5 — Les actions sont réalisées avec les comptes Google du profil demandeur. Un rendez-vous demandé par Thomas est créé dans l'agenda de Thomas.

RF6 — Pour les rendez-vous, l'agent applique les participants automatiques de la décision D2 :
- une demande de l'utilisateur principal inclut l'invité 1 ;
- une demande de l'invité 1 inclut l'utilisateur principal ;
- une demande d'un invité secondaire inclut l'utilisateur principal et l'invité 1.

RF7 — Pour une demande du noyau, l'agent n'ajoute un invité secondaire que si le demandeur le nomme dans sa demande. Il peut aussi proposer de l'ajouter, et ne le fait qu'après validation du demandeur (US-39).

RF8 — Si l'agent ne peut pas réaliser la demande, il répond en expliquant pourquoi et ce que le profil peut faire.

RF9 — La demande et son résultat apparaissent dans le carnet de bord après la prochaine synchronisation avec Digitorn (décision D4, US-40). Ils n'y figurent pas immédiatement.

RF10 — En cas d'erreur serveur à l'envoi, le message est marqué « Non envoyé » avec un bouton « Réessayer », et le texte n'est pas perdu (CC-2).

RF11 — Si l'agent n'a pas répondu après 30 secondes, le message « [Agent] met plus de temps que prévu… » remplace l'indicateur. Si aucune réponse n'arrive après 2 minutes, le message « L'agent n'a pas pu répondre. Réessayez. » s'affiche avec un bouton « Réessayer » (CC-3) [À CONFIRMER avec Digitorn].

RF12 — Si la connexion est perdue pendant le traitement, la réponse de l'agent s'affiche au retour de la connexion si elle est disponible (CC-4).

RF13 — Le traitement d'une demande est asynchrone (CC-10). Si le profil quitte le tchat ou ferme l'application, l'agent poursuit le traitement. À son retour, la réponse est affichée dans le tchat (décision D22 du 01/10/2026).

RF14 — Un message envoyé sans connexion est placé en attente, avec l'état « En attente de connexion ». Il est envoyé automatiquement au retour de la connexion, s'il a été rédigé depuis moins de 10 minutes. Au-delà, il passe à l'état « Non envoyé », avec un bouton « Réessayer ».

RF15 — Chaque demande est comptée dans le plafond quotidien du profil. Au-delà du plafond, la demande n'est pas envoyée (US-70) (décision D20 du 01/10/2026).

### Règles techniques

RT1 — [backend] Les échanges avec l'agent passent par Digitorn. Le contexte transmis est chiffré entre MAAQ et Digitorn (décision du 29/09/2026).

RT2 — [backend] Un message renvoyé après une erreur ne doit pas provoquer deux exécutions de la même demande.

RT3 — [frontend] La réponse de l'agent s'affiche au fur et à mesure de sa rédaction, si Digitorn le permet.

### UX / Design

D'après la maquette : les messages du profil sont alignés à droite, ceux de l'agent à gauche. La zone de saisie et le bouton « Envoyer » sont fixés en bas de l'écran.

**Impact maquette :** Ajustement — Retrait du badge « Nouvelle réponse » ; États des messages (voir MT-3) ; Compteur de caractères.

### Critères d'acceptance

**CA 1.1 — Envoi impossible si vide**
- Étant donné que la zone de saisie est vide
- Quand je regarde le bouton « Envoyer »
- Alors il est inactif

**CA 1.2 — Texte trop long**
- Étant donné que j'ai saisi 2 000 caractères
- Quand je tente d'en saisir davantage
- Alors la saisie est bloquée et un compteur indique la limite atteinte

**CA 2.1 — Affichage immédiat**
- Étant donné que je saisis « Prends RDV chez le dentiste mardi à 14 h »
- Quand je touche « Envoyer »
- Alors mon message apparaît dans le fil avec l'état « Envoi… » puis « Envoyé »

**CA 3.1 — Indicateur de traitement**
- Étant donné que mon message est envoyé
- Quand Admin_lib traite la demande
- Alors l'indicateur « Admin_lib réfléchit… » s'affiche

**CA 4.1 — Utilisation du contexte**
- Étant donné que Camille a renseigné son adresse postale
- Quand elle demande un rendez-vous à domicile
- Alors l'agent utilise son adresse sans la lui demander

**CA 5.1 — Agenda du demandeur**
- Étant donné que Thomas a connecté son agenda à Admin_lib
- Quand il demande un rendez-vous
- Alors le rendez-vous est créé dans l'agenda de Thomas

**CA 6.1 — Demande de l'utilisateur principal**
- Étant donné que Thomas est l'invité 1 de Camille
- Quand Camille demande un rendez-vous à Admin_lib
- Alors Thomas figure parmi les participants

**CA 6.2 — Demande de l'invité 1**
- Étant donné que Thomas est l'invité 1 de Camille
- Quand Thomas demande un rendez-vous à Admin_lib
- Alors Camille figure parmi les participants

**CA 6.3 — Demande d'un invité secondaire**
- Étant donné qu'Élodie est invitée secondaire
- Quand Élodie demande un rendez-vous à Admin_lib
- Alors Camille et Thomas figurent parmi les participants

**CA 7.1 — Invité secondaire non nommé**
- Étant donné qu'Élodie est invitée secondaire
- Quand Thomas demande un rendez-vous sans nommer Élodie
- Alors Élodie ne figure pas parmi les participants, sauf si Thomas valide la proposition de l'agent de l'ajouter

**CA 8.1 — Demande impossible**
- Étant donné qu'Admin_lib ne peut pas classer de document
- Quand je lui demande de classer une facture
- Alors il explique qu'il ne peut pas réaliser cette demande et ce que je peux faire

**CA 9.1 — Carnet après synchronisation**
- Étant donné que je viens de faire une demande à Admin_lib
- Quand j'ouvre son carnet avant la prochaine synchronisation
- Alors la demande n'y figure pas encore
- Et la date de dernière mise à jour du carnet est affichée

**CA 10.1 — Erreur d'envoi**
- Étant donné que le serveur est indisponible
- Quand j'envoie un message
- Alors le message est marqué « Non envoyé » avec un bouton « Réessayer »

**CA 11.1 — Réponse lente**
- Étant donné que j'ai envoyé une demande
- Quand l'agent n'a pas répondu après 30 secondes
- Alors le message « Admin_lib met plus de temps que prévu… » s'affiche

**CA 11.2 — Absence de réponse**
- Étant donné que j'ai envoyé une demande
- Quand l'agent n'a pas répondu après 2 minutes
- Alors le message « L'agent n'a pas pu répondre. Réessayez. » s'affiche avec un bouton « Réessayer »

**CA 12.1 — Perte de connexion**
- Étant donné que ma connexion est coupée pendant le traitement
- Quand elle revient
- Alors la réponse de l'agent s'affiche si elle est disponible

**CA 13.1 — Réponse retrouvée après avoir quitté le tchat**
- Étant donné que j'ai envoyé une demande à Admin_lib puis fermé l'application
- Quand je rouvre le tchat d'Admin_lib après la réponse de l'agent
- Alors la réponse est affichée dans le tchat d'Admin_lib

**CA 14.1 — Message envoyé hors connexion**
- Étant donné que je n'ai plus de connexion
- Quand j'envoie un message à Admin_lib
- Alors le message affiche l'état « En attente de connexion »
- Et il est envoyé automatiquement quand la connexion revient dans les 10 minutes

**CA 14.2 — Attente trop longue**
- Étant donné qu'un message est en attente de connexion depuis 10 minutes
- Quand la connexion n'est toujours pas revenue
- Alors le message passe à l'état « Non envoyé » avec un bouton « Réessayer »

**CA 15.1 — Demande au-delà du plafond**
- Étant donné que Camille a atteint son plafond quotidien de demandes
- Quand elle envoie une demande à Admin_lib
- Alors la demande n'est pas envoyée et le message de plafond atteint s'affiche (US-70)

---

## US-39 — Valider une action proposée par l'agent

**En tant qu'** utilisateur ou invité,
**je souhaite** pouvoir valider (ou refuser) une action que l'agent me propose avant qu'elle ne soit exécutée,
**afin de** garder le contrôle sur les actions sensibles réalisées en mon nom.

**Écran(s) maquette :** Tchat (carte « Action proposée — validation requise », boutons Valider / Refuser). **Dépendances :** US-38, US-40, US-15.

### Règles fonctionnelles

RF1 — Lorsqu'une action nécessite une validation, l'agent affiche une carte « Action proposée — validation requise ». La carte récapitule le type d'action, la date et l'heure, le lieu, les participants, et le destinataire s'il y en a un.

RF2 — Le bouton « Valider » déclenche l'exécution. La carte passe à l'état « Validée — exécutée ».

RF3 — Le bouton « Refuser » annule l'action sans l'exécuter. La carte passe à l'état « Refusée » et l'agent propose de modifier la demande.

RF4 — Une fois la décision prise, les boutons disparaissent de la carte, qui ne peut plus être modifiée.

RF5 — Seul le profil qui a fait la demande peut valider ou refuser l'action.

RF6 — Les actions soumises à validation sont définies pour chaque agent lors de sa mise à disposition, et affichées sur sa fiche (US-24).

RF7 — La proposition d'ajouter un invité secondaire à un rendez-vous du noyau (décision D2) est une action soumise à validation.

RF8 — Une carte sans décision reste en attente jusqu'à l'effacement de l'historique du tchat (US-43, US-44). Elle est alors abandonnée sans exécution.

RF9 — La décision (validée ou refusée), son auteur et son horodatage sont enregistrés dans le carnet de bord (US-40).

RF10 — Pour l'envoi d'un email, le brouillon est également envoyé à la boîte de validation pour relecture (US-15). La validation se fait par cette carte, dans le tchat (décision du 30/09/2026).

RF11 — Pendant l'exécution, les boutons sont désactivés et la carte affiche « Exécution en cours… » (CC-1).

RF12 — En cas d'erreur serveur, la carte affiche « L'action n'a pas pu être exécutée » avec un bouton « Réessayer », et l'action n'est pas exécutée (CC-2).

RF13 — En cas de délai dépassé, la carte affiche « L'exécution prend plus de temps que prévu ». Le résultat final s'affiche dès qu'il est connu, sans nouvelle exécution (CC-3).

RF14 — L'exécution d'une action validée est asynchrone (CC-10). Si le profil quitte le tchat ou ferme l'application pendant l'exécution, celle-ci se poursuit. À son retour, la carte affiche le résultat final : « Validée — exécutée » ou « L'action n'a pas pu être exécutée ».

### Règles techniques

RT1 — [backend] Une action validée n'est exécutée qu'une seule fois, même en cas de double toucher ou de nouvel essai.

RT2 — [backend] La liste des actions soumises à validation est portée par la configuration de l'agent chez Digitorn.

### UX / Design

D'après la maquette : une carte encadrée dans le fil, avec le récapitulatif et deux boutons, « Valider » (principal) et « Refuser » (secondaire).

**Impact maquette :** Ajustement — États de la carte d'action (voir MT-4) ; Variante de carte pour valider l'envoi d'un email, avec l'objet, le destinataire et un aperçu du brouillon.

### Critères d'acceptance

**CA 1.1 — Affichage de la carte**
- Étant donné que je demande un rendez-vous chez le notaire
- Quand l'agent propose l'action
- Alors une carte « Action proposée — validation requise » récapitule la date, l'heure, le lieu et les participants

**CA 2.1 — Validation**
- Étant donné que la carte est affichée
- Quand je touche « Valider »
- Alors le rendez-vous est créé et la carte passe à l'état « Validée — exécutée »

**CA 3.1 — Refus**
- Étant donné que la carte est affichée
- Quand je touche « Refuser »
- Alors le rendez-vous n'est pas créé, la carte passe à l'état « Refusée » et l'agent propose de modifier la demande

**CA 4.1 — Carte figée**
- Étant donné que j'ai validé une action
- Quand je consulte la carte
- Alors les boutons « Valider » et « Refuser » ne sont plus affichés

**CA 5.1 — Réservé au demandeur**
- Étant donné qu'une action proposée à Thomas est en attente
- Quand Camille ouvre le tchat du même agent
- Alors la carte de Thomas ne lui est pas proposée

**CA 6.1 — Actions soumises à validation**
- Étant donné qu'Admin_lib exige une validation pour la création de rendez-vous
- Quand je consulte sa fiche
- Alors la création de rendez-vous figure parmi les actions soumises à validation

**CA 7.1 — Ajout d'un invité secondaire**
- Étant donné que Camille demande un rendez-vous concernant un dossier suivi par Élodie
- Quand l'agent propose d'ajouter Élodie
- Alors une carte de validation s'affiche, et Élodie n'est ajoutée qu'après la validation de Camille

**CA 8.1 — Carte abandonnée**
- Étant donné qu'une carte est restée en attente
- Quand l'historique du tchat est effacé
- Alors l'action n'est jamais exécutée

**CA 9.1 — Trace dans le carnet**
- Étant donné que j'ai validé une action
- Quand le carnet est synchronisé
- Alors l'entrée indique l'action, « Validée », mon prénom, la date et l'heure

**CA 10.1 — Envoi d'email**
- Étant donné qu'un agent doit envoyer un email en mon nom
- Quand il prépare l'email
- Alors le brouillon est envoyé à ma boîte de validation
- Et une carte de validation s'affiche dans le tchat

**CA 11.1 — Exécution en cours**
- Étant donné que j'ai touché « Valider »
- Quand l'exécution est en cours
- Alors la carte affiche « Exécution en cours… » et les boutons sont désactivés

**CA 12.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand je valide une action
- Alors la carte affiche « L'action n'a pas pu être exécutée » avec un bouton « Réessayer »

**CA 13.1 — Délai dépassé sans double exécution**
- Étant donné que l'exécution dépasse 15 secondes
- Quand le résultat devient disponible
- Alors la carte affiche le résultat
- Et l'action n'a été exécutée qu'une seule fois

**CA 14.1 — Résultat retrouvé après fermeture**
- Étant donné que j'ai validé une action puis fermé l'application pendant l'exécution
- Quand je rouvre le tchat
- Alors la carte affiche le résultat final de l'exécution

---

## US-40 — Consulter le carnet de bord d'un agent

**En tant qu'** utilisateur ou invité,
**je souhaite** consulter le carnet de bord d'un agent,
**afin de** voir l'historique des demandes et des actions réalisées, aussi bien les miennes que celles de la personne avec qui je partage cet agent.

**Écran(s) maquette :** Carnet de bord (filtre par agent, entrées attribuées à chaque personne). **Dépendances :** US-50, US-38, US-39, US-57. **Décisions appliquées :** D1, D3, D4.

### Règles fonctionnelles

RF1 — Le carnet de bord est accessible depuis Réglages > Carnet (US-50). Un sélecteur liste les agents pour lesquels le profil a au moins une entrée visible, y compris les agents retirés de son dashboard.

RF2 — Pour l'agent sélectionné, les entrées s'affichent de la plus récente à la plus ancienne. Chaque entrée indique :
- la date et l'heure ;
- le prénom de l'auteur ;
- le type : « Demande », « Action réalisée », « Action validée » ou « Action refusée » ;
- un résumé ;
- le résultat.

RF3 — La visibilité dépend du rang du profil (décision D3) :
- l'utilisateur principal et l'invité 1 voient toutes les entrées de l'agent pour le compte ;
- un invité secondaire voit ses propres entrées, ainsi que les demandes du noyau pour lesquelles il a été ajouté comme participant.

RF4 — Un profil du noyau voit les entrées de l'agent même s'il n'a pas lui-même ajouté cet agent.

RF5 — Le carnet est alimenté par une synchronisation avec Digitorn toutes les X heures (décision D4). En haut du carnet, la mention « Dernière mise à jour : [date et heure] » précise que les demandes récentes peuvent ne pas encore apparaître.

RF6 — Les entrées sont conservées pendant la durée de rétention du carnet (14 mois glissants par défaut, réglable par l'administrateur, US-65 décision D17 du 01/10/2026), puis supprimées automatiquement, y compris si l'agent a été retiré du dashboard.

RF7 — Le carnet est en lecture seule.

RF8 — Les entrées d'un invité supprimé sont affichées sans son nom (US-57).

RF9 — Les 20 entrées les plus récentes s'affichent d'abord. Un bouton « Voir plus » charge les 20 suivantes.

RF10 — Sans entrée pour l'agent, le message « Aucune entrée pour cet agent pour le moment. Les demandes apparaissent ici après la prochaine mise à jour. » s'affiche.

RF11 — Pendant le chargement, un indicateur de chargement s'affiche (CC-1).

RF12 — En cas d'erreur serveur, le message d'erreur standard s'affiche avec un bouton « Réessayer » (CC-2).

RF13 — En cas de délai dépassé, le message de connexion lente s'affiche avec un bouton « Réessayer » (CC-3).

### Règles techniques

RT1 — [backend] Le carnet est alimenté par l'interface de programmation (API) du carnet de bord de Digitorn, encore en cours de création. Sa livraison est annoncée sous 2 semaines, soit vers le 14/10/2026 (décision du 30/09/2026). Elle conditionne cette US.

RT2 — [backend] La synchronisation a lieu toutes les X heures. X vaut 5 heures par défaut et se règle dans la console d'administration (US-65) (décision du 30/09/2026).

RT3 — [backend] Une même demande récupérée plusieurs fois n'apparaît qu'une fois dans le carnet.

RT4 — [backend] Un échec de synchronisation est réessayé à la synchronisation suivante et signalé à l'administrateur par email. L'utilisateur voit la date de la dernière synchronisation réussie (décision du 30/09/2026).

RT5 — [backend] Le carnet conserve, pour chaque entrée, le demandeur et les participants, afin d'appliquer la règle de visibilité D3.

RT6 — [backend] Les entrées plus anciennes que la durée de rétention sont supprimées automatiquement chaque jour.

### UX / Design

D'après la maquette : un sélecteur d'agent en haut, puis une liste chronologique. Chaque entrée porte une pastille de couleur par personne. Le sélecteur d'agent est une liste déroulante dans laquelle on peut aussi saisir le nom de l'agent pour le trouver plus vite (décision du 30/09/2026). La mention de dernière mise à jour est un ajout à la maquette.

**Impact maquette :** Ajustement — Sélecteur d'agent en liste déroulante avec saisie pour filtrer ; Mention « Dernière mise à jour » ; Bouton « Voir plus » ; Entrées anonymisées ; État vide.

### Critères d'acceptance

**CA 1.1 — Sélecteur d'agents**
- Étant donné que j'ai des entrées pour Admin_lib et Admin_Classify
- Quand j'ouvre Réglages > Carnet
- Alors le sélecteur propose Admin_lib et Admin_Classify

**CA 1.2 — Agent retiré**
- Étant donné que j'ai retiré Admin_Classify de mon dashboard
- Quand j'ouvre le sélecteur
- Alors Admin_Classify y figure toujours

**CA 2.1 — Contenu d'une entrée**
- Étant donné que Thomas a demandé un rendez-vous le 14/10/2026 à 9 h 12
- Quand Camille consulte le carnet d'Admin_lib
- Alors elle voit une entrée « Demande » du 14/10/2026 à 9 h 12, par Thomas, avec un résumé et son résultat

**CA 3.1 — Noyau : tout est visible**
- Étant donné que Camille, Thomas et Élodie ont fait des demandes à Admin_lib
- Quand Thomas consulte le carnet d'Admin_lib
- Alors il voit les demandes des trois profils

**CA 3.2 — Invité secondaire : ses demandes**
- Étant donné qu'Élodie a fait une demande à Admin_lib
- Quand Élodie consulte le carnet d'Admin_lib
- Alors elle voit sa demande

**CA 3.3 — Invité secondaire : demandes où il participe**
- Étant donné que Camille a demandé un rendez-vous auquel Élodie a été ajoutée
- Quand Élodie consulte le carnet d'Admin_lib
- Alors elle voit la demande de Camille

**CA 3.4 — Invité secondaire : demandes non visibles**
- Étant donné que Thomas a demandé un rendez-vous sans Élodie
- Quand Élodie consulte le carnet d'Admin_lib
- Alors la demande de Thomas n'apparaît pas

**CA 4.1 — Agent non ajouté par un profil du noyau**
- Étant donné que Camille n'a pas ajouté Admin_Classify et que Thomas l'utilise
- Quand Camille ouvre Réglages > Carnet
- Alors Admin_Classify figure dans le sélecteur avec les demandes de Thomas

**CA 5.1 — Dernière mise à jour**
- Étant donné que la dernière synchronisation a eu lieu à 8 h
- Quand j'ouvre le carnet
- Alors la mention « Dernière mise à jour : [date] à 8 h 00 » s'affiche en haut

**CA 6.1 — Conservation de 14 mois**
- Étant donné qu'une entrée est plus ancienne que la durée de rétention du carnet
- Quand je consulte le carnet
- Alors cette entrée n'apparaît plus

**CA 6.2 — Durée modifiée par l'administrateur**
- Étant donné que l'administrateur a réglé la durée de rétention du carnet à 12 mois
- Quand je consulte le carnet
- Alors les entrées de plus de 12 mois n'apparaissent plus

**CA 7.1 — Lecture seule**
- Étant donné que le carnet est affiché
- Quand je consulte une entrée
- Alors aucune action de modification ou de suppression n'est proposée

**CA 8.1 — Invité supprimé**
- Étant donné que Julien a été supprimé
- Quand Camille consulte le carnet
- Alors les entrées de Julien s'affichent sans son nom

**CA 9.1 — Voir plus**
- Étant donné que le carnet d'Admin_lib contient 35 entrées
- Quand je touche « Voir plus »
- Alors les 15 entrées restantes s'affichent

**CA 10.1 — Carnet vide**
- Étant donné qu'Admin_lib n'a encore aucune entrée
- Quand je sélectionne Admin_lib
- Alors le message « Aucune entrée pour cet agent pour le moment. Les demandes apparaissent ici après la prochaine mise à jour. » s'affiche

**CA 11.1 — Chargement**
- Étant donné que je sélectionne un agent
- Quand les entrées sont en cours de chargement
- Alors un indicateur de chargement s'affiche

**CA 12.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand j'ouvre le carnet
- Alors le message d'erreur standard s'affiche avec un bouton « Réessayer »

**CA 13.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand le chargement dépasse 15 secondes
- Alors le message de connexion lente s'affiche avec un bouton « Réessayer »

---

## US-41 — Découvrir le tchat d'un agent sans historique

**En tant qu'** utilisateur ou invité,
**je souhaite** voir un état d'accueil clair quand j'ouvre le tchat d'un agent pour la première fois ou après expiration de l'historique,
**afin de** comprendre comment formuler ma première demande.

**Écran(s) maquette :** Tchat (état vide avec suggestions ; bouton de démonstration « Historique : présent / vide »). **Dépendances :** US-37, US-43, US-44.

### Règles fonctionnelles

RF1 — Un tchat sans historique affiche un état d'accueil : le nom de l'agent, une phrase présentant ce qu'il fait, et 3 suggestions de première demande.

RF2 — Toucher une suggestion insère son texte dans la zone de saisie. Le texte reste modifiable et n'est pas envoyé automatiquement.

RF3 — L'état d'accueil s'affiche au premier usage de l'agent, et après chaque perte d'historique (déconnexion, expiration à 4 jours, retrait de l'agent).

RF4 — L'état d'accueil disparaît dès l'envoi du premier message.

RF5 — Les suggestions sont propres à chaque agent et définies lors de sa mise à disposition (US-45).

RF6 — Le bandeau d'information IA (US-60) reste affiché au-dessus de l'état d'accueil.

RF7 — Pendant le chargement de l'état d'accueil, un indicateur de chargement s'affiche (CC-1).

RF8 — En cas d'erreur serveur, l'état d'accueil s'affiche sans suggestions, et la zone de saisie reste utilisable (CC-2).

RF9 — En cas de délai dépassé, l'état d'accueil s'affiche sans suggestions, avec un lien « Recharger les suggestions » (CC-3).

### Règles techniques

RT1 — [backend] Les textes de présentation et les suggestions sont saisis par l'administrateur, avec la fiche de l'agent.

### UX / Design

D'après la maquette : un état vide centré avec l'icône de l'agent, une phrase d'introduction et trois suggestions sous forme de pastilles cliquables. Le bouton de démonstration ne fait pas partie de l'interface réelle.

**Impact maquette :** Ajustement — Variante sans suggestions avec « Recharger les suggestions » ; Retirer le bouton de démonstration « Historique ».

### Critères d'acceptance

**CA 1.1 — Contenu de l'état d'accueil**
- Étant donné que je n'ai jamais utilisé Admin_lib
- Quand j'ouvre son tchat
- Alors je vois son nom, une phrase de présentation et 3 suggestions

**CA 2.1 — Suggestion insérée**
- Étant donné que l'état d'accueil est affiché
- Quand je touche la suggestion « Prendre un rendez-vous chez le médecin »
- Alors ce texte apparaît dans la zone de saisie, sans être envoyé

**CA 3.1 — Après une déconnexion**
- Étant donné que j'avais un historique avec Admin_lib et que je me suis déconnecté
- Quand je me reconnecte et ouvre son tchat
- Alors l'état d'accueil s'affiche

**CA 4.1 — Disparition au premier message**
- Étant donné que l'état d'accueil est affiché
- Quand j'envoie un message
- Alors l'état d'accueil disparaît et mon message s'affiche

**CA 5.1 — Suggestions propres à l'agent**
- Étant donné que j'ouvre successivement les tchats d'Admin_lib et d'Admin_Classify sans historique
- Quand je compare leurs états d'accueil
- Alors leurs suggestions sont différentes

**CA 6.1 — Bandeau IA visible**
- Étant donné que l'état d'accueil est affiché
- Quand je regarde le haut du tchat
- Alors le bandeau d'information IA est visible

**CA 7.1 — Chargement**
- Étant donné que j'ouvre un tchat sans historique
- Quand l'état d'accueil est en cours de chargement
- Alors un indicateur de chargement s'affiche

**CA 8.1 — Erreur serveur**
- Étant donné que le serveur ne fournit pas les suggestions
- Quand j'ouvre un tchat sans historique
- Alors l'état d'accueil s'affiche sans suggestions et je peux saisir un message

**CA 9.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand le chargement des suggestions dépasse 15 secondes
- Alors l'état d'accueil s'affiche avec le lien « Recharger les suggestions »

---

## US-42 — Être informé d'un accès agent bloqué

**En tant qu'** utilisateur ou invité,
**je souhaite** être averti explicitement quand l'accès à un agent est bloqué pendant que je l'utilise,
**afin de** comprendre pourquoi le tchat devient inaccessible.

**Écran(s) maquette :** Tchat (bannière de blocage, bouton de démonstration « Bloquer / Débloquer ») ; Dashboard utilisateur / invité (badge « Bloqué » sur Admin_lib). **Dépendances :** US-46, US-47.

### Règles fonctionnelles

RF1 — Lorsque l'administrateur bloque un agent (US-46), le tchat ouvert de cet agent devient inaccessible dans un délai de 30 secondes au maximum. Une bannière affiche le message de maintenance saisi par l'administrateur, et la zone de saisie est désactivée.

RF2 — L'historique reste visible en lecture pendant le blocage.

RF3 — Une demande en cours de traitement au moment du blocage se termine normalement.

RF4 — Les cartes d'actions en attente de validation ne peuvent pas être validées pendant le blocage. Leurs boutons sont désactivés.

RF5 — Dans le dashboard et la page Contrats, la carte de l'agent porte le badge « Bloqué ». L'ouverture de son tchat affiche directement la bannière.

RF6 — Lorsque l'administrateur réactive l'agent (US-47), la bannière disparaît et la saisie redevient possible sans action du profil, au plus tard 30 secondes après la réactivation.

RF7 — Le texte saisi et non envoyé au moment du blocage est conservé dans la zone de saisie.

RF8 — Pendant la vérification du statut de l'agent à l'ouverture du tchat, un indicateur de chargement s'affiche (CC-1).

RF9 — En cas d'erreur serveur lors de la vérification du statut, le message d'erreur standard s'affiche avec un bouton « Réessayer » (CC-2).

RF10 — En cas de délai dépassé, le message de connexion lente s'affiche avec un bouton « Réessayer » (CC-3).

### Règles techniques

RT1 — [backend] Le blocage est géré uniquement par MAAQ, indépendamment de Digitorn : MAAQ refuse toute nouvelle demande vers un agent bloqué (décision du 29/09/2026).

RT2 — [frontend] Le statut de l'agent est vérifié régulièrement pendant qu'un tchat est ouvert, ou transmis par le serveur, pour respecter le délai de 30 secondes.

### UX / Design

D'après la maquette : une bannière d'alerte en haut du tchat, sous le bandeau IA, avec une icône de maintenance et le message de l'administrateur. La carte de l'agent porte un badge « Bloqué » de couleur neutre.

**Impact maquette :** Ajustement — Boutons de validation désactivés pendant le blocage ; Retirer le bouton de démonstration « Bloquer / Débloquer ».

### Critères d'acceptance

**CA 1.1 — Blocage pendant l'utilisation**
- Étant donné que j'utilise le tchat d'Admin_lib
- Quand l'administrateur bloque Admin_lib avec le message « Maintenance jusqu'à 18 h »
- Alors, dans les 30 secondes, une bannière « Maintenance jusqu'à 18 h » s'affiche et la zone de saisie est désactivée

**CA 2.1 — Historique consultable**
- Étant donné qu'Admin_lib est bloqué
- Quand j'ouvre son tchat
- Alors je peux faire défiler l'historique

**CA 3.1 — Demande en cours**
- Étant donné qu'Admin_lib traite ma demande
- Quand l'administrateur le bloque
- Alors la réponse à ma demande s'affiche quand même

**CA 4.1 — Validation impossible**
- Étant donné qu'une action attend ma validation
- Quand Admin_lib est bloqué
- Alors les boutons « Valider » et « Refuser » sont désactivés

**CA 5.1 — Badge sur le dashboard**
- Étant donné qu'Admin_lib est bloqué
- Quand j'affiche mon dashboard
- Alors la carte d'Admin_lib porte le badge « Bloqué »

**CA 6.1 — Réactivation**
- Étant donné qu'Admin_lib est bloqué et que son tchat est ouvert
- Quand l'administrateur le réactive
- Alors, dans les 30 secondes, la bannière disparaît et la saisie redevient possible

**CA 7.1 — Texte conservé**
- Étant donné que j'ai commencé à saisir un message
- Quand l'agent est bloqué
- Alors mon texte reste dans la zone de saisie

**CA 8.1 — Chargement**
- Étant donné que j'ouvre le tchat d'un agent
- Quand son statut est en cours de vérification
- Alors un indicateur de chargement s'affiche

**CA 9.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand j'ouvre le tchat d'un agent
- Alors le message d'erreur standard s'affiche avec un bouton « Réessayer »

**CA 10.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand la vérification dépasse 15 secondes
- Alors le message de connexion lente s'affiche avec un bouton « Réessayer »

---

## US-70 — Être limité à un nombre de demandes par jour


*US créée suite à la décision D20.*

**En tant qu'** utilisateur ou invité,
**je souhaite** être informé clairement lorsque j'ai atteint le nombre maximal de demandes aux agents pour la journée,
**afin de** comprendre pourquoi ma demande n'est pas envoyée et savoir quand je pourrai de nouveau solliciter les agents.

**Écran(s) maquette :** Tchat (message de plafond atteint). **Dépendances :** US-38, US-69, US-64.

### Règles fonctionnelles

RF1 — Chaque profil peut envoyer un nombre limité de demandes aux agents par jour, tous agents confondus. Le plafond est fixé par compte (50 par défaut) et réglé par l'administrateur (US-69). Il est identique pour tous les profils du compte.

RF2 — Une demande est un message envoyé à un agent (US-38) et accepté par le serveur. Un message renvoyé après une erreur (bouton « Réessayer ») n'est compté qu'une fois (CC-7). Les validations ou refus d'actions (US-39) ne sont pas comptés Un utilisateur qui a atteint son plafond peut donc encore valider ou refuser une action déjà proposée (décision du 01/10/2026)..

RF3 — Un message en attente de connexion (US-38 RF14) est compté au moment de son envoi effectif, non au moment de sa saisie [Proposition du BA].

RF4 — Quand le plafond est atteint, la demande n'est pas envoyée à l'agent. Le message « Vous avez atteint le nombre maximum de demandes pour aujourd'hui ([N]). Vous pourrez de nouveau solliciter les agents demain. » s'affiche dans le tchat (décision du 01/10/2026). Le texte saisi est conservé.

RF5 — La journée s'entend au jour calendaire du fuseau de l'appareil au moment de la demande. Le décompte repart à zéro à minuit, heure de l'appareil.

RF6 — Le plafond s'applique au profil, quel que soit l'appareil utilisé : changer d'appareil ne le contourne pas.

RF7 — L'historique du tchat et les autres fonctions de l'application restent utilisables lorsque le plafond est atteint. Seul l'envoi d'une nouvelle demande est refusé.

RF8 — Le nombre de demandes restantes n'est pas affiché de façon permanente. À l'approche du plafond, lorsqu'il reste 5 demandes ou moins (soit à partir de la 45e demande pour un plafond de 50), un avertissement discret « Il vous reste [N] demandes aujourd'hui » s'affiche au-dessus de la zone de saisie (décision du 01/10/2026).

RF9 — En cas d'erreur serveur lors de la vérification du plafond, le message d'erreur standard s'affiche, la demande n'est pas envoyée et le texte est conservé (CC-2).

### Règles techniques

RT1 — [backend] Le nombre de demandes est compté côté serveur, par profil et par jour, de façon à ce que deux demandes simultanées ne dépassent pas le plafond.

RT2 — [backend] Le contrôle a lieu avant l'envoi de la demande à Digitorn : une demande refusée n'atteint pas l'agent.

RT3 — [backend] Les compteurs journaliers anciens sont supprimés régulièrement (au bout de quelques jours) [Proposition du BA].

### UX / Design

Un message dans le fil du tchat, ou une bannière au-dessus de la zone de saisie. La zone de saisie reste visible avec le texte conservé [À CONFIRMER avec UX].

**Impact maquette :** Ajustement — Message « plafond de demandes atteint » dans le tchat, texte saisi conservé ; Avertissement discret « Il vous reste [N] demandes aujourd'hui » au-dessus de la zone de saisie, à partir de 5 demandes restantes.

### Critères d'acceptance

**CA 1.1 — Plafond atteint**
- Étant donné que Camille a envoyé 50 demandes aujourd'hui et que son plafond est de 50
- Quand elle envoie une 51e demande à Admin_lib
- Alors la demande n'est pas envoyée
- Et un message indique qu'elle a atteint le nombre maximum de demandes pour aujourd'hui

**CA 1.2 — Texte conservé**
- Étant donné que le plafond est atteint
- Quand Camille tente d'envoyer un message
- Alors son texte reste dans la zone de saisie

**CA 1.3 — Invité du même compte**
- Étant donné que Camille a atteint son plafond
- Quand Thomas, invité du même compte, envoie une demande
- Alors sa demande est acceptée, car son décompte est le sien

**CA 2.1 — Relance comptée une seule fois**
- Étant donné que l'envoi d'une demande a échoué à cause du réseau
- Quand Camille touche « Réessayer » et que l'envoi réussit
- Alors la demande n'est comptée qu'une fois

**CA 2.2 — Validation possible au plafond**
- Étant donné que Camille a atteint son plafond et qu'une action d'Admin_lib attend sa validation
- Quand elle touche « Valider »
- Alors l'action est exécutée et le nombre de demandes du jour n'augmente pas

**CA 3.1 — Message en attente de connexion**
- Étant donné que Camille a rédigé un message hors connexion
- Quand le message est envoyé automatiquement au retour de la connexion
- Alors il est compté à ce moment-là dans le plafond du jour

**CA 4.1 — Lendemain**
- Étant donné que Camille a atteint son plafond hier
- Quand elle envoie une demande le lendemain
- Alors la demande est envoyée

**CA 5.1 — Journée de l'appareil**
- Étant donné que Camille a atteint son plafond à 23 h 50, heure de son téléphone
- Quand elle envoie une demande à 0 h 05, heure de son téléphone
- Alors la demande est envoyée

**CA 6.1 — Autre appareil**
- Étant donné que Camille a atteint son plafond sur son téléphone
- Quand elle se connecte sur un autre appareil et envoie une demande
- Alors la demande est refusée avec le même message

**CA 7.1 — Fonctions conservées**
- Étant donné que le plafond est atteint
- Quand Camille consulte l'historique du tchat ou son carnet de bord
- Alors ils restent consultables

**CA 8.1 — Pas de compteur permanent**
- Étant donné que Camille a envoyé 10 demandes aujourd'hui
- Quand elle ouvre le tchat d'un agent
- Alors aucun compteur de demandes restantes n'est affiché

**CA 8.2 — Avertissement à l'approche du plafond**
- Étant donné que le plafond de Camille est de 50 et qu'elle a envoyé 45 demandes aujourd'hui
- Quand elle ouvre le tchat d'un agent
- Alors l'avertissement « Il vous reste 5 demandes aujourd'hui » s'affiche au-dessus de la zone de saisie

**CA 9.1 — Erreur serveur**
- Étant donné que le serveur est indisponible lors de la vérification du plafond
- Quand Camille envoie une demande
- Alors le message d'erreur standard s'affiche, la demande n'est pas envoyée et le texte est conservé

---

# Module G — Historique des conversations

## US-43 — Perte de l'historique du tchat à la déconnexion

**En tant qu'** utilisateur ou invité,
**je souhaite** que l'historique de mes conversations avec les agents soit effacé lorsque je me déconnecte,
**afin de** préserver la confidentialité de mes échanges.

**Écran(s) maquette :** aucun écran dédié (note sous le bouton « Se déconnecter » des Réglages). **Dépendances :** US-9, US-41, US-40.

### Règles fonctionnelles

RF1 — Une déconnexion volontaire (US-9) efface l'historique de tous les tchats du profil, pour tous ses agents.

RF2 — L'effacement ne concerne que le profil qui se déconnecte. Les tchats des autres profils du compte ne sont pas touchés.

RF3 — L'effacement concerne l'historique du profil sur tous ses appareils.

RF4 — Le carnet de bord n'est pas affecté par l'effacement.

RF5 — Le verrouillage pour inactivité (US-52) et la simple fermeture de l'application ne sont pas des déconnexions. L'historique est conservé dans ces deux cas.

RF6 — Une déconnexion forcée (révocation de l'appareil, US-53) efface également l'historique.

RF7 — Les actions en attente de validation au moment de la déconnexion sont abandonnées, sans exécution.

RF8 — Si l'effacement échoue côté serveur (erreur ou délai dépassé), il est réessayé automatiquement jusqu'à réussir. À la reconnexion, le profil voit toujours ses tchats sans historique (CC-2, CC-3).

RF9 — Pendant la déconnexion, l'indicateur de chargement de US-9 s'affiche (CC-1).

### Règles techniques

RT1 — [backend] L'effacement est une règle intégrée aux agents chez Digitorn (décision du 29/09/2026). MAAQ transmet l'information de déconnexion.

RT2 — [backend] Les nouvelles tentatives d'effacement sont journalisées. Un échec persistant au-delà de 24 heures est signalé à l'administrateur par email (décision du 30/09/2026).

### UX / Design

Aucun écran dédié. Une note sous le bouton « Se déconnecter » des Réglages rappelle l'effacement, conformément à la maquette.

**Impact maquette :** aucun ajustement nécessaire.

### Critères d'acceptance

**CA 1.1 — Effacement de tous les tchats**
- Étant donné que j'ai des conversations avec Admin_lib et Admin_Classify
- Quand je me déconnecte puis me reconnecte
- Alors les deux tchats affichent l'état d'accueil sans historique

**CA 2.1 — Autres profils non concernés**
- Étant donné que Camille et Thomas ont chacun une conversation avec Admin_lib
- Quand Thomas se déconnecte
- Alors la conversation de Camille avec Admin_lib est conservée

**CA 3.1 — Tous les appareils**
- Étant donné que j'utilise MAAQ sur mon téléphone et ma tablette
- Quand je me déconnecte sur mon téléphone
- Alors l'historique de mes tchats est également vide sur ma tablette

**CA 4.1 — Carnet conservé**
- Étant donné que mes demandes figurent dans le carnet d'Admin_lib
- Quand je me déconnecte puis me reconnecte
- Alors mes demandes figurent toujours dans le carnet

**CA 5.1 — Verrouillage sans effacement**
- Étant donné que MAAQ s'est verrouillée après 5 minutes d'inactivité
- Quand je la déverrouille
- Alors l'historique de mes tchats est intact

**CA 5.2 — Fermeture sans effacement**
- Étant donné que j'ai fermé MAAQ sans me déconnecter
- Quand je la rouvre le lendemain
- Alors l'historique de mes tchats est intact

**CA 6.1 — Révocation d'appareil**
- Étant donné que Camille révoque l'appareil de Thomas
- Quand Thomas se reconnecte
- Alors ses tchats sont sans historique

**CA 7.1 — Action en attente abandonnée**
- Étant donné qu'une action attend ma validation
- Quand je me déconnecte
- Alors l'action n'est jamais exécutée

**CA 8.1 — Effacement réessayé**
- Étant donné que le serveur est indisponible au moment de ma déconnexion
- Quand je me reconnecte plus tard
- Alors mes tchats sont sans historique

**CA 9.1 — Chargement**
- Étant donné que j'ai confirmé la déconnexion
- Quand elle est en cours
- Alors un indicateur de chargement s'affiche

---

## US-44 — Expiration automatique des conversations anciennes

**En tant qu'** utilisateur ou invité,
**je souhaite** que les conversations de plus de 4 jours soient automatiquement supprimées si je ne me suis pas déconnecté entretemps,
**afin de** ne pas accumuler un historique de tchat trop ancien.

**Écran(s) maquette :** aucun écran dédié (résultat visible : état « sans historique » du Tchat). **Dépendances :** US-41, US-43.

### Règles fonctionnelles

RF1 — Chaque message d'un tchat est supprimé automatiquement 4 jours (96 heures) après son envoi.

RF2 — Si tous les messages d'un tchat sont supprimés, le tchat affiche l'état d'accueil (US-41). Si une partie seulement est supprimée, seuls les messages de moins de 4 jours restent affichés.

RF3 — Le carnet de bord n'est pas affecté par l'expiration.

RF4 — Une action en attente de validation expire avec son message, sans être exécutée.

RF5 — La règle s'applique à tous les profils et à tous les agents.

RF6 — Si la suppression automatique échoue (erreur ou délai dépassé), elle est réessayée au cycle suivant. Un message de plus de 4 jours n'est jamais affiché au-delà d'un délai de tolérance de 24 heures (CC-2, CC-3).

RF7 — Un tchat dont les messages anciens sont en cours de suppression affiche l'indicateur de chargement standard à son ouverture (CC-1).

### Règles techniques

RT1 — [backend] L'expiration est une règle intégrée aux agents chez Digitorn (décision du 29/09/2026).

RT2 — [frontend] Le tchat masque à l'affichage tout message de plus de 4 jours, même si sa suppression côté serveur n'a pas encore eu lieu.

### UX / Design

Aucun écran dédié. Le résultat visible est l'état d'accueil de US-41.

**Impact maquette :** aucun ajustement nécessaire.

### Critères d'acceptance

**CA 1.1 — Suppression après 4 jours**
- Étant donné que j'ai envoyé un message à Admin_lib il y a 97 heures sans me déconnecter
- Quand j'ouvre le tchat d'Admin_lib
- Alors ce message n'apparaît plus

**CA 2.1 — Tchat entièrement expiré**
- Étant donné que tous mes messages avec Admin_lib ont plus de 4 jours
- Quand j'ouvre son tchat
- Alors l'état d'accueil s'affiche

**CA 2.2 — Expiration partielle**
- Étant donné que j'ai des messages de 5 jours et de 1 jour avec Admin_lib
- Quand j'ouvre son tchat
- Alors seuls les messages de 1 jour sont affichés

**CA 3.1 — Carnet conservé**
- Étant donné que mes messages de plus de 4 jours ont été supprimés
- Quand je consulte le carnet d'Admin_lib
- Alors les demandes correspondantes y figurent toujours

**CA 4.1 — Action en attente expirée**
- Étant donné qu'une action attend ma validation depuis plus de 4 jours
- Quand j'ouvre le tchat
- Alors la carte n'est plus affichée et l'action n'a pas été exécutée

**CA 5.1 — Tous les profils**
- Étant donné que Thomas, invité, a des messages de plus de 4 jours
- Quand il ouvre le tchat concerné
- Alors ces messages n'apparaissent plus

**CA 6.1 — Échec de suppression**
- Étant donné que la suppression automatique a échoué
- Quand j'ouvre le tchat
- Alors les messages de plus de 4 jours ne sont pas affichés

**CA 7.1 — Chargement**
- Étant donné que j'ouvre un tchat
- Quand l'historique est en cours de chargement
- Alors l'indicateur de chargement standard s'affiche

---

# Module H — Administration des agents (Administrateur)

## US-45 — Mettre à disposition un agent IA

**En tant qu'** administrateur,
**je souhaite** mettre un agent IA à disposition dans le catalogue, dans l'une des 3 rubriques (Pro, Perso, Agents des Contrats),
**afin que** les utilisateurs et leurs invités puissent l'ajouter à leur dashboard et l'utiliser.

**Écran(s) maquette :** Administration des agents (bouton « Mettre à disposition un agent », choix de la rubrique). **Dépendances :** US-23, US-24, US-46.

### Règles fonctionnelles

RF1 — L'écran d'administration des agents, réservé aux administrateurs sur ordinateur, liste tous les agents avec leur nom, leur rubrique et leur statut (« Disponible » ou « Bloqué »). Un champ de recherche permet de filtrer la liste.

RF2 — Le bouton « Mettre à disposition un agent » ouvre un formulaire avec :
- l'agent à publier, choisi parmi ceux hébergés chez Digitorn et pas encore publiés ;
- la rubrique (Pro, Perso ou Agents des Contrats), obligatoire et unique ;
- la description courte et la description complète ;
- les exemples de demandes et les suggestions de première demande (US-41) ;
- les connecteurs requis (Drive, Agenda, boîte de validation), avec pour chacun sa portée : propre à chaque profil, propre à l'utilisateur principal, ou connexion unique du compte (décision D14 du 01/10/2026) ;
- les champs d'information propres à l'agent (RF10) ;
- le nombre maximal d'adresses en copie, 0 si l'agent n'en propose pas (décision D16 du 01/10/2026) ;
- les actions soumises à validation.

RF3 — Un agent ne peut appartenir qu'à une seule rubrique.

RF4 — À la validation, l'agent passe au statut « Disponible » et apparaît immédiatement dans le catalogue de tous les utilisateurs et invités.

RF5 — Le changement de rubrique d'un agent déjà publié n'est pas prévu en V1.

RF6 — Le retrait définitif d'un agent du catalogue n'est pas prévu en V1.

RF7 — Pendant la publication, le bouton affiche un indicateur de chargement et est désactivé (CC-1).

RF8 — En cas d'erreur serveur, le message d'erreur standard s'affiche, le formulaire est conservé et l'agent n'est pas publié (CC-2).

RF9 — En cas de délai dépassé, le message de connexion lente s'affiche et le formulaire est conservé (CC-3).

RF10 — Le formulaire de mise à disposition précise aussi (décision D14, D15, D16 du 01/10/2026) :
- les champs d'information que l'utilisateur doit renseigner pour cet agent (US-10), chacun avec son libellé, son type (texte, téléphone, code postal, date passée, email), son caractère obligatoire ou facultatif, son nombre maximal d'éléments (1 pour une valeur unique) et, éventuellement, une clé commune saisie librement qui permet le pré-remplissage entre agents ;
- les éléments de configuration requis et leur responsable : chaque profil, l'utilisateur principal, ou le compte (US-29, US-67) ;
- le nombre maximal d'adresses en copie par profil (US-16).

### Règles techniques

RT1 — [backend] Chaque publication est enregistrée dans le journal d'administration, avec l'administrateur, la date et l'heure.

RT2 — [backend] La liste des agents disponibles chez Digitorn est récupérée auprès de Digitorn.

### UX / Design

D'après la maquette : un tableau des agents avec les colonnes nom, rubrique, statut et actions, et un bouton principal « Mettre à disposition un agent » au-dessus du tableau.

**Impact maquette :** Ajustement — Éditeur de champs d'information (libellé, type, obligatoire, nombre maximal d'éléments, clé commune) ; Choix de la portée de chaque connecteur (chaque profil, utilisateur principal, compte) ; Champ « Nombre maximal d'adresses en copie » ; Formulaire complet de mise à disposition : description, exemples, suggestions, connecteurs requis, actions à valider ; Définition des informations à demander à l'utilisateur et des éléments de configuration requis.

### Critères d'acceptance

**CA 1.1 — Liste des agents**
- Étant donné que je suis administrateur
- Quand j'ouvre l'écran d'administration des agents
- Alors je vois chaque agent avec son nom, sa rubrique et son statut

**CA 1.2 — Accès refusé aux autres profils**
- Étant donné que je suis utilisateur principal
- Quand je navigue dans MAAQ
- Alors l'écran d'administration des agents ne m'est jamais proposé

**CA 2.1 — Rubrique obligatoire**
- Étant donné que le formulaire de mise à disposition est ouvert
- Quand je ne choisis pas de rubrique
- Alors le bouton de publication reste inactif

**CA 3.1 — Rubrique unique**
- Étant donné que le formulaire est ouvert
- Quand je choisis la rubrique « Pro »
- Alors les autres rubriques ne sont plus sélectionnées

**CA 4.1 — Publication**
- Étant donné que j'ai rempli le formulaire pour Admin_lib dans « Perso »
- Quand je publie
- Alors Admin_lib apparaît au statut « Disponible »
- Et il est visible dans l'onglet « Perso » du catalogue des utilisateurs

**CA 5.1 — Pas de changement de rubrique**
- Étant donné qu'Admin_lib est publié
- Quand je consulte ses informations
- Alors sa rubrique n'est pas modifiable

**CA 6.1 — Pas de retrait définitif**
- Étant donné qu'Admin_lib est publié
- Quand je consulte ses actions
- Alors aucune action ne permet de le retirer définitivement du catalogue

**CA 7.1 — Chargement**
- Étant donné que je publie un agent
- Quand la publication est en cours
- Alors un indicateur de chargement s'affiche et le bouton est désactivé

**CA 8.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand je publie un agent
- Alors le message d'erreur standard s'affiche et le formulaire est conservé

**CA 9.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand la publication dépasse 15 secondes
- Alors le message de connexion lente s'affiche et le formulaire est conservé

**CA 10.1 — Informations et configuration requises**
- Étant donné que je publie un agent de déclaration fiscale
- Quand je définis le champ « Numéro fiscal », de type texte et obligatoire, et « Google Drive » comme élément de configuration propre à chaque profil
- Alors un utilisateur qui ajoute cet agent se voit demander son numéro fiscal dans le formulaire de cet agent
- Et l'agent reste « À configurer » tant que son Google Drive n'est pas connecté


**CA 10.2 — Clé commune**
- Étant donné que je publie deux agents avec un champ « Téléphone » portant la même clé commune « telephone »
- Quand un utilisateur renseigne le téléphone du premier agent puis ajoute le second
- Alors la valeur est proposée pré-remplie pour le second

**CA 10.3 — Champ de type liste**
- Étant donné que je définis un champ « Contacts » de type liste avec un maximum de 5 éléments
- Quand un utilisateur ajoute cet agent
- Alors il peut renseigner jusqu'à 5 contacts

**CA 10.4 — Adresses en copie**
- Étant donné que je fixe à 10 le nombre maximal d'adresses en copie d'Admin_lib
- Quand un utilisateur ouvre les connecteurs d'Admin_lib
- Alors la section « Adresses en copie systématique » est présente avec une limite de 10

**CA 10.5 — Pas d'adresses en copie**
- Étant donné que je fixe à 0 le nombre d'adresses en copie d'un agent
- Quand un utilisateur ouvre les connecteurs de cet agent
- Alors la section « Adresses en copie systématique » n'est pas affichée

**CA 10.6 — Connexion unique du compte**
- Étant donné que je précise que le Google Drive d'Admin_Classify est une connexion du compte
- Quand l'utilisateur principal a connecté le Drive du compte
- Alors Admin_Classify n'est plus « À configurer » pour aucun profil du compte
---

## US-46 — Bloquer l'accès à un agent

**En tant qu'** administrateur,
**je souhaite** bloquer l'accès à un agent pour l'ensemble des utilisateurs et invités,
**afin de** réaliser une opération de maintenance sur cet agent.

**Écran(s) maquette :** Administration des agents (bouton « Bloquer », avec message de maintenance obligatoire). **Dépendances :** US-42, US-47.

### Règles fonctionnelles

RF1 — Chaque agent au statut « Disponible » propose un bouton « Bloquer ».

RF2 — Le bouton ouvre une fenêtre qui demande un message de maintenance, obligatoire et limité à 200 caractères. La fenêtre propose « Bloquer » et « Annuler ».

RF3 — À la confirmation, l'agent passe au statut « Bloqué ». Le blocage s'applique à tous les utilisateurs et invités, y compris sur les tchats déjà ouverts (US-42).

RF4 — L'agent bloqué reste dans les dashboards, et son carnet de bord reste consultable.

RF5 — Le tableau affiche, pour un agent bloqué, le message de maintenance, l'auteur et la date du blocage.

RF6 — Pendant le blocage, le bouton affiche un indicateur de chargement (CC-1).

RF7 — En cas d'erreur serveur, le message d'erreur standard s'affiche et l'agent n'est pas bloqué (CC-2).

RF8 — En cas de délai dépassé, le message de connexion lente s'affiche et l'agent n'est pas bloqué (CC-3).

### Règles techniques

RT1 — [backend] Le blocage est géré uniquement par MAAQ, indépendamment de Digitorn (décision du 29/09/2026).

RT2 — [backend] Chaque blocage est enregistré dans le journal d'administration.

### UX / Design

D'après la maquette : un bouton « Bloquer » sur la ligne de l'agent, et une fenêtre de saisie du message de maintenance avec un compteur de caractères.

**Impact maquette :** aucun ajustement nécessaire.

### Critères d'acceptance

**CA 1.1 — Bouton disponible**
- Étant donné qu'Admin_lib est « Disponible »
- Quand j'affiche sa ligne
- Alors le bouton « Bloquer » est proposé

**CA 2.1 — Message obligatoire**
- Étant donné que la fenêtre de blocage est ouverte
- Quand je laisse le message vide
- Alors le bouton « Bloquer » est inactif

**CA 2.2 — Annulation**
- Étant donné que la fenêtre de blocage est ouverte
- Quand je clique sur « Annuler »
- Alors Admin_lib reste « Disponible »

**CA 3.1 — Blocage effectif**
- Étant donné que j'ai saisi « Maintenance jusqu'à 18 h »
- Quand je confirme le blocage
- Alors Admin_lib passe au statut « Bloqué »
- Et les utilisateurs qui ont son tchat ouvert voient la bannière de maintenance

**CA 4.1 — Carnet consultable**
- Étant donné qu'Admin_lib est bloqué
- Quand un utilisateur consulte son carnet
- Alors les entrées s'affichent normalement

**CA 5.1 — Informations du blocage**
- Étant donné que j'ai bloqué Admin_lib
- Quand j'affiche le tableau
- Alors la ligne d'Admin_lib affiche le message, mon nom et la date du blocage

**CA 6.1 — Chargement**
- Étant donné que je confirme un blocage
- Quand il est en cours
- Alors un indicateur de chargement s'affiche

**CA 7.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand je confirme un blocage
- Alors le message d'erreur standard s'affiche et l'agent reste « Disponible »

**CA 8.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand le blocage dépasse 15 secondes
- Alors le message de connexion lente s'affiche et l'agent reste « Disponible »

---

## US-47 — Réactiver l'accès à un agent

**En tant qu'** administrateur,
**je souhaite** réactiver l'accès à un agent précédemment bloqué,
**afin que** les utilisateurs et invités puissent de nouveau le solliciter.

**Écran(s) maquette :** Administration des agents (bouton « Réactiver »). **Dépendances :** US-46, US-42.

### Règles fonctionnelles

RF1 — Chaque agent au statut « Bloqué » propose un bouton « Réactiver ».

RF2 — Le bouton ouvre la confirmation « Réactiver [agent] pour tous les utilisateurs ? », avec « Réactiver » et « Annuler ».

RF3 — À la confirmation, l'agent repasse au statut « Disponible », et son message de maintenance est effacé. Les utilisateurs et invités peuvent de nouveau le solliciter, sans action de leur part (US-42).

RF4 — Pendant la réactivation, un indicateur de chargement s'affiche (CC-1).

RF5 — En cas d'erreur serveur, le message d'erreur standard s'affiche et l'agent reste bloqué (CC-2).

RF6 — En cas de délai dépassé, le message de connexion lente s'affiche et l'agent reste bloqué (CC-3).

### Règles techniques

RT1 — [backend] Chaque réactivation est enregistrée dans le journal d'administration.

### UX / Design

D'après la maquette : le bouton « Réactiver » remplace le bouton « Bloquer » sur la ligne d'un agent bloqué.

**Impact maquette :** Ajustement — Fenêtre de confirmation de réactivation.

### Critères d'acceptance

**CA 1.1 — Bouton disponible**
- Étant donné qu'Admin_lib est « Bloqué »
- Quand j'affiche sa ligne
- Alors le bouton « Réactiver » est proposé à la place de « Bloquer »

**CA 2.1 — Confirmation**
- Étant donné qu'Admin_lib est bloqué
- Quand je clique sur « Réactiver »
- Alors la confirmation « Réactiver Admin_lib pour tous les utilisateurs ? » s'affiche

**CA 3.1 — Réactivation effective**
- Étant donné que la confirmation est affichée
- Quand je confirme
- Alors Admin_lib repasse au statut « Disponible » sans message de maintenance
- Et les utilisateurs peuvent de nouveau lui envoyer des demandes

**CA 4.1 — Chargement**
- Étant donné que je confirme une réactivation
- Quand elle est en cours
- Alors un indicateur de chargement s'affiche

**CA 5.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand je confirme une réactivation
- Alors le message d'erreur standard s'affiche et l'agent reste « Bloqué »

**CA 6.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand la réactivation dépasse 15 secondes
- Alors le message de connexion lente s'affiche et l'agent reste « Bloqué »

---

## US-48 — Définir la liste des contrats obligatoires

**En tant qu'** administrateur,
**je souhaite** définir la liste des contrats obligatoires proposés dans « Mes contrats »,
**afin que** tous les utilisateurs et invités disposent d'une liste de contrats cohérente.

**Écran(s) maquette :** Administration des contrats. **Dépendances :** US-32.

### Règles fonctionnelles

RF1 — L'écran d'administration des contrats liste les contrats obligatoires dans leur ordre d'affichage.

RF2 — L'administrateur peut ajouter un contrat en saisissant son nom, obligatoire et unique dans la liste (sans tenir compte des majuscules).

RF3 — L'administrateur peut renommer un contrat et modifier l'ordre de la liste.

RF4 — L'administrateur peut retirer un contrat. Si des clients ont déjà renseigné des informations pour ce contrat, un avertissement indique le nombre de comptes concernés avant la confirmation. Les informations et documents déjà renseignés restent stockés dans le Google Drive de l'utilisateur principal (décision du 30/09/2026).

RF5 — Toute modification de la liste s'applique immédiatement à tous les clients (US-32).

RF6 — La liste est commune à tous les clients. Les clients ne peuvent pas la modifier.

RF7 — Pendant l'enregistrement, un indicateur de chargement s'affiche (CC-1).

RF8 — En cas d'erreur serveur, le message d'erreur standard s'affiche et la liste n'est pas modifiée (CC-2).

RF9 — En cas de délai dépassé, le message de connexion lente s'affiche et la liste n'est pas modifiée (CC-3).

RF10 — Pour chaque contrat, l'administrateur définit les champs de détail proposés aux clients (US-33) : libellé, type (texte, date, montant, liste de choix) et caractère obligatoire ou facultatif (décision du 30/09/2026). Ajouter ou retirer un champ s'applique immédiatement à tous les clients.

### Règles techniques

RT1 — [backend] Chaque modification de la liste est enregistrée dans le journal d'administration.

RT2 — [backend] Un contrat renommé conserve les informations déjà renseignées par les clients.

### UX / Design

D'après la maquette : une liste simple des contrats avec un bouton d'ajout. Les actions « Renommer », « Déplacer » et « Retirer » sont un ajout à la maquette.

**Impact maquette :** Ajustement — Écran de définition des champs d'un contrat (libellé, type, obligatoire) ; Actions « Renommer », « Déplacer », « Retirer » ; Avertissement indiquant le nombre de comptes concernés.

### Critères d'acceptance

**CA 1.1 — Liste affichée**
- Étant donné que la liste contient quatre contrats
- Quand j'ouvre l'écran d'administration des contrats
- Alors les quatre contrats s'affichent dans leur ordre

**CA 2.1 — Ajout d'un contrat**
- Étant donné que « Assurance Scolaire » n'existe pas
- Quand je l'ajoute
- Alors il apparaît en fin de liste

**CA 2.2 — Nom en double**
- Étant donné que « Mutuelle santé » existe
- Quand j'ajoute « mutuelle santé »
- Alors un message indique que ce contrat existe déjà

**CA 3.1 — Renommage**
- Étant donné que « Assurance Auto » existe
- Quand je le renomme « Assurance Automobile »
- Alors les clients voient « Assurance Automobile » avec leurs informations inchangées

**CA 4.1 — Retrait avec avertissement**
- Étant donné que 12 comptes ont renseigné l'Assurance Emprunteur
- Quand je demande à la retirer
- Alors un avertissement indique que 12 comptes sont concernés, avant ma confirmation

**CA 5.1 — Application immédiate**
- Étant donné que je viens d'ajouter « Assurance Scolaire »
- Quand un utilisateur ouvre l'onglet « Mes contrats »
- Alors il voit « Assurance Scolaire »

**CA 6.1 — Liste non modifiable par les clients**
- Étant donné que je suis utilisateur principal
- Quand j'ouvre l'onglet « Mes contrats »
- Alors aucune action ne permet de modifier la liste des contrats

**CA 7.1 — Chargement**
- Étant donné que j'enregistre une modification
- Quand elle est en cours
- Alors un indicateur de chargement s'affiche

**CA 8.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand j'ajoute un contrat
- Alors le message d'erreur standard s'affiche et la liste est inchangée

**CA 9.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand l'enregistrement dépasse 15 secondes
- Alors le message de connexion lente s'affiche et la liste est inchangée

**CA 10.1 — Définition des champs d'un contrat**
- Étant donné que je configure l'Assurance Auto
- Quand j'ajoute le champ « Date d'échéance » de type date et obligatoire
- Alors ce champ apparaît, obligatoire, dans le détail de l'Assurance Auto de tous les clients

---

## US-64 — Créer le compte d'un utilisateur principal

*US proposée par le BA à la suite de la décision du 30/09/2026 (création des comptes par la console d'administration), validée par le PM le 30/09/2026.*

**En tant qu'** administrateur,
**je souhaite** créer le compte d'un utilisateur principal depuis la console d'administration,
**afin qu'** il puisse accéder à MAAQ après sa souscription.

**Écran(s) maquette :** aucun (à créer). **Dépendances :** US-3, US-10, US-21, US-54, US-68, US-69.

### Règles fonctionnelles

RF1 — La console d'administration propose un écran « Comptes », qui liste les utilisateurs principaux avec leur nom, leur email, leur statut (« Activation en attente », « Actif », « En délai de grâce ») et leur nombre d'invités. Un champ de recherche filtre la liste.

RF2 — Le bouton « Créer un compte » ouvre un formulaire : prénom, nom et email obligatoires, téléphone facultatif, et nombre d'invités autorisés par le plan souscrit, obligatoire, et plafond quotidien de demandes par profil, obligatoire, 50 par défaut (décision D20 du 01/10/2026).

RF3 — L'email doit être au format valide et ne pas être déjà associé à un compte MAAQ.

RF4 — À la validation, le compte est créé au statut « Activation en attente ». Un email d'activation est envoyé à l'utilisateur principal, avec un lien valable 30 minutes et à usage unique.

RF5 — Le lien ouvre l'écran d'activation : acceptation de la politique de confidentialité et des conditions d'utilisation (US-54), puis création du mot de passe. L'utilisateur principal enchaîne ensuite avec la création du schéma tactile (US-6) et la configuration initiale (US-10).

RF6 — Un lien expiré affiche « Ce lien d'activation a expiré. Contactez MAAQ pour recevoir un nouveau lien. ». L'administrateur peut renvoyer un nouveau lien depuis la fiche du compte, ce qui invalide le précédent. Un compte dont le lien n'a jamais été utilisé est supprimé automatiquement 30 jours après le dernier envoi (US-68) (décision D19 du 01/10/2026).

RF7 — Pendant la création, le bouton affiche un indicateur de chargement et est désactivé (CC-1).

RF8 — En cas d'erreur serveur, le message d'erreur standard s'affiche, le formulaire est conservé et aucun compte n'est créé (CC-2).

RF9 — En cas de délai dépassé, le message de connexion lente s'affiche et le formulaire est conservé (CC-3).

### Règles techniques

RT1 — [backend] Chaque création de compte est enregistrée dans le journal d'administration [À CONFIRMER avec backend].

RT2 — [backend] Le lien d'activation contient un jeton unique, impossible à deviner, valable une seule fois [À CONFIRMER avec backend].

### UX / Design

Écran à concevoir dans la console d'administration : liste des comptes, formulaire de création et fiche d'un compte avec le bouton « Renvoyer le lien d'activation » [À CONFIRMER avec UX].

**Impact maquette :** Nouvel écran — Champ « Plafond quotidien de demandes » (50 par défaut) dans le formulaire de création ; Écran « Comptes » de la console : liste, formulaire de création, fiche avec « Renvoyer le lien d'activation » ; Écran d'activation du compte de l'utilisateur principal.

### Critères d'acceptance

**CA 1.1 — Liste des comptes**
- Étant donné que je suis administrateur
- Quand j'ouvre l'écran « Comptes »
- Alors je vois chaque utilisateur principal avec son nom, son email, son statut et son nombre d'invités

**CA 2.1 — Champs obligatoires**
- Étant donné que le formulaire de création est ouvert
- Quand je ne renseigne pas le nombre d'invités autorisés, ou que j'efface le plafond quotidien proposé à 50
- Alors le bouton de création reste inactif

**CA 3.1 — Email déjà utilisé**
- Étant donné qu'un compte MAAQ existe pour camille.faucher@exemple.fr
- Quand je crée un compte avec cet email
- Alors un message indique que l'adresse est déjà associée à un compte MAAQ

**CA 4.1 — Création et envoi du lien**
- Étant donné que j'ai rempli le formulaire pour Camille
- Quand je crée le compte
- Alors le compte apparaît au statut « Activation en attente »
- Et Camille reçoit un email d'activation valable 30 minutes

**CA 5.1 — Activation**
- Étant donné que Camille ouvre un lien d'activation valide
- Quand elle accepte les conditions et crée son mot de passe
- Alors elle enchaîne avec la création de son schéma puis la configuration initiale

**CA 6.1 — Lien expiré et renvoi**
- Étant donné que le lien de Camille a expiré
- Quand je touche « Renvoyer le lien d'activation » sur sa fiche
- Alors Camille reçoit un nouveau lien et l'ancien n'est plus utilisable

**CA 7.1 — Chargement**
- Étant donné que je crée un compte
- Quand la création est en cours
- Alors un indicateur de chargement s'affiche et le bouton est désactivé

**CA 8.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand je crée un compte
- Alors le message d'erreur standard s'affiche et aucun compte n'est créé

**CA 9.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand la création dépasse 15 secondes
- Alors le message de connexion lente s'affiche et le formulaire est conservé

---

## US-65 — Paramétrer les délais et les limites de la plateforme

*US proposée par le BA pour regrouper les paramètres que la décision du 30/09/2026 confie à la console d'administration, validée par le PM le 30/09/2026.*

**En tant qu'** administrateur,
**je souhaite** régler depuis la console d'administration les délais de fonctionnement de MAAQ,
**afin d'** adapter la plateforme sans nouvelle version de l'application.

**Écran(s) maquette :** aucun (à créer). **Dépendances :** US-20, US-40, US-43, US-58, US-34, US-61, US-68, US-27, US-62.

### Règles fonctionnelles

RF1 — L'écran « Paramètres » de la console d'administration permet de régler :
- la fréquence de synchronisation du carnet de bord, en heures (5 heures par défaut) ;
- le délai de suppression des données d'un invité supprimé, en jours (30 jours par défaut) ;
- l'adresse email qui reçoit les alertes (échecs de synchronisation, d'effacement et de suppression) ;
- la durée de conservation du carnet de bord, en mois (14 par défaut) ;
- la durée de conservation des signalements d'erreur, en mois (14 par défaut) ;
- la durée de conservation du journal de sécurité, en mois (36 par défaut) ;
- la taille maximale d'un document de contrat, en Mo (15 par défaut) ;
- le nombre maximal de documents par contrat (20 par défaut) ;
- le délai de suppression des comptes et invités jamais activés, en jours (30 par défaut) (décision D17, D19 du 01/10/2026) ;
- le nombre maximal d'agents par rubrique (10 par défaut, US-27) ;
- l'adresse email de la boîte du support (US-62) (décision du 01/10/2026).

RF2 — Les valeurs sont contrôlées : nombres entiers positifs, fréquence comprise entre 1 et 24 heures, adresse email au format valide. Les durées sont des nombres entiers supérieurs ou égaux à 1.

RF3 — Une nouvelle valeur s'applique à partir du cycle de traitement suivant. Elle ne modifie pas les traitements déjà programmés.

RF4 — Chaque modification est affichée dans un historique : ancien et nouveau paramètre, administrateur, date et heure.

RF5 — Pendant l'enregistrement, un indicateur de chargement s'affiche (CC-1).

RF6 — En cas d'erreur serveur, le message d'erreur standard s'affiche et les valeurs précédentes restent en vigueur (CC-2).

RF7 — En cas de délai dépassé, le message de connexion lente s'affiche et les valeurs précédentes restent en vigueur (CC-3).

RF8 — Une modification du nombre maximal d'agents par rubrique s'applique aux ajouts suivants. Les profils qui dépassent la nouvelle limite conservent leurs agents, mais ne peuvent plus en ajouter dans la rubrique concernée tant qu'ils sont au-dessus de la limite (décision du 01/10/2026).

### Règles techniques

RT1 — [backend] Les paramètres sont lus par les traitements automatiques à chaque exécution [À CONFIRMER avec backend].

### UX / Design

Écran à concevoir dans la console d'administration : un formulaire simple avec un bouton « Enregistrer », et l'historique des modifications en dessous [À CONFIRMER avec UX].

**Impact maquette :** Nouvel écran — Huit réglages supplémentaires (durées de conservation, taille et nombre de documents, délai de suppression des comptes jamais activés, nombre maximal d'agents par rubrique, adresse du support) ; Écran « Paramètres » de la console, avec l'historique des modifications.

### Critères d'acceptance

**CA 1.1 — Valeurs affichées**
- Étant donné que je suis administrateur
- Quand j'ouvre l'écran « Paramètres »
- Alors je vois les treize réglages avec leurs valeurs, dont la fréquence de synchronisation (5 heures), le délai de suppression des invités (30 jours), la durée de conservation du carnet (14 mois) et la taille maximale d'un document (15 Mo)

**CA 2.1 — Valeur invalide**
- Étant donné que l'écran « Paramètres » est affiché
- Quand je saisis 0 heure comme fréquence de synchronisation
- Alors un message indique que la valeur doit être comprise entre 1 et 24 heures

**CA 2.2 — Durée de rétention inférieure à 1 mois**
- Étant donné que l'écran « Paramètres » est affiché
- Quand je saisis 0 mois comme durée de conservation du carnet
- Alors un message indique que la durée doit être d'au moins 1 mois

**CA 3.1 — Application au cycle suivant**
- Étant donné que la fréquence est de 5 heures
- Quand je la passe à 3 heures et enregistre
- Alors la synchronisation suivante a lieu 3 heures après la précédente

**CA 4.1 — Historique**
- Étant donné que j'ai modifié la fréquence
- Quand je consulte l'historique
- Alors je vois l'ancienne et la nouvelle valeur, mon nom, la date et l'heure

**CA 5.1 — Chargement**
- Étant donné que j'enregistre les paramètres
- Quand l'enregistrement est en cours
- Alors un indicateur de chargement s'affiche

**CA 6.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand j'enregistre
- Alors le message d'erreur standard s'affiche et les anciennes valeurs restent en vigueur

**CA 7.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand l'enregistrement dépasse 15 secondes
- Alors le message de connexion lente s'affiche et les anciennes valeurs restent en vigueur

**CA 8.1 — Limite d'agents réduite**
- Étant donné que Thomas a 10 agents dans la rubrique Pro
- Quand l'administrateur passe la limite à 8
- Alors Thomas conserve ses 10 agents mais ne peut plus en ajouter dans la rubrique Pro

**CA 8.2 — Adresse du support modifiée**
- Étant donné que l'administrateur a remplacé l'adresse du support
- Quand un utilisateur envoie un message au support
- Alors le message est transmis à la nouvelle adresse

---

## US-69 — Modifier le plafond quotidien de demandes d'un compte


*US créée suite à la décision D20.*

**En tant qu'** administrateur,
**je souhaite** modifier le plafond quotidien de demandes aux agents d'un compte,
**afin de** l'adapter au plan souscrit.

**Écran(s) maquette :** console d'administration, fiche d'un compte (à créer). **Dépendances :** US-64, US-70.

### Règles fonctionnelles

RF1 — La fiche d'un compte, accessible depuis l'écran « Comptes » (US-64 RF1), affiche le plafond quotidien de demandes par profil (50 par défaut) et permet de le modifier.

RF2 — La valeur est un nombre entier supérieur ou égal à 1. Une valeur invalide affiche un message sous le champ.

RF3 — La nouvelle valeur s'applique immédiatement aux demandes suivantes, pour tous les profils du compte. Elle ne remet pas à zéro le nombre de demandes déjà envoyées le jour même.

RF4 — Chaque modification est enregistrée dans le journal d'administration, avec l'ancienne et la nouvelle valeur, l'administrateur, la date et l'heure.

RF5 — Seul l'administrateur peut modifier le plafond.

RF6 — La fiche du compte affiche le nombre d'invités autorisé par le plan, en lecture seule : il n'est pas modifiable après la création du compte en V1 (décision du 01/10/2026).

RF7 — Pendant l'enregistrement, un indicateur de chargement s'affiche (CC-1). En cas d'erreur serveur, le message d'erreur standard s'affiche et la valeur précédente reste en vigueur (CC-2). En cas de délai dépassé, le message de connexion lente s'affiche (CC-3).

### Règles techniques

RT1 — [backend] Le plafond est une valeur du compte, appliquée à chacun de ses profils.

RT2 — [backend] La modification est enregistrée dans le journal d'administration (type d'action « compte modifié »).

### UX / Design

Écran à concevoir dans la console d'administration : fiche d'un compte avec le plafond quotidien, le bouton « Enregistrer » et, par exemple, le bouton « Renvoyer le lien d'activation » déjà prévu en US-64 [À CONFIRMER avec UX].

**Impact maquette :** Nouvel écran — Fiche d'un compte dans la console : plafond quotidien de demandes modifiable, nombre d'invités autorisé en lecture seule, « Renvoyer le lien d'activation ».

### Critères d'acceptance

**CA 1.1 — Plafond affiché**
- Étant donné que je suis administrateur
- Quand j'ouvre la fiche du compte de Camille
- Alors je vois le plafond quotidien de demandes par profil (50)

**CA 2.1 — Valeur invalide**
- Étant donné que la fiche du compte est ouverte
- Quand je saisis 0 comme plafond
- Alors un message indique que la valeur doit être au moins 1

**CA 3.1 — Application immédiate**
- Étant donné que Thomas a envoyé 50 demandes aujourd'hui avec un plafond de 50
- Quand je porte le plafond à 80
- Alors Thomas peut envoyer de nouvelles demandes aujourd'hui, jusqu'à 80 au total

**CA 4.1 — Journal**
- Étant donné que j'ai modifié le plafond de 50 à 80
- Quand je consulte le journal d'administration
- Alors je vois l'ancienne et la nouvelle valeur, mon nom, la date et l'heure

**CA 5.1 — Accès refusé aux autres profils**
- Étant donné que je suis utilisateur principal
- Quand je navigue dans MAAQ
- Alors la fiche de compte de l'administration ne m'est jamais proposée

**CA 6.1 — Nombre d'invités en lecture seule**
- Étant donné que je suis administrateur
- Quand j'ouvre la fiche du compte de Camille
- Alors je vois le nombre d'invités autorisé, sans possibilité de le modifier

**CA 7.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand j'enregistre le plafond
- Alors le message d'erreur standard s'affiche et la valeur précédente reste en vigueur

**CA 7.2 — Chargement**
- Étant donné que j'enregistre le plafond
- Quand l'enregistrement est en cours
- Alors un indicateur de chargement s'affiche

**CA 7.3 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand l'enregistrement dépasse 15 secondes
- Alors le message de connexion lente s'affiche et la valeur précédente reste en vigueur

---


# Module I — Réglages

## US-49 — Accéder aux Réglages

**En tant qu'** utilisateur, invité ou administrateur,
**je souhaite** accéder à une page Réglages regroupant les rubriques de gestion de l'application,
**afin de** retrouver facilement l'aide, le support et le carnet.

**Écran(s) maquette :** Réglages utilisateur ; Réglages invité ; Support administrateur. **Dépendances :** US-9, US-12, US-50, US-53, US-54, US-55, US-56, US-62.

### Règles fonctionnelles

RF1 — Les Réglages sont accessibles depuis la navigation principale.

RF2 — Les Réglages de l'utilisateur principal comprennent, dans cet ordre [À CONFIRMER avec UX] :
- Mes informations et Informations de mes invités ;
- Invités ;
- Connecteurs ;
- Appareils ;
- Aide et support, puis Carnet ;
- Confidentialité et conditions d'utilisation ;
- Exporter mes données ;
- Désabonnement et suppression du compte ;
- Se déconnecter.

RF3 — Les Réglages de l'invité comprennent :
- Mes informations ;
- Mes connecteurs ;
- Aide et support, puis Carnet ;
- Confidentialité et conditions d'utilisation ;
- Exporter mes données ;
- Supprimer mon compte ;
- Se déconnecter.

RF4 — Les Réglages de l'administrateur comprennent : Aide et support, et Se déconnecter.

RF5 — La rubrique « Carnet » est placée juste sous « Aide et support ».

RF6 — Pendant le chargement des informations affichées dans les Réglages, un indicateur de chargement s'affiche (CC-1).

RF7 — En cas d'erreur serveur, le message d'erreur standard s'affiche. Les entrées de menu restent accessibles (CC-2).

RF8 — En cas de délai dépassé, le message de connexion lente s'affiche avec un bouton « Réessayer » (CC-3).

### Règles techniques

RT1 — [frontend] Le contenu des Réglages dépend du profil connecté. Une rubrique non autorisée n'est jamais affichée ni accessible directement.

### UX / Design

D'après la maquette : une liste de rubriques groupées par sections, avec « Se déconnecter » en bas de page.

**Impact maquette :** Ajustement — Liste complète des rubriques par profil, dans l'ordre retenu ; Libellé « Désabonnement et suppression du compte » pour l'utilisateur principal.

### Critères d'acceptance

**CA 1.1 — Accès depuis la navigation**
- Étant donné que je suis sur mon dashboard
- Quand je touche « Réglages »
- Alors la page Réglages s'affiche

**CA 2.1 — Réglages de l'utilisateur principal**
- Étant donné que je suis utilisateur principal
- Quand j'ouvre les Réglages
- Alors je vois notamment les rubriques Invités, Appareils, Carnet et Supprimer mon compte

**CA 3.1 — Réglages de l'invité**
- Étant donné que je suis invité
- Quand j'ouvre les Réglages
- Alors je ne vois ni la rubrique Invités ni la rubrique Appareils

**CA 4.1 — Réglages de l'administrateur**
- Étant donné que je suis administrateur
- Quand j'ouvre les Réglages
- Alors je vois uniquement Aide et support, et Se déconnecter

**CA 5.1 — Position du Carnet**
- Étant donné que je suis invité
- Quand j'ouvre les Réglages
- Alors la rubrique « Carnet » est juste sous « Aide et support »

**CA 6.1 — Chargement**
- Étant donné que j'ouvre les Réglages
- Quand les informations sont en cours de chargement
- Alors un indicateur de chargement s'affiche

**CA 7.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand j'ouvre les Réglages
- Alors le message d'erreur standard s'affiche et je peux toucher « Se déconnecter »

**CA 8.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand le chargement dépasse 15 secondes
- Alors le message de connexion lente s'affiche avec un bouton « Réessayer »

---

## US-50 — Accéder aux carnets de bord depuis les Réglages

**En tant qu'** utilisateur ou invité,
**je souhaite** accéder au carnet de bord d'un agent depuis une rubrique « Carnet » des Réglages, placée sous « Aide et support »,
**afin de** consulter l'historique des demandes et actions sans encombrer la navigation principale.

**Écran(s) maquette :** Réglages utilisateur / invité (lien « Carnet ») → Carnet de bord. **Dépendances :** US-40, US-49.

### Règles fonctionnelles

RF1 — La rubrique « Carnet » des Réglages ouvre le carnet de bord (US-40), avec le sélecteur d'agents.

RF2 — Par défaut, le carnet sélectionne le premier agent de la liste, les agents étant classés par ordre alphabétique.

RF3 — Si le profil n'a aucune entrée visible pour aucun agent, le message « Aucun carnet disponible pour le moment » s'affiche.

RF4 — Aucune entrée « Carnet » n'existe dans la navigation principale.

RF5 — Le bouton retour du carnet ramène aux Réglages.

RF6 — Pendant le chargement de la liste des agents, un indicateur de chargement s'affiche (CC-1).

RF7 — En cas d'erreur serveur, le message d'erreur standard s'affiche avec un bouton « Réessayer » (CC-2).

RF8 — En cas de délai dépassé, le message de connexion lente s'affiche avec un bouton « Réessayer » (CC-3).

### Règles techniques

RT1 — [backend] La liste des agents proposés applique la règle de visibilité D3 (voir US-40).

### UX / Design

D'après la maquette : un lien « Carnet » avec une flèche dans la liste des Réglages, qui ouvre l'écran Carnet de bord.

**Impact maquette :** Ajustement — État « Aucun carnet disponible ».

### Critères d'acceptance

**CA 1.1 — Ouverture du carnet**
- Étant donné que je suis dans les Réglages
- Quand je touche « Carnet »
- Alors le carnet de bord s'affiche avec le sélecteur d'agents

**CA 2.1 — Agent sélectionné par défaut**
- Étant donné que j'ai des entrées pour Admin_Classify et Admin_lib
- Quand j'ouvre le carnet
- Alors Admin_Classify est sélectionné

**CA 3.1 — Aucun carnet**
- Étant donné que je n'ai aucune entrée visible
- Quand j'ouvre le carnet
- Alors le message « Aucun carnet disponible pour le moment » s'affiche

**CA 4.1 — Absent de la navigation**
- Étant donné que je suis connecté
- Quand je regarde la navigation principale
- Alors aucune entrée « Carnet » n'y figure

**CA 5.1 — Retour aux Réglages**
- Étant donné que le carnet est affiché
- Quand je touche le bouton retour
- Alors les Réglages s'affichent

**CA 6.1 — Chargement**
- Étant donné que j'ouvre le carnet
- Quand la liste des agents est en cours de chargement
- Alors un indicateur de chargement s'affiche

**CA 7.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand j'ouvre le carnet
- Alors le message d'erreur standard s'affiche avec un bouton « Réessayer »

**CA 8.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand le chargement dépasse 15 secondes
- Alors le message de connexion lente s'affiche avec un bouton « Réessayer »

---

# Module J — Sécurité & Conformité (RGPD, AI Act)

## US-51 — Vérifier mon identité sur un nouvel appareil

**En tant qu'** utilisateur, invité ou administrateur,
**je souhaite** confirmer mon identité avec un code reçu par email ou SMS lors de ma première connexion sur un nouvel appareil,
**afin que** personne d'autre ne puisse accéder à mon compte depuis un autre téléphone ou ordinateur.

**Écran(s) maquette :** Vérification d'identité (onglets Email / SMS). **Dépendances :** US-3, US-6, US-53.

### Règles fonctionnelles

RF1 — Après une connexion réussie par email et mot de passe sur un appareil non reconnu, l'écran de vérification s'affiche avant tout accès. Il propose de recevoir un code par email, ou par SMS si un numéro de téléphone est connu pour le profil.

RF2 — Le code comporte 6 chiffres. Il est valable 10 minutes et ne peut être utilisé qu'une fois.

RF3 — Un code correct enregistre l'appareil comme reconnu, avec son type, son navigateur et la date. L'appareil apparaît ensuite dans la liste des appareils (US-53).

RF4 — Un code incorrect affiche « Code incorrect ». Après 5 codes incorrects, le code est invalidé et un nouveau code doit être demandé.

RF5 — Un code expiré affiche « Ce code a expiré » avec un bouton « Recevoir un nouveau code ».

RF6 — Le bouton « Recevoir un nouveau code » n'est actif que 60 secondes après l'envoi précédent. Le profil peut changer de canal (email ou SMS) à tout moment.

RF7 — La vérification n'est demandée qu'une fois par appareil. Elle est redemandée si l'appareil a été révoqué (US-53), ou si les données de l'application ont été effacées.

RF8 — Après chaque nouvel appareil vérifié, un email « Nouvel appareil connecté à votre compte » est envoyé au profil. Si l'email cite une date et une heure, elles sont exprimées dans le fuseau de l'appareil concerné (décision D21 du 01/10/2026).

RF9 — La vérification s'applique à tous les profils, y compris l'administrateur.

RF10 — Pendant l'envoi et la vérification du code, un indicateur de chargement s'affiche et le bouton est désactivé (CC-1).

RF11 — En cas d'erreur serveur, le message d'erreur standard s'affiche et le code saisi est conservé (CC-2).

RF12 — En cas de délai dépassé, le message de connexion lente s'affiche et le code saisi est conservé (CC-3).

### Règles techniques

RT1 — [backend] L'appareil reconnu est identifié par un identifiant propre à MAAQ, conservé sur l'appareil et associé au profil côté serveur.

RT2 — [backend] Les codes ne sont jamais conservés en clair.

RT3 — [backend] Les SMS sont envoyés par un prestataire hébergeant ses données dans l'Union européenne.

RT4 — [backend] Le fuseau horaire de l'appareil est mémorisé à chaque connexion (décision D21 du 01/10/2026).

### UX / Design

D'après la maquette : deux onglets, « Email » et « SMS », avec 6 cases de saisie du code et le lien « Recevoir un nouveau code ». L'email et le numéro de destination sont affichés partiellement masqués.

**Impact maquette :** Ajustement — Onglet SMS masqué sans numéro ; Code incorrect, code expiré, délai avant renvoi.

### Critères d'acceptance

**CA 1.1 — Affichage sur un nouvel appareil**
- Étant donné que je me connecte depuis un téléphone jamais utilisé
- Quand mes identifiants sont acceptés
- Alors l'écran de vérification s'affiche avec les choix Email et SMS

**CA 1.2 — SMS indisponible sans numéro**
- Étant donné qu'aucun numéro de téléphone n'est connu pour mon profil
- Quand l'écran de vérification s'affiche
- Alors seul l'onglet Email est proposé

**CA 2.1 — Réception du code**
- Étant donné que je choisis le SMS
- Quand je demande le code
- Alors je reçois un SMS contenant un code de 6 chiffres valable 10 minutes

**CA 3.1 — Code correct**
- Étant donné que j'ai reçu un code
- Quand je le saisis correctement
- Alors j'accède à MAAQ et l'appareil figure dans la liste des appareils

**CA 4.1 — Code incorrect**
- Étant donné que j'ai reçu un code
- Quand je saisis un code erroné
- Alors le message « Code incorrect » s'affiche

**CA 4.2 — Cinq codes incorrects**
- Étant donné que j'ai saisi 4 codes incorrects
- Quand je saisis un cinquième code incorrect
- Alors le code est invalidé et je dois en demander un nouveau

**CA 5.1 — Code expiré**
- Étant donné que mon code a été envoyé il y a 11 minutes
- Quand je le saisis
- Alors le message « Ce code a expiré » s'affiche avec un bouton « Recevoir un nouveau code »

**CA 6.1 — Changement de canal**
- Étant donné que j'ai demandé un code par SMS
- Quand je choisis l'onglet Email et demande un code
- Alors je reçois un code par email

**CA 7.1 — Une seule fois par appareil**
- Étant donné que j'ai déjà vérifié ce téléphone
- Quand je me reconnecte par email et mot de passe
- Alors aucun code ne m'est demandé

**CA 7.2 — Appareil révoqué**
- Étant donné que mon appareil a été révoqué
- Quand je me reconnecte depuis cet appareil
- Alors l'écran de vérification s'affiche de nouveau

**CA 8.1 — Email d'alerte**
- Étant donné que je viens de vérifier un nouvel appareil
- Quand je consulte ma boîte mail
- Alors j'ai reçu un email « Nouvel appareil connecté à votre compte »

**CA 9.1 — Administrateur**
- Étant donné que je suis administrateur et que j'utilise un nouvel ordinateur
- Quand mes identifiants sont acceptés
- Alors l'écran de vérification s'affiche

**CA 10.1 — Chargement**
- Étant donné que j'ai saisi le code
- Quand la vérification est en cours
- Alors un indicateur de chargement s'affiche et le bouton est désactivé

**CA 11.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand je valide mon code
- Alors le message d'erreur standard s'affiche et le code reste saisi

**CA 12.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand la vérification dépasse 15 secondes
- Alors le message de connexion lente s'affiche et le code reste saisi

---

## US-52 — Verrouiller automatiquement l'application après inactivité

**En tant qu'** utilisateur, invité ou administrateur,
**je souhaite** que l'application se verrouille après 5 minutes d'inactivité,
**afin de** protéger mes données si je laisse mon téléphone sans surveillance.

**Écran(s) maquette :** Écran verrouillé. **Dépendances :** US-6, US-7, US-43.

### Règles fonctionnelles

RF1 — Après 5 minutes sans aucune interaction (toucher, saisie, défilement), MAAQ affiche l'écran verrouillé et masque tout le contenu.

RF2 — Si MAAQ reste en arrière-plan plus de 5 minutes, elle est verrouillée au retour.

RF3 — Le déverrouillage se fait avec le schéma tactile (US-6). Il ramène exactement à l'écran précédent, et le texte en cours de saisie est conservé.

RF4 — Les échecs de schéma sur l'écran verrouillé comptent dans la limite de 3 échecs (US-7).

RF5 — Le verrouillage n'est pas une déconnexion : l'historique des tchats est conservé (US-43, US-44).

RF6 — Une réponse d'agent arrivée pendant le verrouillage s'affiche après le déverrouillage.

RF7 — Un envoi de document en cours (US-34) n'est pas interrompu par le verrouillage.

RF8 — Pour l'administrateur, sur ordinateur, le verrouillage intervient aussi après 5 minutes, et le déverrouillage se fait par mot de passe.

RF9 — Pendant la vérification du schéma de déverrouillage, un indicateur de chargement s'affiche (CC-1).

RF10 — En cas d'erreur serveur, le message d'erreur standard s'affiche, et la tentative n'est pas comptée comme un échec (CC-2).

RF11 — En cas de délai dépassé, le message de connexion lente s'affiche, et la tentative n'est pas comptée comme un échec (CC-3).

### Règles techniques

RT1 — [frontend] La durée d'inactivité est mesurée sur l'appareil et reste valable même si le téléphone s'est mis en veille.

RT2 — [frontend] Le contenu masqué par le verrouillage n'apparaît pas dans l'aperçu des applications ouvertes du téléphone.

### UX / Design

D'après la maquette : un écran avec le logo MAAQ, le prénom du profil et la grille de schéma, le contenu de l'application étant entièrement masqué.

**Impact maquette :** Nouvel écran — Écran verrouillé de l'administrateur (déverrouillage par mot de passe).

### Critères d'acceptance

**CA 1.1 — Verrouillage après 5 minutes**
- Étant donné que je consulte mon dashboard
- Quand je n'interagis pas pendant 5 minutes
- Alors l'écran verrouillé s'affiche et le dashboard est masqué

**CA 2.1 — Retour depuis l'arrière-plan**
- Étant donné que j'ai quitté MAAQ pour une autre application
- Quand j'y reviens après 6 minutes
- Alors l'écran verrouillé s'affiche

**CA 3.1 — Retour à l'écran précédent**
- Étant donné que j'étais en train de saisir un message à Admin_lib quand MAAQ s'est verrouillée
- Quand je trace mon schéma correct
- Alors le tchat d'Admin_lib s'affiche avec mon texte en cours de saisie

**CA 4.1 — Échecs comptés**
- Étant donné que j'ai échoué 2 fois sur l'écran verrouillé
- Quand j'échoue une troisième fois
- Alors l'écran de schéma verrouillé s'affiche

**CA 5.1 — Historique conservé**
- Étant donné que MAAQ s'est verrouillée
- Quand je la déverrouille
- Alors l'historique de mes tchats est intact

**CA 6.1 — Réponse arrivée pendant le verrouillage**
- Étant donné qu'Admin_lib traitait ma demande quand MAAQ s'est verrouillée
- Quand je déverrouille
- Alors la réponse d'Admin_lib est affichée

**CA 7.1 — Envoi de document**
- Étant donné qu'un document est en cours d'envoi
- Quand MAAQ se verrouille
- Alors l'envoi se poursuit

**CA 8.1 — Administrateur**
- Étant donné que je suis administrateur
- Quand je reste inactif 5 minutes
- Alors l'écran verrouillé me demande mon mot de passe

**CA 9.1 — Chargement**
- Étant donné que je trace mon schéma sur l'écran verrouillé
- Quand la vérification est en cours
- Alors un indicateur de chargement s'affiche

**CA 10.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand je trace mon schéma
- Alors le message d'erreur standard s'affiche et mon nombre de tentatives restantes est inchangé

**CA 11.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand la vérification dépasse 15 secondes
- Alors le message de connexion lente s'affiche et mon nombre de tentatives restantes est inchangé

---

## US-53 — Révoquer l'accès d'un appareil

**En tant qu'** utilisateur principal ou administrateur,
**je souhaite** révoquer l'accès d'un appareil, le mien ou celui d'un invité,
**afin de** protéger le compte en cas de perte ou de vol d'un téléphone.

**Écran(s) maquette :** Appareils connectés (côté utilisateur principal). Pas d'écran côté administrateur. **Dépendances :** US-51, US-43.

### Règles fonctionnelles

RF1 — Réglages > Appareils affiche, pour l'utilisateur principal, deux sections :
- « Mes appareils » ;
- « Appareils de mes invités », regroupés par invité.

Chaque appareil indique son type, son navigateur, sa date de première connexion et sa dernière activité. L'appareil en cours d'utilisation porte la mention « Cet appareil ».

RF2 — Chaque appareil propose un bouton « Révoquer ». Il ouvre la confirmation « Révoquer l'accès de cet appareil ? La personne devra vérifier à nouveau son identité pour se reconnecter. ».

RF3 — À la confirmation, la session de l'appareil est fermée immédiatement. L'appareil disparaît de la liste. Il devra repasser par la vérification d'identité (US-51) pour se reconnecter.

RF4 — Révoquer « Cet appareil » équivaut à une déconnexion, avec l'effacement de l'historique des tchats (US-43).

RF5 — Le profil dont l'appareil est révoqué reçoit un email l'en informant.

RF6 — Un invité n'a pas accès à la rubrique Appareils.

RF7 — L'administrateur peut rechercher un compte (utilisateur principal ou invité), afficher ses appareils et les révoquer, avec les mêmes règles. Cet écran n'est pas maquetté.

RF8 — Pendant la révocation, un indicateur de chargement s'affiche sur le bouton de confirmation (CC-1).

RF9 — En cas d'erreur serveur, le message d'erreur standard s'affiche et l'appareil n'est pas révoqué (CC-2).

RF10 — En cas de délai dépassé, le message de connexion lente s'affiche et l'appareil n'est pas révoqué (CC-3).

### Règles techniques

RT1 — [backend] La révocation invalide côté serveur toutes les sessions de l'appareil et son statut d'appareil reconnu.

RT2 — [backend] Chaque révocation est enregistrée dans le journal des événements de sécurité, avec son auteur.

### UX / Design

D'après la maquette : une liste d'appareils avec une icône par type (téléphone, ordinateur) et un bouton « Révoquer » par ligne. L'écran équivalent côté administrateur est à concevoir.

**Impact maquette :** Nouvel écran — Écran administrateur de recherche d'un compte et de révocation de ses appareils.

### Critères d'acceptance

**CA 1.1 — Liste des appareils**
- Étant donné que Camille utilise un téléphone et que Thomas en utilise un
- Quand Camille ouvre Réglages > Appareils
- Alors elle voit son téléphone dans « Mes appareils » avec la mention « Cet appareil », et celui de Thomas dans « Appareils de mes invités »

**CA 2.1 — Confirmation**
- Étant donné que la liste est affichée
- Quand Camille touche « Révoquer » sur le téléphone de Thomas
- Alors la confirmation « Révoquer l'accès de cet appareil ? La personne devra vérifier à nouveau son identité pour se reconnecter. » s'affiche

**CA 3.1 — Révocation effective**
- Étant donné que Camille a confirmé la révocation du téléphone de Thomas
- Quand Thomas utilise MAAQ sur ce téléphone
- Alors il est renvoyé à l'écran de connexion
- Et après ses identifiants, l'écran de vérification d'identité s'affiche

**CA 4.1 — Révocation de son propre appareil**
- Étant donné que Camille révoque « Cet appareil »
- Quand la révocation est confirmée
- Alors Camille est déconnectée et l'historique de ses tchats est effacé

**CA 5.1 — Email d'information**
- Étant donné que l'appareil de Thomas a été révoqué
- Quand Thomas consulte sa boîte mail
- Alors il a reçu un email l'informant de la révocation

**CA 6.1 — Rubrique absente pour l'invité**
- Étant donné que je suis invité
- Quand j'ouvre mes Réglages
- Alors la rubrique Appareils n'est pas affichée

**CA 7.1 — Révocation par l'administrateur**
- Étant donné que je suis administrateur
- Quand je recherche le compte de Thomas et révoque son téléphone
- Alors Thomas doit vérifier à nouveau son identité pour se reconnecter

**CA 8.1 — Chargement**
- Étant donné que Camille confirme une révocation
- Quand elle est en cours
- Alors un indicateur de chargement s'affiche

**CA 9.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand Camille confirme une révocation
- Alors le message d'erreur standard s'affiche et l'appareil est toujours dans la liste

**CA 10.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand la révocation dépasse 15 secondes
- Alors le message de connexion lente s'affiche et l'appareil est toujours dans la liste

---

## US-54 — Consulter la politique de confidentialité et les conditions d'utilisation

**En tant qu'** utilisateur ou invité,
**je souhaite** consulter la politique de confidentialité et les conditions d'utilisation de MAAQ,
**afin de** savoir comment mes données sont utilisées et protégées.

**Écran(s) maquette :** Confidentialité / CGU (textes en attente) ; lien sur l'écran d'activation du compte invité. **Dépendances :** US-4, US-49.

### Règles fonctionnelles

RF1 — La politique de confidentialité et les conditions d'utilisation sont accessibles depuis les Réglages, depuis l'écran de connexion (sans être connecté) et depuis l'écran d'activation du compte invité.

RF2 — Chaque document affiche sa date de dernière mise à jour.

RF3 — À l'activation d'un compte invité (US-4) et à la première connexion d'un utilisateur principal, l'acceptation des deux documents est obligatoire, par une case à cocher.

RF4 — Lorsqu'une nouvelle version d'un document est publiée, son acceptation est redemandée à la connexion suivante, avant tout accès.

RF5 — Les textes sont fournis par MAAQ. Tant qu'ils ne le sont pas, la mise en production est bloquée.

RF6 — Pendant le chargement d'un document, un indicateur de chargement s'affiche (CC-1).

RF7 — En cas d'erreur serveur, le message d'erreur standard s'affiche avec un bouton « Réessayer » (CC-2).

RF8 — En cas de délai dépassé, le message de connexion lente s'affiche avec un bouton « Réessayer » (CC-3).

### Règles techniques

RT1 — [backend] Chaque acceptation est enregistrée avec le profil, la date, l'heure et la version du document.

RT2 — [backend] Les versions successives des documents sont conservées.

### UX / Design

D'après la maquette : un écran avec deux onglets (« Confidentialité », « Conditions d'utilisation ») et un texte défilant. Les textes sont en attente dans la maquette.

**Impact maquette :** Nouvel écran — Fenêtre d'acceptation d'une nouvelle version des documents à la connexion ; Lien « Confidentialité » sur l'écran de connexion.

### Critères d'acceptance

**CA 1.1 — Accès depuis les Réglages**
- Étant donné que je suis connecté
- Quand je touche « Confidentialité et conditions d'utilisation » dans les Réglages
- Alors les deux documents sont consultables

**CA 1.2 — Accès sans être connecté**
- Étant donné que je ne suis pas connecté
- Quand je touche le lien « Confidentialité » de l'écran de connexion
- Alors la politique de confidentialité s'affiche

**CA 2.1 — Date de mise à jour**
- Étant donné que j'ouvre la politique de confidentialité
- Quand elle s'affiche
- Alors sa date de dernière mise à jour est indiquée

**CA 3.1 — Acceptation obligatoire**
- Étant donné que je suis un invité en cours d'activation
- Quand je n'ai pas coché l'acceptation
- Alors je ne peux pas poursuivre

**CA 4.1 — Nouvelle version**
- Étant donné qu'une nouvelle version des conditions d'utilisation a été publiée
- Quand je me connecte
- Alors l'acceptation de la nouvelle version m'est demandée avant tout accès

**CA 5.1 — Textes manquants**
- Étant donné que les textes définitifs n'ont pas été fournis par MAAQ
- Quand la mise en production est envisagée
- Alors elle est bloquée

**CA 6.1 — Chargement**
- Étant donné que j'ouvre un document
- Quand il est en cours de chargement
- Alors un indicateur de chargement s'affiche

**CA 7.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand j'ouvre un document
- Alors le message d'erreur standard s'affiche avec un bouton « Réessayer »

**CA 8.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand le chargement dépasse 15 secondes
- Alors le message de connexion lente s'affiche avec un bouton « Réessayer »

---

## US-55 — Exporter mes données

**En tant qu'** utilisateur ou invité,
**je souhaite** exporter une copie de mes données depuis un bouton des Réglages,
**afin d'** exercer mon droit d'accès et de portabilité sans passer par le support.

**Écran(s) maquette :** Réglages utilisateur / invité (bouton « Exporter mes données »). **Dépendances :** US-49.

### Règles fonctionnelles

RF1 — Le bouton « Exporter mes données » ouvre une confirmation. Elle précise le contenu de l'export et le délai de préparation, et propose « Demander l'export » et « Annuler ».

RF2 — Chaque profil exporte ses propres données, sans passer par l'utilisateur principal. L'export contient :
- les informations du profil ;
- pour l'utilisateur principal, les informations de ses invités qu'il a renseignées ;
- les adresses des connecteurs et la boîte de validation ;
- les adresses en copie saisies par le profil ;
- les entrées du carnet dont il est l'auteur ;
- les détails et documents de contrats qu'il a renseignés ;
- ses consentements ;
- la liste de ses appareils.

RF3 — L'export est préparé en arrière-plan. Un email contenant un lien de téléchargement, valable 7 jours, est envoyé au profil.

RF4 — Le fichier contient un document lisible par une personne, et les mêmes données dans un format structuré réutilisable.

RF5 — Une seule demande peut être en cours à la fois. Pendant la préparation, le bouton affiche « Export en cours de préparation ».

RF6 — Le téléchargement exige que le profil soit connecté à MAAQ.

RF7 — Pendant l'enregistrement de la demande, un indicateur de chargement s'affiche (CC-1).

RF8 — En cas d'erreur serveur, le message d'erreur standard s'affiche et aucune demande n'est enregistrée (CC-2).

RF9 — En cas de délai dépassé, le message de connexion lente s'affiche avec un bouton « Réessayer » (CC-3).

RF10 — Si la préparation de l'export échoue, le profil reçoit un email l'invitant à renouveler sa demande, et le bouton redevient actif.

### Règles techniques

RT1 — [backend] Les données détenues par Digitorn (historique, configuration des agents) sont récupérées par l'API Digitorn et intégrées à l'export (décision du 30/09/2026).

RT2 — [backend] Le fichier d'export est chiffré et supprimé automatiquement à l'expiration du lien.

### UX / Design

D'après la maquette : le bouton « Exporter mes données » dans les Réglages. La confirmation et l'état « en cours de préparation » sont des ajouts à la maquette.

**Impact maquette :** Ajustement — Fenêtre de confirmation décrivant le contenu de l'export ; État « Export en cours de préparation ».

### Critères d'acceptance

**CA 1.1 — Confirmation**
- Étant donné que je suis dans les Réglages
- Quand je touche « Exporter mes données »
- Alors une confirmation décrit le contenu et le délai de l'export

**CA 2.1 — Export propre à l'invité**
- Étant donné que je suis Thomas, invité
- Quand je demande l'export
- Alors l'export contient mes données, sans celles de Camille

**CA 3.1 — Réception du lien**
- Étant donné que j'ai demandé l'export
- Quand il est prêt
- Alors je reçois un email contenant un lien valable 7 jours

**CA 4.1 — Contenu lisible et réutilisable**
- Étant donné que je télécharge mon export
- Quand je l'ouvre
- Alors il contient un document lisible et un fichier de données structurées

**CA 5.1 — Une demande à la fois**
- Étant donné qu'un export est en préparation
- Quand je retourne dans les Réglages
- Alors le bouton affiche « Export en cours de préparation » et est inactif

**CA 6.1 — Connexion requise**
- Étant donné que je ne suis pas connecté
- Quand j'ouvre le lien de téléchargement
- Alors l'écran de connexion s'affiche avant le téléchargement

**CA 7.1 — Chargement**
- Étant donné que je touche « Demander l'export »
- Quand la demande est en cours d'enregistrement
- Alors un indicateur de chargement s'affiche

**CA 8.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand je demande l'export
- Alors le message d'erreur standard s'affiche

**CA 9.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand la demande dépasse 15 secondes
- Alors le message de connexion lente s'affiche avec un bouton « Réessayer »

**CA 10.1 — Échec de préparation**
- Étant donné que la préparation de mon export a échoué
- Quand je consulte ma boîte mail
- Alors un email m'invite à renouveler ma demande
- Et le bouton « Exporter mes données » est de nouveau actif

---

## US-56 — Supprimer mes données et mon compte

**En tant qu'** utilisateur ou invité,
**je souhaite** supprimer mes données et mon compte depuis un bouton des Réglages,
**afin d'** exercer mon droit à l'effacement sans passer par le support.

**Écran(s) maquette :** Réglages utilisateur / invité (bouton « Supprimer mon compte et mes données », avec confirmation). **Dépendances :** US-57, US-58, US-59.

### Règles fonctionnelles

RF1 — Le bouton de suppression (libellé défini en RF8) ouvre un écran qui explique :
- les données supprimées ;
- le délai de grâce de 30 jours, avant lequel la suppression n'est pas définitive (décision D18 du 01/10/2026) ;
- pour l'utilisateur principal, que les comptes de tous ses invités seront aussi supprimés ;
- pour un invité, que ses demandes resteront dans le carnet sans son nom (US-57).

RF2 — Pour confirmer, le profil doit saisir son mot de passe.

RF3 — Après la confirmation, le compte est désactivé : toutes les sessions du profil sont fermées, et un email lui indique la date de suppression définitive.

RF4 — Pendant le délai de grâce, le profil peut annuler la suppression (US-59).

RF5 — À la fin du délai de grâce, les données du profil sont supprimées définitivement chez MAAQ et chez Digitorn.

RF6 — Pour un utilisateur principal, ses invités sont informés par email. Leur accès est coupé dès la confirmation.

RF7 — Pour un invité, ses adresses en copie sont supprimées. Les informations de contrats qu'il a renseignées restent, car elles appartiennent au compte partagé.

RF8 — Pour l'utilisateur principal, la suppression du compte vaut désabonnement : le bouton s'appelle « Désabonnement et suppression du compte ». Pour un invité, qui n'a pas d'abonnement, il s'appelle « Supprimer mon compte et mes données » (décision du 30/09/2026).

RF9 — Pendant la suppression, un indicateur de chargement s'affiche sur le bouton de confirmation (CC-1).

RF10 — En cas d'erreur serveur, le message d'erreur standard s'affiche et le compte n'est pas désactivé (CC-2).

RF11 — En cas de délai dépassé, le message de connexion lente s'affiche et le compte n'est pas désactivé (CC-3).

### Règles techniques

RT1 — [backend] La suppression définitive côté Digitorn passe par l'interface de suppression dédiée, déclenchée par MAAQ à la fin du délai (décision du 29/09/2026).

RT2 — [backend] Un traitement quotidien déclenche les suppressions arrivées à échéance.

### UX / Design

D'après la maquette : le bouton rouge « Supprimer mon compte et mes données » et un texte de confirmation mentionnant le délai de grâce.

**Impact maquette :** Ajustement — Mention « délai de grâce de 30 jours » ; Écran d'explication des conséquences, avec saisie du mot de passe ; Libellé « Désabonnement et suppression du compte » pour l'utilisateur principal.

### Critères d'acceptance

**CA 1.1 — Explications pour l'utilisateur principal**
- Étant donné que je suis utilisateur principal
- Quand je touche « Désabonnement et suppression du compte »
- Alors l'écran m'indique le délai de grâce de 30 jours et la suppression des comptes de mes invités

**CA 1.2 — Explications pour l'invité**
- Étant donné que je suis invité
- Quand je touche « Supprimer mon compte et mes données »
- Alors l'écran m'indique que mes demandes resteront dans le carnet sans mon nom

**CA 2.1 — Mot de passe requis**
- Étant donné que l'écran de confirmation est affiché
- Quand je saisis un mot de passe erroné
- Alors la suppression n'est pas lancée et un message indique que le mot de passe est incorrect

**CA 3.1 — Désactivation**
- Étant donné que j'ai confirmé avec mon mot de passe
- Quand la suppression est enregistrée
- Alors je suis déconnecté de tous mes appareils
- Et je reçois un email indiquant la date de suppression définitive

**CA 4.1 — Annulation pendant le délai**
- Étant donné que j'ai demandé la suppression il y a 10 jours
- Quand je me reconnecte
- Alors je peux annuler la suppression

**CA 5.1 — Suppression définitive**
- Étant donné que le délai de grâce est écoulé
- Quand le traitement quotidien s'exécute
- Alors mes données sont supprimées chez MAAQ et chez Digitorn

**CA 6.1 — Invités informés**
- Étant donné que Camille a confirmé la suppression de son compte
- Quand Thomas utilise MAAQ
- Alors son accès est coupé et il a reçu un email d'information

**CA 7.1 — Données de l'invité**
- Étant donné que Thomas a renseigné l'assureur de l'Assurance Auto et ajouté des adresses en copie
- Quand la suppression de son compte devient définitive
- Alors ses adresses en copie sont supprimées et l'assureur reste renseigné pour Camille

**CA 8.1 — Suppression valant désabonnement**
- Étant donné que Camille a supprimé son compte
- Quand l'équipe MAAQ consulte son abonnement
- Alors son abonnement est résilié

**CA 9.1 — Chargement**
- Étant donné que je confirme la suppression
- Quand elle est en cours
- Alors un indicateur de chargement s'affiche

**CA 10.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand je confirme la suppression
- Alors le message d'erreur standard s'affiche et mon compte reste actif

**CA 11.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand la confirmation dépasse 15 secondes
- Alors le message de connexion lente s'affiche et mon compte reste actif

---

## US-57 — Anonymiser les demandes d'un invité supprimé dans le carnet partagé

**En tant qu'** utilisateur principal,
**je souhaite** que les demandes d'un invité qui a supprimé ses données restent visibles dans le carnet de bord sans son nom,
**afin de** conserver la traçabilité des actions réalisées tout en respectant le droit à l'effacement de l'invité.

**Écran(s) maquette :** aucun écran dédié (traitement appliqué au Carnet de bord). **Dépendances :** US-40, US-56, US-20. **Décisions appliquées :** D3.

### Règles fonctionnelles

RF1 — Lorsque la suppression du compte d'un invité devient définitive, ses entrées dans le carnet sont conservées. Son prénom y est remplacé par la mention « Invité supprimé ».

RF2 — Les données personnelles de l'invité présentes dans le texte des entrées (nom, téléphone, adresse) sont retirées ou masquées.

RF3 — Les entrées anonymisées restent visibles jusqu'à la fin de la durée de conservation du carnet (US-40), puis sont supprimées.

RF4 — L'anonymisation s'applique aussi lorsque l'invité est supprimé par l'utilisateur principal (US-20).

RF5 — La règle de visibilité D3 continue de s'appliquer aux entrées anonymisées.

RF6 — Si l'anonymisation échoue (erreur ou délai dépassé), elle est réessayée automatiquement. Une entrée n'est jamais affichée avec le nom d'un invité dont la suppression est définitive (CC-2, CC-3).

RF7 — Pendant l'anonymisation, les entrées concernées sont masquées du carnet (CC-1).

### Règles techniques

RT1 — [backend] L'anonymisation doit aussi être appliquée aux données du carnet détenues par Digitorn.

RT2 — [backend] L'anonymisation est irréversible.

### UX / Design

Aucun écran dédié. Dans le carnet, les entrées anonymisées portent une pastille grise neutre à la place de la pastille de couleur de la personne.

**Impact maquette :** Ajustement — Pastille neutre « Invité supprimé » dans le carnet.

### Critères d'acceptance

**CA 1.1 — Nom remplacé**
- Étant donné que Julien avait demandé un rendez-vous à Admin_lib
- Quand la suppression de son compte devient définitive
- Alors l'entrée apparaît dans le carnet avec la mention « Invité supprimé »

**CA 2.1 — Données personnelles masquées**
- Étant donné qu'une demande de Julien contenait son numéro de téléphone
- Quand elle est anonymisée
- Alors le numéro n'apparaît plus dans l'entrée

**CA 3.1 — Conservation limitée**
- Étant donné qu'une entrée anonymisée est plus ancienne que la durée de rétention du carnet
- Quand je consulte le carnet
- Alors elle n'apparaît plus

**CA 4.1 — Invité supprimé par l'utilisateur principal**
- Étant donné que Camille a supprimé Julien
- Quand Camille consulte le carnet
- Alors les entrées de Julien portent la mention « Invité supprimé »

**CA 5.1 — Visibilité maintenue**
- Étant donné qu'Élodie, invitée secondaire, était participante d'une demande anonymisée
- Quand Élodie consulte le carnet
- Alors elle voit toujours cette entrée

**CA 6.1 — Échec d'anonymisation**
- Étant donné que l'anonymisation d'une entrée a échoué
- Quand je consulte le carnet
- Alors l'entrée n'est pas affichée avec le nom de l'invité supprimé

**CA 7.1 — Entrées masquées pendant le traitement**
- Étant donné que l'anonymisation est en cours
- Quand je consulte le carnet
- Alors les entrées concernées ne sont pas affichées

---

## US-58 — Supprimer automatiquement un compte après désabonnement

**En tant qu'** utilisateur principal,
**je souhaite** que mon compte et mes données (contrats, documents, configuration des agents, carnet de bord), ainsi que ceux de mes invités, soient supprimés 30 jours après mon désabonnement,
**afin que** mes données ne soient pas conservées au-delà de mon abonnement.

**Écran(s) maquette :** aucun écran dédié (traitement automatique). **Dépendances :** US-59, US-56, US-57, US-68.

### Règles fonctionnelles

RF1 — Le désabonnement, fait hors de l'application ou par le bouton « Désabonnement et suppression du compte » (US-56), fait entrer le compte de l'utilisateur principal et ceux de ses invités en délai de grâce de 30 jours.

RF2 — Pendant le délai de grâce, l'accès à MAAQ est suspendu pour tous les profils du compte. Seul l'écran de reprise de compte (US-59) est accessible à l'utilisateur principal.

RF3 — L'utilisateur principal reçoit un email au début du délai, puis un rappel 7 jours avant la suppression définitive.

RF4 — À J+30, sont supprimés définitivement, chez MAAQ et chez Digitorn :
- le compte de l'utilisateur principal et ceux de ses invités ;
- les informations de configuration ;
- les contrats et leurs documents ;
- la configuration des agents ;
- le carnet de bord.

RF5 — Si la suppression chez Digitorn échoue (erreur ou délai dépassé), elle est réessayée automatiquement chaque jour, et l'administrateur est alerté (CC-2, CC-3).

RF6 — Pendant la suppression, le compte reste inaccessible (CC-1).

RF7 — Une trace minimale et non nominative de la suppression (date, identifiant technique) est conservée comme preuve.

### Règles techniques

RT1 — [backend] La suppression chez Digitorn passe par l'interface de suppression dédiée, déclenchée par MAAQ à l'issue du délai (décision du 29/09/2026). La suppression automatique des comptes jamais activés est traitée par US-68.

RT2 — [backend] L'information de désabonnement est transmise à MAAQ par l'outil de facturation, hors application.

RT3 — [backend] Les copies de sauvegarde sont purgées au bout de 2 ans (décision du 30/09/2026). Point d'attention du BA : pendant ce délai, des données supprimées restent présentes dans les sauvegardes. Ce délai doit figurer dans la politique de confidentialité et être validé par le DPO [À CONFIRMER avec DPO].

### UX / Design

Aucun écran dédié. Le délai de grâce est mentionné dans le texte de confirmation de suppression (US-56).

**Impact maquette :** aucun ajustement nécessaire.

### Critères d'acceptance

**CA 1.1 — Entrée en délai de grâce**
- Étant donné que Camille s'est désabonnée le 01/11/2026
- Quand le désabonnement est enregistré
- Alors son compte et ceux de ses invités sont en délai de grâce jusqu'au 01/12/2026

**CA 2.1 — Accès suspendu**
- Étant donné que le compte de Camille est en délai de grâce
- Quand Thomas tente de se connecter
- Alors il ne peut pas accéder à MAAQ

**CA 3.1 — Emails d'information**
- Étant donné que le compte de Camille est en délai de grâce
- Quand il reste 7 jours avant la suppression
- Alors Camille reçoit un email de rappel

**CA 4.1 — Suppression définitive**
- Étant donné que le délai de 30 jours est écoulé
- Quand le traitement s'exécute
- Alors les comptes, contrats, documents, configurations et carnets sont supprimés chez MAAQ et chez Digitorn

**CA 5.1 — Échec chez Digitorn**
- Étant donné que la suppression chez Digitorn a échoué
- Quand le traitement du lendemain s'exécute
- Alors la suppression est réessayée et l'administrateur a été alerté

**CA 6.1 — Compte inaccessible pendant la suppression**
- Étant donné que la suppression est en cours
- Quand Camille tente de se connecter
- Alors elle ne peut pas accéder à MAAQ

**CA 7.1 — Trace non nominative**
- Étant donné que le compte de Camille a été supprimé
- Quand l'équipe MAAQ consulte le journal des suppressions
- Alors elle voit la date de suppression sans aucune donnée nominative

---

## US-59 — Reprendre mon compte pendant le délai de grâce

**En tant qu'** utilisateur principal ou invité (décision du 30/09/2026),
**je souhaite** pouvoir me raviser et retrouver mon compte et mes données pendant les 30 jours suivant mon désabonnement,
**afin de** ne pas perdre mes informations si je change d'avis.

**Écran(s) maquette :** aucun écran (non maquetté). **Dépendances :** US-58, US-56, US-3.

### Règles fonctionnelles

RF1 — Pendant le délai de grâce, une connexion réussie de l'utilisateur principal affiche l'écran de reprise de compte : « Votre compte sera supprimé le [date]. » avec les boutons « Annuler la suppression » et « Se déconnecter ».

RF2 — Après un désabonnement, la reprise du compte suppose un nouvel abonnement, souscrit hors de l'application. L'écran l'indique et donne les coordonnées pour le faire.

RF3 — Après une suppression demandée depuis les Réglages (US-56), « Annuler la suppression » rétablit immédiatement le compte et ses données.

RF4 — Une fois le compte repris, les invités retrouvent leur accès et sont informés par email.

RF5 — Une fois le délai passé, le compte n'existe plus et une connexion obtient le message « Email ou mot de passe incorrect » (US-3).

RF6 — Pendant la reprise, le bouton affiche un indicateur de chargement (CC-1).

RF7 — En cas d'erreur serveur, le message d'erreur standard s'affiche et le compte reste en délai de grâce (CC-2).

RF8 — En cas de délai dépassé, le message de connexion lente s'affiche et le compte reste en délai de grâce (CC-3).

RF9 — Un invité qui a supprimé son propre compte peut le reprendre de la même façon pendant son délai de grâce de 30 jours (décision D18 du 01/10/2026) (décision du 30/09/2026). Si le délai de grâce résulte du désabonnement de l'utilisateur principal, seul l'utilisateur principal peut reprendre le compte.

### Règles techniques

RT1 — [backend] Pendant le délai de grâce, aucune donnée n'est supprimée, ni chez MAAQ ni chez Digitorn.

### UX / Design

Non maquetté. Un écran simple est proposé, avec un message d'alerte, la date de suppression et deux boutons.

**Impact maquette :** Nouvel écran — Écran de reprise du compte pendant le délai de grâce, pour l'utilisateur principal et pour l'invité.

### Critères d'acceptance

**CA 1.1 — Écran de reprise**
- Étant donné que le compte de Camille sera supprimé le 01/12/2026
- Quand Camille se connecte le 15/11/2026
- Alors l'écran « Votre compte sera supprimé le 01/12/2026. » s'affiche avec « Annuler la suppression »

**CA 2.1 — Nouvel abonnement requis**
- Étant donné que Camille s'est désabonnée
- Quand elle touche « Annuler la suppression »
- Alors l'écran lui indique comment souscrire un nouvel abonnement

**CA 3.1 — Annulation d'une suppression demandée**
- Étant donné que Camille a demandé la suppression de son compte depuis les Réglages
- Quand elle touche « Annuler la suppression » pendant le délai
- Alors son compte est rétabli avec toutes ses données

**CA 4.1 — Invités rétablis**
- Étant donné que Camille a repris son compte
- Quand Thomas se connecte
- Alors il accède de nouveau à MAAQ

**CA 5.1 — Après le délai**
- Étant donné que le compte de Camille a été supprimé définitivement
- Quand elle tente de se connecter
- Alors le message « Email ou mot de passe incorrect » s'affiche

**CA 6.1 — Chargement**
- Étant donné que Camille touche « Annuler la suppression »
- Quand la reprise est en cours
- Alors un indicateur de chargement s'affiche

**CA 7.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand Camille touche « Annuler la suppression »
- Alors le message d'erreur standard s'affiche et le compte reste en délai de grâce

**CA 8.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand la reprise dépasse 15 secondes
- Alors le message de connexion lente s'affiche et le compte reste en délai de grâce

**CA 9.1 — Reprise par un invité**
- Étant donné que Thomas a supprimé son compte il y a 10 jours
- Quand il se connecte et touche « Annuler la suppression »
- Alors son compte est rétabli avec ses données

**CA 9.2 — Désabonnement de l'utilisateur principal**
- Étant donné que Camille s'est désabonnée
- Quand Thomas se connecte pendant le délai de grâce
- Alors aucune reprise de compte ne lui est proposée

---

## US-68 — Supprimer automatiquement les comptes et invités jamais activés


*US créée suite à la décision D19.*

**En tant qu'** administrateur,
**je souhaite** que les comptes et les invités qui n'ont jamais été activés soient supprimés automatiquement après un délai,
**afin que** MAAQ ne conserve pas de données personnelles sur des personnes qui n'ont jamais activé leur accès.

**Écran(s) maquette :** aucun écran dédié (traitement automatique). **Dépendances :** US-4, US-5, US-18, US-64, US-65.

### Règles fonctionnelles

RF1 — Un compte d'utilisateur principal qui n'a jamais été activé est supprimé 30 jours après le dernier lien d'activation envoyé, qu'il s'agisse de l'envoi initial (US-64 RF4) ou d'un renvoi par l'administrateur (US-64 RF6).

RF2 — Un invité qui n'a jamais activé son accès est supprimé 30 jours après le dernier lien d'invitation envoyé (US-18, US-5). Sa place est libérée dans le quota de l'utilisateur principal (US-21).

RF3 — Le délai de 30 jours est un réglage de la console d'administration (US-65).

RF4 — Un nouvel envoi de lien remet le délai à zéro. Un lien expiré ou invalidé ne prolonge pas le délai.

RF5 — Après la suppression, un lien d'activation ouvert affiche le message de lien expiré : « Ce lien d'invitation a expiré. Demandez à [prénom de l'utilisateur principal] de vous renvoyer une invitation. » pour un invité, et « Ce lien d'activation a expiré. Contactez MAAQ pour recevoir un nouveau lien. » pour un utilisateur principal.

RF6 — Le compte supprimé disparaît de l'écran « Comptes » de l'administrateur (US-64 RF1). L'utilisateur principal supprimé libère son email.

RF7 — Une trace minimale et non nominative de la suppression (date, identifiant technique) est conservée, comme pour US-58 RF7 [Proposition du BA].

RF8 — Si la suppression échoue (erreur ou délai dépassé), elle est réessayée au cycle suivant (CC-2, CC-3).

### Règles techniques

RT1 — [backend] Un traitement quotidien supprime les comptes et les invités jamais activés dont le dernier lien a plus de 30 jours.

RT2 — [backend] Le délai est lu à chaque exécution dans les réglages de la console (US-65).

RT3 — [backend] Aucune donnée n'est supposée exister chez Digitorn pour un profil jamais activé [À CONFIRMER avec Digitorn : aucun profil n'est créé chez Digitorn avant l'activation].

### UX / Design

Aucun écran dédié.

**Impact maquette :** aucun ajustement nécessaire.

### Critères d'acceptance

**CA 1.1 — Compte jamais activé supprimé**
- Étant donné que le dernier lien d'activation de Camille a été envoyé il y a 31 jours et qu'elle ne l'a jamais utilisé
- Quand le traitement quotidien s'exécute
- Alors son compte est supprimé et disparaît de l'écran « Comptes »

**CA 1.2 — Renvoi du lien**
- Étant donné que le compte de Camille a été créé il y a 40 jours mais que l'administrateur lui a renvoyé un lien il y a 5 jours
- Quand le traitement quotidien s'exécute
- Alors son compte n'est pas supprimé

**CA 2.1 — Invité jamais activé supprimé**
- Étant donné qu'Élodie a reçu son dernier lien d'invitation il y a 31 jours et ne l'a jamais utilisé
- Quand le traitement quotidien s'exécute
- Alors Élodie est supprimée et sa place est libérée dans le quota de Camille

**CA 3.1 — Délai réglable**
- Étant donné que l'administrateur a réglé le délai à 15 jours
- Quand un invité n'a pas activé son accès 16 jours après le dernier lien
- Alors il est supprimé au traitement suivant

**CA 4.1 — Lien expiré sans effet sur le délai**
- Étant donné que le dernier lien d'Élodie a été envoyé il y a 31 jours et a expiré
- Quand le traitement quotidien s'exécute
- Alors Élodie est supprimée, l'expiration du lien n'ayant pas prolongé le délai

**CA 5.1 — Lien après suppression**
- Étant donné qu'Élodie a été supprimée automatiquement
- Quand elle ouvre son ancien lien d'invitation
- Alors le message de lien expiré s'affiche, sans formulaire

**CA 6.1 — Email libéré**
- Étant donné que le compte jamais activé de Camille a été supprimé
- Quand l'administrateur crée un nouveau compte avec le même email
- Alors la création est acceptée

**CA 7.1 — Trace non nominative**
- Étant donné qu'un compte jamais activé a été supprimé
- Quand l'équipe MAAQ consulte le journal des suppressions
- Alors elle voit la date de suppression sans donnée nominative

**CA 8.1 — Échec et nouvel essai**
- Étant donné que la suppression a échoué
- Quand le traitement du lendemain s'exécute
- Alors la suppression est réessayée

---


## US-60 — Être informé que j'échange avec une IA

**En tant qu'** utilisateur ou invité,
**je souhaite** voir en permanence, en haut de chaque tchat d'agent, un message m'indiquant que j'échange avec une IA dont les réponses peuvent contenir des erreurs,
**afin de** rester vigilant sur les réponses et les actions proposées.

**Écran(s) maquette :** Tchat (bandeau « Vous échangez avec une IA. Ses réponses peuvent contenir des erreurs. »). **Dépendances :** US-37.

### Règles fonctionnelles

RF1 — Le bandeau « Vous échangez avec une IA. Ses réponses peuvent contenir des erreurs. » est affiché en haut de chaque tchat d'agent.

RF2 — Le bandeau reste visible pendant le défilement des messages et ne peut pas être fermé.

RF3 — Le bandeau s'affiche pour tous les profils et tous les agents, y compris dans l'état d'accueil (US-41), sur l'écran « À configurer » (US-29) et pendant un blocage (US-42).

RF4 — Le bandeau est affiché même si le chargement du tchat échoue ou dépasse le délai, car il ne dépend pas du serveur (CC-1, CC-2, CC-3).

### Règles techniques

RT1 — [frontend] Le texte du bandeau fait partie de l'application et ne dépend d'aucun échange avec le serveur.

RT2 — [backend] La classification du système au titre de l'AI Act reste à faire. Elle pourrait imposer des mentions supplémentaires.

### UX / Design

D'après la maquette : un bandeau fin de couleur informative, placé juste sous l'en-tête du tchat.

**Impact maquette :** aucun ajustement nécessaire.

### Critères d'acceptance

**CA 1.1 — Bandeau affiché**
- Étant donné que j'ouvre le tchat d'Admin_lib
- Quand il s'affiche
- Alors le bandeau « Vous échangez avec une IA. Ses réponses peuvent contenir des erreurs. » est visible en haut

**CA 2.1 — Visible pendant le défilement**
- Étant donné que le tchat contient de nombreux messages
- Quand je fais défiler vers le haut
- Alors le bandeau reste visible

**CA 2.2 — Impossible à fermer**
- Étant donné que le bandeau est affiché
- Quand je le touche
- Alors il reste affiché

**CA 3.1 — Tous les états du tchat**
- Étant donné qu'Admin_lib est bloqué
- Quand j'ouvre son tchat
- Alors le bandeau IA est visible au-dessus de la bannière de blocage

**CA 4.1 — Bandeau sans serveur**
- Étant donné que le serveur est indisponible
- Quand j'ouvre un tchat
- Alors le bandeau IA est affiché au-dessus du message d'erreur

---

## US-61 — Signaler une réponse ou une action erronée d'un agent

**En tant qu'** utilisateur ou invité,
**je souhaite** signaler, via un bouton présent sur la réponse concernée dans le tchat, une réponse ou une action erronée d'un agent,
**afin qu'** elle soit transmise au support et corrigée.

**Écran(s) maquette :** Tchat (bouton « Signaler une erreur » sous la réponse de l'agent). **Dépendances :** US-38, US-39, US-62.

### Règles fonctionnelles

RF1 — Un bouton « Signaler une erreur » est présent sous chaque réponse de l'agent et sous chaque carte d'action.

RF2 — Le bouton ouvre un formulaire avec :
- une catégorie obligatoire : « Réponse incorrecte », « Action erronée » ou « Autre » ;
- un commentaire facultatif de 1 000 caractères au maximum.

RF3 — Le signalement est transmis au support. Il contient la réponse concernée, la demande qui la précède, le nom de l'agent, le profil, la date et l'heure.

RF4 — Après l'envoi, le message « Merci, votre signalement a été transmis » s'affiche. La réponse porte ensuite la mention « Signalée » et ne peut plus être signalée.

RF5 — Le signalement est conservé par le support, même après l'effacement de l'historique du tchat (US-43, US-44).

RF6 — Pendant l'envoi, le bouton « Envoyer » affiche un indicateur de chargement et est désactivé (CC-1).

RF7 — En cas d'erreur serveur, le message d'erreur standard s'affiche et le formulaire est conservé (CC-2).

RF8 — En cas de délai dépassé, le message de connexion lente s'affiche et le formulaire est conservé (CC-3).

### Règles techniques

RT1 — [backend] Les signalements sont envoyés à la boîte mail du support et conservés dans un registre consultable par l'équipe MAAQ.

RT2 — [backend] Les signalements sont conservés pendant une durée réglée par l'administrateur (14 mois par défaut, US-65) (décision D17 du 01/10/2026).

### UX / Design

D'après la maquette : un lien discret « Signaler une erreur » sous la réponse de l'agent. Le formulaire s'ouvre en panneau depuis le bas de l'écran.

**Impact maquette :** Nouvel écran — Panneau de signalement (catégorie et commentaire) ; Mention « Signalée » sur la réponse.

### Critères d'acceptance

**CA 1.1 — Bouton présent**
- Étant donné qu'Admin_lib m'a répondu
- Quand je regarde sa réponse
- Alors le bouton « Signaler une erreur » est affiché dessous

**CA 2.1 — Catégorie obligatoire**
- Étant donné que le formulaire de signalement est ouvert
- Quand je n'ai pas choisi de catégorie
- Alors le bouton « Envoyer » est inactif

**CA 3.1 — Contenu transmis**
- Étant donné que je signale une réponse d'Admin_lib
- Quand le signalement est envoyé
- Alors le support reçoit la réponse, ma demande, le nom de l'agent, mon profil, la date et l'heure

**CA 4.1 — Confirmation**
- Étant donné que j'ai envoyé un signalement
- Quand l'envoi réussit
- Alors le message « Merci, votre signalement a été transmis » s'affiche et la réponse porte la mention « Signalée »

**CA 4.2 — Pas de double signalement**
- Étant donné qu'une réponse porte la mention « Signalée »
- Quand je la consulte
- Alors le bouton « Signaler une erreur » n'est plus proposé

**CA 5.1 — Conservation après effacement**
- Étant donné que j'ai signalé une réponse
- Quand je me déconnecte
- Alors le support dispose toujours de mon signalement

**CA 6.1 — Chargement**
- Étant donné que je touche « Envoyer »
- Quand l'envoi est en cours
- Alors un indicateur de chargement s'affiche et le bouton est désactivé

**CA 7.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand j'envoie un signalement
- Alors le message d'erreur standard s'affiche et mon commentaire est conservé

**CA 8.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand l'envoi dépasse 15 secondes
- Alors le message de connexion lente s'affiche et mon commentaire est conservé

---

# Module K — Support

## US-62 — Contacter le support par message écrit

**En tant qu'** administrateur, utilisateur principal ou invité,
**je souhaite** envoyer un message écrit décrivant un dysfonctionnement,
**afin qu'** il soit transmis à la boîte mail du support.

**Écran(s) maquette :** Support (utilisateur / invité) ; Support administrateur — onglet « Écrit ». **Dépendances :** US-49, US-63.

### Règles fonctionnelles

RF1 — Le contact support est accessible depuis Réglages > Aide et support. L'onglet « Écrit » est ouvert par défaut.

RF2 — L'utilisateur principal y a également accès, comme le prévoit la maquette (décision du 30/09/2026).

RF3 — Le message est obligatoire. Il doit compter entre 10 et 2 000 caractères, et un compteur indique le nombre de caractères restants.

RF4 — À l'envoi, le message est transmis à la boîte mail du support. Il est accompagné du prénom, de l'email, du rôle du profil, du type d'appareil et de la version de l'application.

RF5 — Après l'envoi, le message « Votre message a été transmis au support » s'affiche, et le champ est vidé. Une copie est envoyée par email au profil.

RF6 — Pendant l'envoi, le bouton « Envoyer » affiche un indicateur de chargement et est désactivé (CC-1).

RF7 — En cas d'erreur serveur, le message d'erreur standard s'affiche et le texte saisi est conservé (CC-2).

RF8 — En cas de délai dépassé, le message de connexion lente s'affiche et le texte saisi est conservé (CC-3).

RF9 — Un message non envoyé est conservé sur l'appareil (CC-8). Il est retrouvé à la réouverture du contact support, même après une fermeture de l'application.

### Règles techniques

RT1 — [backend] L'adresse de la boîte mail du support est un paramètre modifiable sans nouvelle version de l'application, depuis l'écran « Paramètres » de la console (US-65).

### UX / Design

D'après la maquette : deux onglets, « Écrit » et « Dicté », avec une zone de texte et un bouton « Envoyer ». La version administrateur a la même structure, sur ordinateur.

**Impact maquette :** Ajustement — Compteur de caractères ; Message de confirmation d'envoi.

### Critères d'acceptance

**CA 1.1 — Accès au support**
- Étant donné que je suis invité
- Quand j'ouvre Réglages > Aide et support
- Alors le contact support s'affiche avec l'onglet « Écrit » ouvert

**CA 2.1 — Accès pour l'utilisateur principal**
- Étant donné que je suis utilisateur principal
- Quand j'ouvre Réglages > Aide et support
- Alors le contact support est disponible

**CA 3.1 — Message trop court**
- Étant donné que je saisis « Bug »
- Quand je regarde le bouton « Envoyer »
- Alors il est inactif

**CA 3.2 — Compteur**
- Étant donné que j'ai saisi 1 950 caractères
- Quand je regarde le compteur
- Alors il indique 50 caractères restants

**CA 4.1 — Informations jointes**
- Étant donné que j'envoie un message
- Quand le support le reçoit
- Alors il contient mon prénom, mon email, mon rôle, mon type d'appareil et la version de l'application

**CA 5.1 — Confirmation**
- Étant donné que j'ai envoyé un message
- Quand l'envoi réussit
- Alors le message « Votre message a été transmis au support » s'affiche et le champ est vidé
- Et je reçois une copie par email

**CA 6.1 — Chargement**
- Étant donné que je touche « Envoyer »
- Quand l'envoi est en cours
- Alors un indicateur de chargement s'affiche et le bouton est désactivé

**CA 7.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand j'envoie un message
- Alors le message d'erreur standard s'affiche et mon texte est conservé

**CA 8.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand l'envoi dépasse 15 secondes
- Alors le message de connexion lente s'affiche et mon texte est conservé

**CA 9.1 — Brouillon conservé**
- Étant donné que j'ai rédigé un message au support sans l'envoyer
- Quand je ferme puis rouvre MAAQ et retourne sur le contact support
- Alors mon message est toujours saisi

---

## US-63 — Contacter le support par message dicté

**En tant qu'** administrateur, utilisateur principal ou invité,
**je souhaite** dicter oralement un message décrivant un dysfonctionnement plutôt que de l'écrire,
**afin de** signaler un problème plus rapidement.

**Écran(s) maquette :** Support / Support administrateur — onglet « Dicté ». **Dépendances :** US-62.

### Règles fonctionnelles

RF1 — L'onglet « Dicté » propose un bouton « Démarrer l'enregistrement ».

RF2 — À la première utilisation, l'autorisation d'accès au micro est demandée par le téléphone ou le navigateur.

RF3 — Si l'accès au micro est refusé, le message « MAAQ n'a pas accès à votre micro. Autorisez-le dans les réglages de votre téléphone, ou utilisez l'onglet Écrit. » s'affiche.

RF4 — L'enregistrement dure au maximum 2 minutes, avec un compteur visible. Il s'arrête par un bouton « Arrêter » ou automatiquement à 2 minutes.

RF5 — Après l'enregistrement, le message est transcrit en texte. Le profil peut relire et corriger le texte, recommencer l'enregistrement, ou envoyer.

RF6 — Seul le texte transcrit est transmis au support, sans fichier audio (décision du 30/09/2026). Il est accompagné des mêmes informations qu'en US-62.

RF7 — Si le téléphone ou le navigateur ne permet pas l'enregistrement, l'onglet « Dicté » affiche « La dictée n'est pas disponible sur cet appareil » et renvoie vers l'onglet « Écrit ».

RF8 — Pendant l'envoi, une barre de progression s'affiche et le bouton est désactivé (CC-1).

RF9 — En cas d'erreur serveur, le message d'erreur standard s'affiche et l'enregistrement est conservé pour un nouvel essai (CC-2).

RF10 — En cas de délai dépassé, le message de connexion lente s'affiche et l'enregistrement est conservé (CC-3).

RF11 — L'envoi du message dicté se poursuit en arrière-plan si le profil quitte l'écran de support, tant que l'application reste ouverte (CC-10). Une confirmation s'affiche à la fin de l'envoi.

### Règles techniques

RT1 — [frontend] L'enregistrement audio doit fonctionner sur les navigateurs mobiles Android et iPhone ciblés. Il faut vérifier que l'application installée sur iPhone permet d'accéder au micro.

RT2 — [backend] Si une transcription automatique est retenue, le service utilisé doit héberger ses données dans l'Union européenne.

### UX / Design

D'après la maquette : un gros bouton micro centré, avec un compteur de durée pendant l'enregistrement, puis les boutons « Réécouter », « Recommencer » et « Envoyer ».

**Impact maquette :** Ajustement — Message « micro refusé » ; Message « dictée indisponible » ; Texte transcrit modifiable avant l'envoi, « Recommencer », barre de progression d'envoi.

### Critères d'acceptance

**CA 1.1 — Onglet Dicté**
- Étant donné que je suis sur le contact support
- Quand je touche l'onglet « Dicté »
- Alors le bouton « Démarrer l'enregistrement » s'affiche

**CA 2.1 — Autorisation du micro**
- Étant donné que je n'ai jamais utilisé la dictée
- Quand je touche « Démarrer l'enregistrement »
- Alors mon téléphone me demande d'autoriser l'accès au micro

**CA 3.1 — Micro refusé**
- Étant donné que j'ai refusé l'accès au micro
- Quand je touche « Démarrer l'enregistrement »
- Alors le message m'invitant à autoriser le micro ou à utiliser l'onglet Écrit s'affiche

**CA 4.1 — Durée maximale**
- Étant donné que j'enregistre un message
- Quand l'enregistrement atteint 2 minutes
- Alors il s'arrête automatiquement

**CA 5.1 — Réécoute et nouvel essai**
- Étant donné que j'ai terminé un enregistrement
- Quand je touche « Recommencer »
- Alors l'enregistrement précédent est supprimé et je peux en faire un nouveau

**CA 6.1 — Envoi**
- Étant donné que j'ai terminé un enregistrement
- Quand je touche « Envoyer »
- Alors le message dicté est transmis au support avec mes informations de profil et d'appareil

**CA 7.1 — Dictée indisponible**
- Étant donné que mon appareil ne permet pas l'enregistrement
- Quand j'ouvre l'onglet « Dicté »
- Alors le message « La dictée n'est pas disponible sur cet appareil » s'affiche avec un lien vers l'onglet « Écrit »

**CA 8.1 — Chargement**
- Étant donné que je touche « Envoyer »
- Quand l'envoi est en cours
- Alors une barre de progression s'affiche et le bouton est désactivé

**CA 9.1 — Erreur serveur**
- Étant donné que le serveur est indisponible
- Quand j'envoie mon message dicté
- Alors le message d'erreur standard s'affiche et mon enregistrement est conservé

**CA 10.1 — Délai dépassé**
- Étant donné que le réseau est lent
- Quand l'envoi dépasse 15 secondes
- Alors le message de connexion lente s'affiche et mon enregistrement est conservé

**CA 11.1 — Envoi en arrière-plan**
- Étant donné que l'envoi de mon message dicté est en cours
- Quand je retourne sur mon dashboard
- Alors l'envoi se poursuit et une confirmation s'affiche à la fin

---

# 5. Récapitulatif et points ouverts

### Tableau 1 — Récapitulatif des US

| Référence | Titre | RF | RT | CA | Points ouverts |
|-----------|-------|----|----|-----|----------------|
| US-1 | Être guidé pour installer MAAQ sur l'écran d'accueil | 8 | 3 | 11 | — |
| US-2 | Accéder à l'application depuis l'écran d'accueil | 9 | 3 | 10 | — |
| US-3 | Se connecter à MAAQ | 14 | 4 | 17 | — |
| US-4 | Activer son accès en tant qu'invité | 15 | 4 | 18 | — |
| US-5 | Renvoyer un nouveau lien d'invitation expiré | 11 | 2 | 11 | — |
| US-6 | Se reconnecter rapidement via un schéma tactile | 15 | 3 | 17 | — |
| US-7 | Être verrouillé après plusieurs échecs du schéma tactile | 9 | 2 | 9 | — |
| US-8 | Récupérer l'accès après un oubli du schéma tactile | 12 | 3 | 14 | 1 |
| US-9 | Se déconnecter de l'application | 9 | 2 | 9 | — |
| US-66 | Réinitialiser mon mot de passe oublié | 15 | 4 | 20 | — |
| US-10 | Renseigner les informations nécessaires aux agents | 13 | 2 | 18 | 1 |
| US-11 | Renseigner les informations concernant son invité | 12 | 2 | 13 | — |
| US-12 | Modifier mes informations de configuration | 11 | 2 | 12 | — |
| US-13 | Renseigner l'adresse email de connexion d'un agent | 13 | 3 | 13 | — |
| US-14 | Autoriser les permissions nécessaires à un agent | 11 | 3 | 11 | 1 |
| US-15 | Configurer la boîte mail de validation d'un agent | 10 | 2 | 10 | — |
| US-16 | Définir les adresses en copie systématique d'un agent | 13 | 3 | 18 | — |
| US-17 | Ajouter mes propres adresses en copie d'un agent | 11 | 2 | 14 | — |
| US-67 | Connecter le Google Drive du compte | 12 | 4 | 15 | 1 |
| US-18 | Ajouter un invité | 13 | 2 | 17 | — |
| US-19 | Modifier les informations d'un invité | 9 | 1 | 9 | — |
| US-20 | Supprimer un invité | 11 | 2 | 14 | — |
| US-21 | Consulter le nombre d'invités disponibles | 9 | 1 | 10 | — |
| US-22 | Consulter mon dashboard par onglet (Pro / Perso) | 10 | 2 | 10 | — |
| US-23 | Parcourir le catalogue d'agents par rubrique | 11 | 1 | 11 | — |
| US-24 | Consulter la fiche descriptive d'un agent | 8 | 1 | 9 | — |
| US-25 | Rechercher un agent par mot-clé | 9 | 1 | 10 | — |
| US-26 | Ajouter un agent à mon dashboard | 9 | 2 | 10 | — |
| US-27 | Être informé de la limite de 10 agents par rubrique | 7 | 1 | 8 | — |
| US-28 | Retirer un agent de mon dashboard | 9 | 1 | 10 | — |
| US-29 | Être informé qu'un agent n'est pas encore configuré | 9 | 1 | 10 | — |
| US-30 | Accéder à la page Contrats | 6 | 1 | 7 | — |
| US-31 | Consulter les agents des Contrats | 7 | 1 | 8 | — |
| US-32 | Consulter la liste de mes contrats | 11 | 2 | 13 | — |
| US-33 | Renseigner les détails d'un contrat | 10 | 2 | 11 | — |
| US-34 | Ajouter les documents scannés d'un contrat | 14 | 3 | 18 | 1 |
| US-35 | Modifier ou supprimer les détails et documents d'un contrat | 8 | 2 | 9 | — |
| US-36 | Donner ou retirer mon consentement au challenge d'un contrat | 10 | 2 | 12 | 2 |
| US-37 | Accéder rapidement au tchat d'un agent | 8 | 2 | 8 | — |
| US-38 | Demander à un agent de réaliser une action | 15 | 3 | 20 | 1 |
| US-39 | Valider une action proposée par l'agent | 14 | 2 | 14 | — |
| US-40 | Consulter le carnet de bord d'un agent | 13 | 6 | 18 | — |
| US-41 | Découvrir le tchat d'un agent sans historique | 9 | 1 | 9 | — |
| US-42 | Être informé d'un accès agent bloqué | 10 | 2 | 10 | — |
| US-70 | Être limité à un nombre de demandes par jour | 9 | 3 | 13 | 1 |
| US-43 | Perte de l'historique du tchat à la déconnexion | 9 | 2 | 10 | — |
| US-44 | Expiration automatique des conversations anciennes | 7 | 2 | 8 | — |
| US-45 | Mettre à disposition un agent IA | 10 | 2 | 16 | — |
| US-46 | Bloquer l'accès à un agent | 8 | 2 | 9 | — |
| US-47 | Réactiver l'accès à un agent | 6 | 1 | 6 | — |
| US-48 | Définir la liste des contrats obligatoires | 10 | 2 | 11 | — |
| US-64 | Créer le compte d'un utilisateur principal | 9 | 2 | 9 | 3 |
| US-65 | Paramétrer les délais et les limites de la plateforme | 8 | 1 | 10 | 2 |
| US-69 | Modifier le plafond quotidien de demandes d'un compte | 7 | 2 | 9 | 1 |
| US-49 | Accéder aux Réglages | 8 | 1 | 8 | 1 |
| US-50 | Accéder aux carnets de bord depuis les Réglages | 8 | 1 | 8 | — |
| US-51 | Vérifier mon identité sur un nouvel appareil | 12 | 4 | 15 | — |
| US-52 | Verrouiller automatiquement l'application après inactivité | 11 | 2 | 11 | — |
| US-53 | Révoquer l'accès d'un appareil | 10 | 2 | 10 | — |
| US-54 | Consulter la politique de confidentialité et les conditions d'utilisation | 8 | 2 | 9 | — |
| US-55 | Exporter mes données | 10 | 2 | 10 | — |
| US-56 | Supprimer mes données et mon compte | 11 | 2 | 12 | — |
| US-57 | Anonymiser les demandes d'un invité supprimé dans le carnet partagé | 7 | 2 | 7 | — |
| US-58 | Supprimer automatiquement un compte après désabonnement | 7 | 3 | 7 | 1 |
| US-59 | Reprendre mon compte pendant le délai de grâce | 9 | 1 | 10 | — |
| US-68 | Supprimer automatiquement les comptes et invités jamais activés | 8 | 3 | 9 | 1 |
| US-60 | Être informé que j'échange avec une IA | 4 | 2 | 5 | — |
| US-61 | Signaler une réponse ou une action erronée d'un agent | 8 | 2 | 9 | — |
| US-62 | Contacter le support par message écrit | 9 | 1 | 10 | — |
| US-63 | Contacter le support par message dicté | 11 | 2 | 11 | — |
| **Total** | **70 US** | **696** | **149** | **797** | **18** |

### Tableau 2a — Décisions prioritaires

Ces points conditionnent plusieurs US. Ils sont à trancher en premier.

| # | Décision à prendre | US concernées | Interlocuteur cible |
|---|---|---|---|
| 1 | Nom du partenaire cité dans le texte de consentement (à venir) | US-36 | PM |
| 2 | Sauvegardes conservées 2 ans après suppression : à valider et à mentionner dans la politique de confidentialité | US-58 | DPO |
| 3 | Valeur probante d'une preuve de consentement par empreinte de l'email | US-36 | DPO |

### Tableau 2 — Points à confirmer (liste complète)

Les points confirmés dans le document de validation du 30/09/2026 ont été retirés. Restent les points non tranchés et ceux ouverts par les nouvelles décisions.

| Tag | US concernée | Question | Interlocuteur cible |
|-----|-------------|----------|---------------------|
| [À CONFIRMER] | US-8 (RT2) | Le message affiché ne permet pas de savoir si un email correspond à un compte existant, pour empêcher la découverte des comptes. | backend |
| [À CONFIRMER] | US-10 (RT2) | format d'échange par agent — Les informations sont transmises à Digitorn sous forme chiffrée, puis déchiffrées côté Digitorn. Elles sont mises à jour à chaque ouverture de session (décision du 29/09/2026). Le format d'échange reste à formaliser avec Digitorn. Seules les informations de l'agent concerné sont transmises avec la demande adressée à cet agent. | Digitorn |
| [À CONFIRMER] | US-14 (RT3) | Seules les permissions strictement nécessaires à chaque agent sont demandées. | Digitorn |
| [À CONFIRMER] | US-67 (RF5) | mode de remontée du résultat du widget vers MAAQ — La connexion se fait de deux façons possibles : depuis l'agent dans MAAQ, avec le même parcours que US-13 et US-14 (saisie de l'adresse du compte Google, panneau des permissions, page de consentement Google) ; ou directement par un widget Digitorn. Dans les deux cas, MAAQ reçoit le résultat (autorisé, refusé ou partiel) et affiche le même statut. | Digitorn |
| [À CONFIRMER] | US-34 (RT1) | Les documents sont stockés dans le Google Drive du compte (US-67), établi par l'utilisateur principal, où ils sont classés par un agent (décision du 30/09/2026). Admin_Classify utilise la connexion Google Drive de l'utilisateur principal, y compris pour les documents ajoutés par l'invité 1 (décision du 30/09/2026). L'arborescence de classement est celle de l'agent. | Digitorn |
| [À CONFIRMER] | US-36 (RF2) | nom du partenaire, à venir — L'activation ouvre une confirmation. Elle affiche le texte « L'entreprise [nom du partenaire], partenaire de MAAQ, pourra utiliser les informations de votre contrat pour le challenger. » et propose « J'accepte » et « Annuler ». La désactivation est immédiate, sans confirmation (décision du 30/09/2026). | PM |
| [À CONFIRMER] | US-36 (RT1) | valeur probante d'une preuve par empreinte — Chaque activation et chaque désactivation est enregistrée comme preuve du consentement, avec le profil, la date, l'heure et la version du texte accepté. Le journal conserve aussi une empreinte de l'email du consentant, pour établir son identité après la suppression du compte, sans conserver l'email en clair (décision D13 du 01/10/2026). Proposition du BA : l'enregistrement est fait dans un journal des consentements de la base MAAQ, hébergée dans l'Union européenne, distinct du Google Drive de l'utilisateur. Il est conservé pendant toute la durée du compte, puis 5 ans après la fin de l'abonnement, durée de prescription permettant de prouver le consentement (proposition validée par le PM le 30/09/2026). | DPO |
| [À CONFIRMER] | US-38 (RF11) | Si l'agent n'a pas répondu après 30 secondes, le message « [Agent] met plus de temps que prévu… » remplace l'indicateur. Si aucune réponse n'arrive après 2 minutes, le message « L'agent n'a pas pu répondre. Réessayez. » s'affiche avec un bouton « Réessayer » (CC-3). | Digitorn |
| [À CONFIRMER] | US-70 (UX) | Un message dans le fil du tchat, ou une bannière au-dessus de la zone de saisie. La zone de saisie reste visible avec le texte conservé. | UX |
| [À CONFIRMER] | US-64 (RT1) | Chaque création de compte est enregistrée dans le journal d'administration. | backend |
| [À CONFIRMER] | US-64 (RT2) | Le lien d'activation contient un jeton unique, impossible à deviner, valable une seule fois. | backend |
| [À CONFIRMER] | US-64 (UX) | Écran à concevoir dans la console d'administration : liste des comptes, formulaire de création et fiche d'un compte avec le bouton « Renvoyer le lien d'activation ». | UX |
| [À CONFIRMER] | US-65 (RT1) | Les paramètres sont lus par les traitements automatiques à chaque exécution. | backend |
| [À CONFIRMER] | US-65 (UX) | Écran à concevoir dans la console d'administration : un formulaire simple avec un bouton « Enregistrer », et l'historique des modifications en dessous. | UX |
| [À CONFIRMER] | US-69 (UX) | Écran à concevoir dans la console d'administration : fiche d'un compte avec le plafond quotidien, le bouton « Enregistrer » et, par exemple, le bouton « Renvoyer le lien d'activation » déjà prévu en US-64. | UX |
| [À CONFIRMER] | US-49 (RF2) | Les Réglages de l'utilisateur principal comprennent, dans cet ordre  : | UX |
| [À CONFIRMER] | US-58 (RT3) | Les copies de sauvegarde sont purgées au bout de 2 ans (décision du 30/09/2026). Point d'attention du BA : pendant ce délai, des données supprimées restent présentes dans les sauvegardes. Ce délai doit figurer dans la politique de confidentialité et être validé par le DPO. | DPO |
| [À CONFIRMER] | US-68 (RT3) | aucun profil n'est créé chez Digitorn avant l'activation — Aucune donnée n'est supposée exister chez Digitorn pour un profil jamais activé. | Digitorn |

**Ces points doivent être confirmés avant de considérer les US comme finalisées.**

---

# 6. Maquettes à créer ou à ajuster

### Éléments transverses

| Réf. | Élément | Contenu | US |
|---|---|---|---|
| MT-1 | Bibliothèque des états communs | Créer les composants réutilisables : cartes d'attente (squelettes), indicateur de chargement sur bouton, message « Toujours en cours… » (CC-6), message d'erreur standard avec « Réessayer » (CC-2), message de connexion lente avec « Réessayer » (CC-3), bandeau « Pas de connexion internet » (CC-4). Les montrer sur trois écrans types : dashboard, tchat et formulaire. | Toutes |
| MT-2 | Écran de démarrage et écran hors connexion | Écran de démarrage MAAQ, et écran plein « MAAQ nécessite une connexion internet » avec « Réessayer », au lancement sans réseau. | US-2 |
| MT-3 | États d'un message dans le tchat | « Envoi… », « Envoyé », « En attente de connexion », « Non envoyé » + « Réessayer », « [Agent] réfléchit… », « [Agent] met plus de temps que prévu… », « L'agent n'a pas pu répondre » + « Réessayer ». | US-38 |
| MT-4 | États d'une carte d'action à valider | « Validation requise », « Exécution en cours… », « Validée — exécutée », « Refusée », « L'action n'a pas pu être exécutée » + « Réessayer », « Exécution plus longue que prévu », boutons désactivés en cas de blocage. | US-39, US-42 |
| MT-5 | Fenêtres de confirmation standard | Modèle unique de fenêtre de confirmation (titre, conséquences, bouton d'action, « Annuler »), avec une variante « action destructrice » en rouge. | US-9, US-20, US-28, US-35, US-47, US-53, US-56 |
| MT-6 | Messages temporaires (toasts) | Confirmations courtes en bas d'écran : « Agent ajouté », « Informations mises à jour », « Document ajouté à… », « Nouveau lien envoyé », etc. | US-12, US-26, US-34, US-5 |

### Par user story

| US | Impact | Éléments à créer ou à ajuster |
|---|---|---|
| US-1 | Ajustement | Bouton « Plus tard » ; Message « Ouvrez MAAQ dans Safari » pour un navigateur non compatible sur iPhone |
| US-2 | Nouvel écran | Écran de démarrage et écran hors connexion (voir MT-2) |
| US-3 | Ajustement | Le lien « Mot de passe oublié ? » ouvre le parcours de réinitialisation par code (US-66) ; Message de blocage après 5 échecs, avec l'heure de nouvel essai ; Lien « Mot de passe oublié ? » ; Onglet « Schéma tactile » inactif sans schéma ; États de chargement et d'erreur du bouton « Se connecter » |
| US-4 | Nouvel écran | Écran « Lien expiré » ; Écran « Accès déjà activé » ; Étapes « mot de passe » et « schéma » du parcours d'activation, avec l'indicateur de progression |
| US-5 | Ajustement | Statuts « Envoi en cours » et « Échec d'envoi » ; Message de limite de renvois ; Retirer le bouton de démonstration « Simuler l'expiration » |
| US-6 | Nouvel écran | Écran de création du schéma (deux tracés, messages d'erreur) ; Compteur de tentatives restantes ; Lien « Utiliser mon mot de passe » |
| US-7 | Ajustement | État d'erreur serveur sur l'écran verrouillé |
| US-8 | Ajustement | Préciser que l'écran concerne le schéma tactile, et non le mot de passe ; Remplacer le lien par un écran de saisie de code à 6 chiffres (si validé) ; Création du nouveau schéma ; Code incorrect, code expiré, « Recevoir un nouveau code » avec délai de 60 secondes |
| US-9 | Ajustement | Fenêtre de confirmation avec avertissement sur l'historique (voir MT-5) |
| US-66 | Nouvel écran | Écran « Nouveau mot de passe » (double saisie) ; Proposition de créer un nouveau schéma après la réinitialisation ; Écran de saisie de l'email et du code (sur la base de l'écran Récupération d'accès) |
| US-10 | Ajustement | Valeurs pré-remplies dans le formulaire d'un agent, avec un libellé indiquant leur provenance ; Réglages > Mes informations regroupées par agent ; Champ de type liste avec « Ajouter un élément » et message de limite ; Étape « Mes informations » réduite au prénom, au nom et à l'email de connexion ; Nouveau formulaire « Informations nécessaires à [agent] » ouvert après l'ajout d'un agent ; Signalement d'une information manquante dans Réglages > Mes informations ; Message « Terminez votre configuration » à l'ouverture d'un tchat avant la fin du parcours ; Erreurs de format sous les champs |
| US-11 | Ajustement | Lien « Passer cette étape » ; Fiches « Informations de mes invités » pour les invités secondaires dans les Réglages |
| US-12 | Ajustement | Sections « Mes informations » et « Informations de mes invités » présentées par agent ; Mode édition des sections avec « Enregistrer » et « Annuler » ; Confirmation « Abandonner vos modifications ? » |
| US-13 | Ajustement | Ligne « Google Drive du compte » en lecture seule pour les invités ; Statuts des connecteurs (Non configuré, Autorisation en attente, Connecté, À reconnecter) ; Bouton « Déconnecter » ; Proposition d'une adresse déjà connectée |
| US-14 | Ajustement | États « Autorisation refusée », « Autorisation partielle », « À reconnecter » ; Écran « Finalisation de la connexion… » ; Bouton « Reprendre la connexion » |
| US-15 | Ajustement | Mention indiquant que la validation se fait dans le tchat ; Vérification de l'adresse par code ; Statuts « Non configurée », « À vérifier », « Active » |
| US-16 | Ajustement | Section affichée seulement si l'administrateur l'a prévue pour l'agent ; message de limite avec le nombre propre à l'agent ; Ligne « Participant automatique » en lecture seule (invité 1) ; Message de limite de 10 adresses |
| US-17 | Ajustement | Nouvelle section « Participants automatiques » selon le rang de l'invité ; Suppression de la section « Adresses en copie de Camille » |
| US-67 | Ajustement | Ligne « Google Drive du compte » dans l'écran Connecteurs, partagée entre agents, avec ses statuts ; Bandeau de la page Contrats ouvrant ce parcours |
| US-18 | Ajustement | Rang de l'invité sur sa fiche (Invité 1 / Invité secondaire) ; Statuts « Envoi en cours » et « Échec d'envoi » |
| US-19 | Aucun | — |
| US-20 | Ajustement | Bouton « Désigner comme invité 1 » sur la fiche d'un invité quand le compte n'a pas d'invité 1 ; Case « Désigner comme invité 1 » dans le formulaire d'ajout ; Liste des conséquences dans la confirmation de suppression |
| US-21 | Ajustement | États de chargement et d'erreur du bandeau de quota |
| US-22 | Ajustement | Retrait du badge « Nouvelle réponse » ; Cartes d'attente et état vide avec « Parcourir le catalogue » ; Compteur « N/10 agents » |
| US-23 | Ajustement | Catalogue d'un invité secondaire sans la rubrique « Agents des Contrats » ; Badge « En maintenance » ; Rubrique vide |
| US-24 | Ajustement | Bandeau « Cet agent est temporairement en maintenance » ; Retirer le bouton de démonstration « Limite atteinte » |
| US-25 | Ajustement | État « Aucun résultat » avec lien « Parcourir les rubriques » |
| US-26 | Ajustement | Message de confirmation avec lien « Configurer maintenant » |
| US-27 | Aucun | — |
| US-28 | Aucun | — |
| US-29 | Ajustement | Variante « Google Drive du compte à connecter par [prénom] » ; Variante sur un agent Pro ou Perso du dashboard ; Variante « élément relevant de l'utilisateur principal », sans action possible |
| US-30 | Ajustement | Navigation d'un invité secondaire sans entrée « Contrats » |
| US-31 | Ajustement | État vide de l'onglet « Agents des Contrats » |
| US-32 | Ajustement | Bandeau « Google Drive non connecté », avec le bouton « Connecter mon Google Drive » pour l'utilisateur principal ; Mention « Modifié par [prénom] le [date] » ; État « Non renseigné » / « Renseigné — N document(s) » |
| US-33 | Ajustement | Champs dynamiques définis par l'administrateur pour chaque contrat ; Erreurs de format |
| US-34 | Ajustement | Messages de taille et de nombre maximum avec les valeurs en vigueur ; Pastilles d'état des documents : « Classement en cours », « Document disponible », « Classement impossible » avec « Réessayer » ; Choix « Prendre une photo » / « Choisir un fichier » ; Barre de progression avec « Annuler » ; Messages d'erreur de format, de taille et d'envoi ; Message de fin d'envoi en arrière-plan |
| US-35 | Ajustement | Action « Retirer » sur chaque document ; Mention « Le document restera dans le Google Drive de [prénom] » dans les confirmations |
| US-36 | Nouvel écran | Fenêtre de consentement avec le texte validé (« L'entreprise [nom du partenaire], partenaire de MAAQ, pourra utiliser les informations de votre contrat pour le challenger. ») ; Mention « Activé par [prénom] le [date] » |
| US-37 | Ajustement | Raccourci vers les connecteurs dans l'en-tête du tchat |
| US-38 | Ajustement | Retrait du badge « Nouvelle réponse » ; États des messages (voir MT-3) ; Compteur de caractères |
| US-39 | Ajustement | États de la carte d'action (voir MT-4) ; Variante de carte pour valider l'envoi d'un email, avec l'objet, le destinataire et un aperçu du brouillon |
| US-40 | Ajustement | Sélecteur d'agent en liste déroulante avec saisie pour filtrer ; Mention « Dernière mise à jour » ; Bouton « Voir plus » ; Entrées anonymisées ; État vide |
| US-41 | Ajustement | Variante sans suggestions avec « Recharger les suggestions » ; Retirer le bouton de démonstration « Historique » |
| US-42 | Ajustement | Boutons de validation désactivés pendant le blocage ; Retirer le bouton de démonstration « Bloquer / Débloquer » |
| US-70 | Ajustement | Message « plafond de demandes atteint » dans le tchat, texte saisi conservé ; Avertissement discret « Il vous reste [N] demandes aujourd'hui » au-dessus de la zone de saisie, à partir de 5 demandes restantes |
| US-43 | Aucun | — |
| US-44 | Aucun | — |
| US-45 | Ajustement | Éditeur de champs d'information (libellé, type, obligatoire, nombre maximal d'éléments, clé commune) ; Choix de la portée de chaque connecteur (chaque profil, utilisateur principal, compte) ; Champ « Nombre maximal d'adresses en copie » ; Formulaire complet de mise à disposition : description, exemples, suggestions, connecteurs requis, actions à valider ; Définition des informations à demander à l'utilisateur et des éléments de configuration requis |
| US-46 | Aucun | — |
| US-47 | Ajustement | Fenêtre de confirmation de réactivation |
| US-48 | Ajustement | Écran de définition des champs d'un contrat (libellé, type, obligatoire) ; Actions « Renommer », « Déplacer », « Retirer » ; Avertissement indiquant le nombre de comptes concernés |
| US-64 | Nouvel écran | Champ « Plafond quotidien de demandes » (50 par défaut) dans le formulaire de création ; Écran « Comptes » de la console : liste, formulaire de création, fiche avec « Renvoyer le lien d'activation » ; Écran d'activation du compte de l'utilisateur principal |
| US-65 | Nouvel écran | Huit réglages supplémentaires (durées de conservation, taille et nombre de documents, délai de suppression des comptes jamais activés, nombre maximal d'agents par rubrique, adresse du support) ; Écran « Paramètres » de la console, avec l'historique des modifications |
| US-69 | Nouvel écran | Fiche d'un compte dans la console : plafond quotidien de demandes modifiable, nombre d'invités autorisé en lecture seule, « Renvoyer le lien d'activation » |
| US-49 | Ajustement | Liste complète des rubriques par profil, dans l'ordre retenu ; Libellé « Désabonnement et suppression du compte » pour l'utilisateur principal |
| US-50 | Ajustement | État « Aucun carnet disponible » |
| US-51 | Ajustement | Onglet SMS masqué sans numéro ; Code incorrect, code expiré, délai avant renvoi |
| US-52 | Nouvel écran | Écran verrouillé de l'administrateur (déverrouillage par mot de passe) |
| US-53 | Nouvel écran | Écran administrateur de recherche d'un compte et de révocation de ses appareils |
| US-54 | Nouvel écran | Fenêtre d'acceptation d'une nouvelle version des documents à la connexion ; Lien « Confidentialité » sur l'écran de connexion |
| US-55 | Ajustement | Fenêtre de confirmation décrivant le contenu de l'export ; État « Export en cours de préparation » |
| US-56 | Ajustement | Mention « délai de grâce de 30 jours » ; Écran d'explication des conséquences, avec saisie du mot de passe ; Libellé « Désabonnement et suppression du compte » pour l'utilisateur principal |
| US-57 | Ajustement | Pastille neutre « Invité supprimé » dans le carnet |
| US-58 | Aucun | — |
| US-59 | Nouvel écran | Écran de reprise du compte pendant le délai de grâce, pour l'utilisateur principal et pour l'invité |
| US-68 | Aucun | — |
| US-60 | Aucun | — |
| US-61 | Nouvel écran | Panneau de signalement (catégorie et commentaire) ; Mention « Signalée » sur la réponse |
| US-62 | Ajustement | Compteur de caractères ; Message de confirmation d'envoi |
| US-63 | Ajustement | Message « micro refusé » ; Message « dictée indisponible » ; Texte transcrit modifiable avant l'envoi, « Recommencer », barre de progression d'envoi |

---

# 7. Comportements résilients ajoutés

| Réf. | US | Comportement |
|---|---|---|
| CC-5 | Toutes | Nouvelles tentatives automatiques silencieuses (2 essais) avant d'afficher une erreur de chargement. |
| CC-6 | Toutes | Message « Toujours en cours… » après 5 secondes d'attente. |
| CC-7 | Toutes | Aucune action n'est exécutée deux fois (double toucher, bouton « Réessayer »). |
| CC-8 | Toutes | Le texte saisi et non envoyé est conservé sur l'appareil jusqu'à son envoi ou son abandon, et effacé à la déconnexion. |
| CC-9 | Toutes | L'écran se recharge automatiquement au retour de la connexion. |
| CC-10 | Toutes | Les traitements longs se font en arrière-plan : l'utilisateur peut quitter l'écran et retrouve le résultat à son retour. |
| US-38 RF13 | US-38 | Traitement asynchrone d'une demande : la réponse est retrouvée au retour dans le tchat. |
| US-70 RF2 | US-70 | Un message renvoyé après une erreur n'est compté qu'une fois dans le plafond quotidien (CC-7). |
| US-38 RF14 | US-38 | Message envoyé hors connexion mis en attente, puis envoyé automatiquement au retour de la connexion (10 minutes au maximum). |
| US-39 RF14 | US-39 | Exécution asynchrone d'une action validée, dont le résultat est retrouvé au retour. |
| US-34 RF10 | US-34 | Envoi de document en arrière-plan quand on quitte l'écran. |
| US-34 RF11 | US-34 | Reprise automatique de l'envoi après une micro-coupure (3 essais). |
| US-18 RF12 | US-18 | Envoi asynchrone de l'invitation, avec 3 nouvelles tentatives automatiques. |
| US-14 RF11 | US-14 | Reprise d'un parcours d'autorisation Google interrompu. |
| US-62 RF9 | US-62 | Brouillon du message au support conservé après la fermeture de l'application. |
| US-63 RF11 | US-63 | Envoi du message dicté en arrière-plan. |
| Déjà prévus | US-40, US-43, US-44, US-55, US-56, US-57, US-58 | Synchronisation du carnet, effacements, export, suppressions et anonymisation : traitements asynchrones avec nouvelles tentatives automatiques, déjà décrits dans les US. |
