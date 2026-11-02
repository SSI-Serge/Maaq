# Vidéo de présentation « Découvrir MAAQ » (US-140)

## Parcours

- L'écran `/decouvrir` est proposé **une fois par profil** (parent, premier invité, invité secondaire ; jamais l'administrateur), après le schéma tactile et l'acceptation des conditions, avant la configuration initiale d'un parent ou l'accueil d'un invité. Ordre dans `homeFor` (`src/server/auth/service.ts`) : reprise de compte → schéma → console (administrateur) → **Découvrir** → configuration → accueil ; les conditions (`/conditions`) passent avant tout (route d'état).
- Le guidage d'installation (US-1) reste avant : sur un téléphone, il s'ouvre à l'arrivée sur `/decouvrir` comme sur tout écran de l'espace connecté, puis renvoie sur la vidéo.
- « Passer », la fin de la vidéo et « Continuer » (après un échec de chargement) appellent `POST /api/presentation/seen` : `users.presentation_seen_at` reçoit la date, une seule fois, jamais écrasée. C'est la seule donnée de lecture conservée (aucune durée, aucun compteur, aucun tiers, aucun cookie). Elle entre dans l'export du profil (`presentationVueLe`).
- Sans vidéo configurée, l'écran n'est jamais proposé (`presentationDue` faux) ; si le stockage est illisible, l'application continue sans l'écran.
- Accès permanent : Réglages › Aide › « Revoir la présentation » (`/reglages/presentation`), sans marquer « vu ».

## Fichiers servis

- Stockage : bucket dédié (variable `PRESENTATION_BUCKET`, zone de test : `maaq-test-media`, europe-west1, accès public interdit, compte de service de l'application) ; sans variable, dossier local `.data/presentation-media`. Une description `presentation/manifest.json` dit ce qui est configuré ; aucune table.
- Le serveur de MAAQ sert lui-même la vidéo (`/api/presentation/video`, plages d'octets `Range` / 206 pour l'iPhone), les sous-titres WebVTT et l'image d'aperçu : adresses versionnées, cache privé.
- Limites : MP4 de 15 Mo au plus (H.264, 720p), sous-titres 200 Ko, image 1 Mo, durée affichée 30 caractères, texte 8 000 caractères. Un premier dépôt demande la vidéo ET les sous-titres français.

## Console (RF9)

`/admin/presentation` : déposer ou remplacer chaque élément (vidéo, sous-titres, image, durée, texte), retirer la vidéo ; sans livraison de l'application. Chaque dépôt ou retrait est journalisé (`presentation_updated`, éléments touchés, jamais le contenu).

## Base de données (lot 12)

`db/migrations/0017_lot12_valeurs_enumerees.sql` (`33b345ce…`) puis `0018_lot12_schema.sql` (`e02b6dee…`) : copies à l'identique des fichiers d'origine de la base de données (`lot_12_1`, `lot_12_2`). Additifs : mêmes fichiers pour une base neuve et pour la zone de test. À appliquer sur une base existante après sauvegarde et contrôle des empreintes, **avant** de déployer le code. La date est vide pour les profils existants : ils verront l'écran une fois.

## Zone de test

Un clip de démonstration (12 s, « Vidéo de démonstration — à remplacer », sans donnée personnelle) y est déposé ; le remplacer dans la console.
