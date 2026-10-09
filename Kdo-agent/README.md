# Kdo-agent

Tout ce qui documente et évalue l'agent **kdo_help** (idées de cadeaux, proches, occasions, rappels, WhatsApp). Le code, lui, vit dans l'application (`src/server/agents/`, `src/server/gifts/`, `src/server/channels/`, `src/server/adapters/whatsapp/`), là où Next.js l'attend.

| Fichier | Pour qui | Contenu |
|---|---|---|
| [GUIDE-DEMARRAGE.md](GUIDE-DEMARRAGE.md) | Propriétaire du compte, sans compétence technique | Installer, démarrer, où mettre les clés, lesquelles sont nécessaires, dépannage |
| [agents-locaux.md](agents-locaux.md) | Développeur, PM | Comment un agent tourne dans MAAQ en attendant Digitorn ; ce que fait kdo_help |
| [whatsapp.md](whatsapp.md) | Développeur, PM, DPO | Canal WhatsApp : liaison, consentement, fenêtre de 24 h, rappels, mise en service chez Meta, écarts avec la spécification |
| [evals/golden.json](evals/golden.json) | Développeur | Cas qualitatifs à noter à la main (`npm run eval:kdo-help`) |
| [evals/utterances.json](evals/utterances.json) | Développeur | Phrases étiquetées intention → outil (`npm run eval:kdo-help -- --intents`) |
