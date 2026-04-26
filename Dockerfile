FROM node:18-slim

# Installation des dépendances Chromium
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
    procps \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copier et installer les dépendances
COPY package*.json ./
RUN npm install --production

# Installer Chromium pour Puppeteer
RUN npx puppeteer browsers install chrome

# Copier le code
COPY . .

# Créer les dossiers requis
RUN mkdir -p /app/user_data

EXPOSE 3000

CMD ["node", "server.js"]
