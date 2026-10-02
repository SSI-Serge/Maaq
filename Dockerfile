# Image de MAAQ pour Google Cloud Run (zone de test ou production).
# Glibc (et non Alpine) : le module de hachage des mots de passe est natif et livré pour Linux standard.

# --- Étape 1 : construction ---
FROM node:22-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Variables factices : le build ne se connecte à rien, l'application lit les vraies au démarrage.
RUN npm run build

# --- Étape 2 : image finale, légère ---
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080
ENV HOSTNAME=0.0.0.0
# Cloud Run ne garde pas le disque : les fichiers locaux (boîte de test, faux Drive, exports) vont dans /tmp.
ENV MAAQ_DATA_DIR=/tmp/maaq-data
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
USER node
EXPOSE 8080
CMD ["node", "server.js"]
