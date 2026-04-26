FROM node:18-slim

# Installer les dépendances système nécessaires pour Chromium
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    xdg-utils \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Créer le répertoire de l'application
WORKDIR /app

# Copier les fichiers package.json
COPY package*.json ./

# Installer les dépendances Node.js
RUN npm install

# Installer Puppeteer avec Chromium
RUN npx puppeteer browsers install chrome

# Copier le code source
COPY . .

# Créer les répertoires pour les données
RUN mkdir -p /app/user_data

# Exposer le port
EXPOSE 3000

# Démarrer l'application
CMD ["node", "server.js"]
